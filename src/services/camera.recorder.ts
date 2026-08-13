import { type Env } from "@/config/env";
import { OutputPattern, RecordingStatus } from "@/types";
import { buildOutputPattern } from "@/utils/helpers";
import { type Logger } from "pino";
import { PushNotificationDingV2, type RingCamera } from "ring-client-api";
import {
  FfmpegOptions,
  type StreamingSession,
} from "ring-client-api/streaming/streaming-session";
import { type Subscription } from "rxjs";
import { filter, tap } from "rxjs/operators";

/**
 * Time to wait after the latest Ring motion notification before stopping
 * the recording.
 *
 * Ring's motion state internally tends to remain active for roughly
 * 60-65 seconds, so 60 seconds gives us a small safety margin.
 */
const MOTION_INACTIVITY_MS = 60_000;

/**
 * Absolute maximum duration of a single recording session.
 *
 * This is a safety net in case Ring keeps sending notifications or the
 * inactivity timer does not fire as expected.
 */
const MAX_RECORDING_MS = 3 * 60_000;

/**
 * Controls motion-triggered video recording for a single Ring camera.
 *
 * A recording starts when a motion/human push notification is received.
 * Every subsequent notification resets an inactivity timer.
 *
 * If no new motion notification is received for MOTION_INACTIVITY_MS,
 * the Ring streaming session is stopped.
 *
 * A second timer enforces MAX_RECORDING_MS as an absolute upper bound.
 */
class CameraRecorder {
  /** Child logger pre-bound with camera metadata for every log line. */
  private readonly logger: Logger;

  /** Active RxJS subscriptions. */
  private subscriptions: Subscription[] = [];

  /** Active Ring streaming session. */
  private streamingSession: StreamingSession | null = null;

  /**
   * Current lifecycle state of the recording session.
   * Idle -> Starting -> Active -> Idle.
   */
  private status: RecordingStatus = RecordingStatus.Idle;

  /**
   * Timer restarted every time a new motion notification is received.
   */
  private motionStopTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Safety timer limiting the total duration of one streaming session.
   */
  private maxRecordingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param camera Ring camera to monitor.
   * @param env Validated environment configuration.
   * @param logger Root application logger.
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
   * Begins listening to Ring push notifications.
   */
  public subscribe(): void {
    if (this.subscriptions.length > 0) {
      this.logger.warn("Already subscribed, ignoring duplicate call.");
      return;
    }

    this.logger.info("Subscribing to motion notifications.");

    const motionSubscription = this.camera.onNewNotification
      .pipe(
        tap((raw: PushNotificationDingV2) =>
          this.logger.debug({ raw }, "RAW onNewNotification emission."),
        ),

        filter((notification: PushNotificationDingV2) => {
          const subtype = notification.data.event.ding.subtype;
          const category = notification.android_config.category;

          return (
            subtype === "motion" ||
            subtype === "human" ||
            category.includes("motion") ||
            category.includes("human")
          );
        }),
      )
      .subscribe(() => {
        void this.handleMotionNotification();
      });

    this.subscriptions.push(motionSubscription);
  }

  /**
   * Stops the active recording and unsubscribes from Ring notifications.
   *
   * Should be called during application shutdown.
   */
  public async stop(): Promise<void> {
    this.logger.info("Stopping camera recorder.");

    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }

    this.subscriptions = [];

    this.clearMotionStopTimer();
    this.clearMaxRecordingTimer();

    await this.stopRecording("Service shutdown.");
  }

  /**
   * Handles a motion/human notification.
   *
   * A notification either:
   * - starts a new recording when idle;
   * - or extends the current recording by resetting the inactivity timer.
   */
  private async handleMotionNotification(): Promise<void> {
    this.logger.debug(
      { status: this.status },
      "Motion notification received.",
    );

    /*
     * Reset this immediately.
     *
     * This means another motion notification received while the stream is
     * still starting also extends the recording lifetime correctly.
     */
    this.resetMotionStopTimer();

    if (this.status === RecordingStatus.Idle) {
      await this.startRecording();
      return;
    }

    this.logger.debug(
      { status: this.status },
      "Recording already active or starting, inactivity timer extended.",
    );
  }

  /**
   * Starts a Ring streaming session.
   *
   * Transitions:
   * Idle -> Starting -> Active.
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
      /*
       * StreamVideo() establishes the Ring streaming session and starts
       * ring-client-api's FFmpeg transcoding process using the options below.
       */
      const session = await this.camera.streamVideo(
        this.buildFfmpegOptions(outputPattern),
      );

      /*
       * It is theoretically possible for stopRecording() to have been called
       * while streamVideo() was still resolving.
       *
       * Don't attach a newly-created session if our state has already moved
       * away from Starting.
       */
      if (this.status !== RecordingStatus.Starting) {
        this.logger.warn(
          { status: this.status },
          "Streaming session started after recording was cancelled; stopping it.",
        );

        session.stop();
        return;
      }

      this.streamingSession = session;
      this.status = RecordingStatus.Active;

      this.startMaxRecordingTimer();

      /*
       * Capture this specific session.
       *
       * The identity check prevents a delayed onCallEnded event belonging to
       * an old session from resetting a newer recording session.
       */
      session.onCallEnded.subscribe(() => {
        if (this.streamingSession !== session) {
          this.logger.debug(
            "Ignoring call-ended event from an old streaming session.",
          );
          return;
        }

        this.logger.info("Call ended by Ring, resetting to Idle.");

        this.clearMotionStopTimer();
        this.clearMaxRecordingTimer();

        this.streamingSession = null;
        this.status = RecordingStatus.Idle;
      });

      this.logger.info({ outputPattern }, "Recording started successfully.");
    } catch (error: unknown) {
      this.logger.error(
        { error },
        "Failed to start recording, reverting to Idle.",
      );

      this.clearMotionStopTimer();
      this.clearMaxRecordingTimer();

      try {
        this.streamingSession?.stop();
      } catch (stopError: unknown) {
        this.logger.error(
          { error: stopError },
          "Error stopping failed streaming session.",
        );
      }

      this.streamingSession = null;
      this.status = RecordingStatus.Idle;
    }
  }

  /**
   * Stops the current Ring streaming session.
   *
   * @param {string} reason Human-readable reason logged for observability.
   */
  private async stopRecording(reason: string): Promise<void> {
    /*
     * Timers are always cleared first so a timer cannot fire again while
     * shutdown is already in progress.
     */
    this.clearMotionStopTimer();
    this.clearMaxRecordingTimer();

    if (this.status === RecordingStatus.Idle) {
      this.logger.debug(
        { reason },
        "Stop called but no active session, no-op.",
      );
      return;
    }

    this.logger.info(
      {
        reason,
        status: this.status,
      },
      "Stopping recording.",
    );

    /*
     * Detach our local session reference before calling stop().
     *
     * session.stop() can trigger onCallEnded. Because the callback checks
     * session identity, it will then recognize this as an already-cleaned-up
     * session instead of altering future state.
     */
    const session = this.streamingSession;

    this.streamingSession = null;
    this.status = RecordingStatus.Idle;

    if (!session) {
      /*
       * This can happen when the recording is still in Starting state.
       * startRecording() checks the state again once streamVideo() resolves
       * and will immediately stop that late session.
       */
      this.logger.info(
        { reason },
        "Recording startup cancelled before streaming session was available.",
      );

      return;
    }

    try {
      session.stop();

      this.logger.info({ reason }, "Recording stopped cleanly.");
    } catch (error: unknown) {
      this.logger.error(
        { error, reason },
        "Error while stopping recording session.",
      );
    }
  }

  /**
   * Restarts the motion inactivity timer.
   *
   * Every Ring motion notification gives the active recording another
   * MOTION_INACTIVITY_MS before it is stopped.
   */
  private resetMotionStopTimer(): void {
    this.clearMotionStopTimer();

    this.motionStopTimer = setTimeout(() => {
      this.motionStopTimer = null;

      this.logger.info(
        {
          inactivityMs: MOTION_INACTIVITY_MS,
        },
        "Motion inactivity timeout reached.",
      );

      void this.stopRecording(
        `No motion notification for ${MOTION_INACTIVITY_MS / 1000} seconds.`,
      );
    }, MOTION_INACTIVITY_MS);
  }

  /**
   * Clears the current motion inactivity timer.
   */
  private clearMotionStopTimer(): void {
    if (!this.motionStopTimer) {
      return;
    }

    clearTimeout(this.motionStopTimer);
    this.motionStopTimer = null;
  }

  /**
   * Starts an absolute maximum-duration timer for the current recording.
   *
   * Unlike the inactivity timer, subsequent motion does not extend this one.
   */
  private startMaxRecordingTimer(): void {
    this.clearMaxRecordingTimer();

    this.maxRecordingTimer = setTimeout(() => {
      this.maxRecordingTimer = null;

      this.logger.warn(
        {
          maxRecordingMs: MAX_RECORDING_MS,
        },
        "Maximum recording duration reached.",
      );

      void this.stopRecording(
        `Maximum recording duration of ${MAX_RECORDING_MS / 1000} seconds reached.`,
      );
    }, MAX_RECORDING_MS);
  }

  /**
   * Clears the maximum recording duration timer.
   */
  private clearMaxRecordingTimer(): void {
    if (!this.maxRecordingTimer) {
      return;
    }

    clearTimeout(this.maxRecordingTimer);
    this.maxRecordingTimer = null;
  }

  /**
   * Builds the FFmpeg argument list used by ring-client-api.
   *
   * The output is segmented into individual MP4 files. SEGMENT_SECONDS only
   * determines the duration of each file; it does not determine the total
   * duration of the streaming session.
   *
   * @param outputPattern Output filename pattern.
   */
  private buildFfmpegOptions(outputPattern: string): FfmpegOptions {
    return {
      input: [
        /*
         * Rebuild missing presentation timestamps and discard packets
         * explicitly marked as corrupt.
         */
        "-fflags",
        // eslint-disable-next-line no-secrets/no-secrets
        "+genpts+discardcorrupt",
      ],
      video: [
        /*
         * Decode Ring's H.264 stream and encode a normalized H.264 stream
         * rather than using stream copy.
         */
        "-c:v",
        "libx264",
        /*
         * Good compromise between CPU usage and real-time encoding speed.
         */
        "-preset",
        "veryfast",
        "-crf",
        "23",
        /*
         * Broad browser/device compatibility.
         */
        "-pix_fmt",
        "yuv420p",
        /*
         * Normalize Ring's irregular timestamps/frame cadence.
         */
        "-r",
        "25",
        "-fps_mode:v",
        "cfr",
      ],
      audio: ["-c:a", "aac", "-b:a", "128k", "-ar", "48000"],
      output: [
        "-flags",
        "+global_header",
        /*
         * Write independent MP4 segments.
         */
        "-f",
        "segment",
        "-segment_time",
        String(this.env.SEGMENT_SECONDS),
        "-segment_format",
        "mp4",
        /*
         * Start every generated segment at timestamp zero.
         */
        "-reset_timestamps",
        "1",
        "-avoid_negative_ts",
        "make_zero",
        /*
         * Make completed MP4 segments friendly to HTTP/browser playback.
         */
        "-segment_format_options",
        "movflags=+faststart",
        "-y",
        outputPattern,
      ],
    };
  }
}

export { CameraRecorder };
