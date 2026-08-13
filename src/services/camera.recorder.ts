import { type Env } from "@/config/env";
import { OutputPattern, RecordingStatus } from "@/types";
import { buildOutputPattern } from "@/utils/helpers";
import { type Logger } from "pino";
import { PushNotificationDingV2, type RingCamera } from "ring-client-api";
import {
  FfmpegOptions,
  type StreamingSession,
} from "ring-client-api/streaming/streaming-session";
import { type Observable, type Subscription } from "rxjs";
import { distinctUntilChanged, filter, map, skip, tap } from "rxjs/operators";

/**
 * Controls motion-triggered video recording for a single Ring camera.
 *
 * Uses `streamVideo()` from `ring-client-api` to obtain the RTSP URL,
 * then delegates all encoding to a `fluent-ffmpeg` command backed by the
 * `ffmpeg-static` binary.
 */
class CameraRecorder {
  /** Child logger pre-bound with camera metadata for every log line. */
  private readonly logger: Logger;

  /** Active RxJS subscription; `null` before {@link subscribe} is called. */
  private subscriptions: Subscription[] = [];

  /** Active Ring SIP session – kept alive for the duration of a recording. */
  private streamingSession: StreamingSession | null = null;

  /**
   * Current lifecycle state of the recording session.
   * Transitions are the single source of truth – no scattered boolean flags.
   */
  private status: RecordingStatus = RecordingStatus.Idle;

  /**
   * @param {RingCamera} camera - The Ring camera to monitor.
   * @param {Env} env - Validated environment configuration.
   * @param {Logger} logger - Root application logger (a child is derived).
   */
  constructor(
    private readonly camera: RingCamera,
    private readonly env: Env,
    logger: Logger,
  ) {
    this.logger = logger.child({
      cameraId: camera.id,
      cameraName: camera.name,
    });
  }

  /**
   * Begins listening to motion events from the Ring camera.
   */
  public subscribe(): void {
    if (this.subscriptions.length > 0) {
      this.logger.warn("Already subscribed, ignoring duplicate call.");
      return;
    }

    this.logger.info("Subscribing to motion events.");

    const motionStart$: Observable<true> = this.camera.onNewNotification.pipe(
      tap((raw: PushNotificationDingV2) =>
        this.logger.debug({ raw }, "RAW onNewNotification emission."),
      ),
      filter(
        (notification: PushNotificationDingV2) =>
          notification.data.event.ding.subtype === "motion" ||
          notification.data.event.ding.subtype === "human" ||
          notification.android_config.category.includes("motion") ||
          notification.android_config.category.includes("human"),
      ),
      map(() => true as const),
    );

    const motionEnd$: Observable<false> = this.camera.onMotionDetected.pipe(
      skip(1),
      filter((isMotion: boolean): isMotion is false => !isMotion),
      distinctUntilChanged(),
    );

    this.subscriptions.push(
      motionStart$.subscribe(() => void this.handleMotionEvent(true)),
      motionEnd$.subscribe(() => void this.handleMotionEvent(false)),
    );
  }

  /**
   * Stops the active recording (if any) and unsubscribes from motion events.
   *
   * Call exactly once during application shutdown.
   */
  public async stop(): Promise<void> {
    this.logger.info("Stopping camera recorder.");
    this.subscriptions.forEach((subscription: Subscription) =>
      subscription.unsubscribe(),
    );
    this.subscriptions = [];
    await this.stopRecording("Service shutdown.");
  }

  /**
   * Routes a motion event to the appropriate state transition.
   *
   * @param {boolean} isMotion - `true` for motion start, `false` for
   *     motion end.
   */
  private async handleMotionEvent(isMotion: boolean): Promise<void> {
    this.logger.debug(
      { isMotion, status: this.status },
      "Motion event received.",
    );

    if (isMotion) await this.startRecording();
    else await this.stopRecording("Motion ended.");
  }

  /**
   * Transitions from {@link RecordingStatus.Idle} →
   * {@link RecordingStatus.Starting} → {@link RecordingStatus.Active}.
   *
   * Obtains the RTSP URL from `ring-client-api` via `streamVideo()`, then
   * starts a `fluent-ffmpeg` command that writes segmented MP4 files.
   * No shell is involved – fluent-ffmpeg spawns the `ffmpeg-static` binary
   * directly with a typed argument list.
   */
  private async startRecording(): Promise<void> {
    if (this.status !== RecordingStatus.Idle) {
      this.logger.debug(
        { status: this.status },
        "Recording already active or starting, ignoring duplicate start.",
      );
      return;
    }

    this.status = RecordingStatus.Starting;

    const outputPattern: OutputPattern = buildOutputPattern(
      this.env.OUTPUT_DIRECTORY,
      this.camera.name,
    );

    this.logger.info(
      { outputPattern },
      "Motion detected, starting recording.",
    );

    try {
      // StreamVideo() establishes the SIP session and returns the RTSP URL
      // via the SipSession object. We immediately hand that URL to ffmpeg
      // and do not use ring-client-api's internal ffmpeg spawn.
      this.streamingSession = await this.camera.streamVideo(
        this.buildFfmpegOptions(outputPattern),
      );

      this.status = RecordingStatus.Active;

      // Listen for the session to end.
      this.streamingSession.onCallEnded.subscribe(() => {
        this.logger.info("Call ended by Ring, resetting to Idle.");
        this.streamingSession = null;
        this.status = RecordingStatus.Idle;
      });

      this.logger.info({ outputPattern }, "Recording started successfully.");
    } catch (error: unknown) {
      this.status = RecordingStatus.Idle;
      this.logger.error(
        { error },
        "Failed to start recording, reverting to Idle.",
      );
      this.streamingSession?.stop();
      this.streamingSession = null;
    }
  }

  /**
   * Transitions back to {@link RecordingStatus.Idle}.
   *
   * @param {string} reason - Human-readable stop reason
   *     (logged for observability).
   */
  private async stopRecording(reason: string): Promise<void> {
    if (this.status === RecordingStatus.Idle) {
      this.logger.debug(
        { reason },
        "Stop called but no active session, no-op.",
      );
      return;
    }

    this.logger.info({ reason }, "Stopping recording.");

    try {
      this.streamingSession?.stop();
      this.logger.info("Recording stopped cleanly.");
    } catch (error: unknown) {
      this.logger.error({ error }, "Error while stopping recording session.");
    } finally {
      this.streamingSession = null;
      this.status = RecordingStatus.Idle;
    }
  }

  /**
   * Builds the ffmpeg argument list for segmented recording with the
   * configured segment duration and output pattern.
   *
   * @param {OutputPattern} outputPattern - The typed output pattern for this
   *     camera's recordings.
   * @returns {FfmpegOptions} The ffmpeg argument list for the recording
   *     session.
   */
  private buildFfmpegOptions(outputPattern: string): FfmpegOptions {
    return {
      input: [
        // Rebuild missing presentation timestamps and discard packets
        // explicitly marked as corrupt.
        "-fflags",
        // eslint-disable-next-line no-secrets/no-secrets
        "+genpts+discardcorrupt",
      ],
      video: [
        // Do NOT use stream copy here.
        // Decode Ring's H.264 and produce a clean H.264 stream.
        "-c:v",
        "libx264",
        // Reasonable compromise for real-time recording.
        "-preset",
        "veryfast",
        "-crf",
        "23",
        // Maximum browser compatibility.
        "-pix_fmt",
        "yuv420p",
        // Normalize Ring's irregular timestamps/frame cadence.
        "-r",
        "25",
        "-fps_mode:v",
        "cfr",
      ],
      audio: ["-c:a", "aac", "-b:a", "128k", "-ar", "48000"],
      output: [
        "-flags",
        "+global_header",
        "-f",
        "segment",
        "-segment_time",
        String(this.env.SEGMENT_SECONDS),
        "-segment_format",
        "mp4",
        "-reset_timestamps",
        "1",
        // Avoid timestamps before zero in each generated MP4.
        "-avoid_negative_ts",
        "make_zero",
        // Make each finished MP4 suitable for HTTP playback.
        "-segment_format_options",
        "movflags=+faststart",
        "-y",
        outputPattern,
      ],
    };
  }
}

export { CameraRecorder };
