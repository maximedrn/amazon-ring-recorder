import { type Env } from "@/config/env";
import { CameraRecorder } from "@/services/camera.recorder";
import { NtfyNotifier } from "@/services/notifier.service";
import { type TokenManager } from "@/services/token.manager";
import { LogLevel, type RefreshToken } from "@/types";
import ffmpegStatic from "ffmpeg-static";
import { type Logger } from "pino";
import { type Location, RingApi, type RingCamera } from "ring-client-api";

/**
 * Top-level service that wires together the Ring API and all camera recorders.
 *
 * Lifecycle:
 * 1. {@link start} – connect to Ring, discover cameras, start all recorders.
 * 2. {@link stop} – gracefully stop all recorders and release resources.
 */
class RingRecorderService {
  /** All active per-camera recorder instances. */
  private recorders: CameraRecorder[] = [];

  /** Lazily initialized Ring API client. */
  private ringApi: RingApi | null = null;

  /** Push notification publisher shared by every camera recorder. */
  private readonly notifier: NtfyNotifier;

  /**
   * @param {Env} env - Validated, frozen environment configuration.
   * @param {TokenManager} tokenManager - Token persistence helper.
   * @param {Logger} logger - Root application logger.
   */
  constructor(
    private readonly env: Env,
    private readonly tokenManager: TokenManager,
    private readonly logger: Logger,
  ) {
    this.notifier = new NtfyNotifier(env, logger);
  }

  /**
   * Connects to the Ring API, discovers all cameras, and starts monitoring.
   *
   * @throws {Error} When no refresh token is available or the Ring API
   *   cannot be reached.
   */
  public async start(): Promise<void> {
    const refreshToken: RefreshToken = this.tokenManager.getToken();

    if (!ffmpegStatic) {
      throw new Error("ffmpeg-static binary not found.");
    }

    this.ringApi = new RingApi({
      refreshToken,
      cameraStatusPollingSeconds: this.env.CAMERA_POLLING_SECONDS,
      debug: this.env.LOG_LEVEL === LogLevel.Debug,
    });

    this.wireTokenRotation(this.ringApi);

    const [cameras, locations]: [RingCamera[], Location[]] = await Promise.all(
      [this.ringApi.getCameras(), this.ringApi.getLocations()],
    );

    // Force WebSocket connection on each location
    // Without this, push notifications (motion, ding) are never received.
    await Promise.all(
      locations.map((location: Location) => location.getDevices()),
    );

    this.logger.info(
      {
        locationCount: locations.length,
        cameraCount: cameras.length,
        cameraNames: cameras.map((camera: RingCamera) => camera.name),
      },
      "Ring API connected successfully.",
    );

    if (cameras.length === 0) {
      this.logger.warn("No cameras found.");
      return;
    }

    this.recorders = cameras.map((camera: RingCamera) => {
      const recorder: CameraRecorder = new CameraRecorder(
        camera,
        this.env,
        this.notifier,
        this.logger,
      );
      recorder.subscribe();
      return recorder;
    });

    this.logger.info(
      { recorderCount: this.recorders.length },
      "All camera recorders initialized and listening.",
    );
  }

  /**
   * Gracefully stops all active recordings and unsubscribes from all events.
   *
   * Uses `Promise.allSettled` so a failure in one recorder does not prevent
   * others from shutting down cleanly.
   */
  public async stop(): Promise<void> {
    this.logger.info("Stopping all camera recorders.");

    const results: PromiseSettledResult<void>[] = await Promise.allSettled(
      this.recorders.map((recorder: CameraRecorder) => recorder.stop()),
    );

    // Log any recorders that failed to stop cleanly.
    results.forEach((result: PromiseSettledResult<void>, index: number) => {
      if (result.status === "rejected") {
        this.logger.error(
          { err: result.reason, recorderIndex: index },
          "Recorder failed to stop cleanly.",
        );
      }
    });

    this.recorders = [];
    this.logger.info("All recorders stopped.");
  }

  /**
   * Wires up the Ring API token-rotation listener.
   *
   * Ring rotates the refresh token on every API call. Saving the new token
   * immediately ensures the service survives a restart without re-auth.
   *
   * @param {RingApi} api - Active {@link RingApi} instance.
   */
  private wireTokenRotation(api: RingApi): void {
    api.onRefreshTokenUpdated.subscribe(
      ({ newRefreshToken }: { newRefreshToken: string }) => {
        this.logger.debug("Ring refresh token rotation received.");
        void this.tokenManager.saveToken(newRefreshToken);
      },
    );
  }
}

export { RingRecorderService };
