import { type Env } from "@/config/env";
import { formatDuration } from "@/utils/helpers";
import { type Logger } from "pino";

/**
 * HTTP request timeout used when publishing to the ntfy server.
 */
const NTFY_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Details of a completed recording, used to build the ntfy notification.
 */
interface RecordingFinishedDetails {
  /** Camera name from the Ring API. */
  readonly cameraName: string;
  /** Recording duration in whole seconds. */
  readonly durationSeconds: number;
  /** Base file name of the recorded video. */
  readonly filename: string;
  /** Human-readable reason why the recording stopped. */
  readonly reason: string;
}

interface NtfyPublishInput {
  /** Notification title. */
  readonly title: string;
  /** Notification body. */
  readonly message: string;
  /** Comma-separated list of emoji tags. */
  readonly tags: readonly string[];
}

/**
 * Publishes push notifications to a self-hosted ntfy server.
 *
 * The ntfy server is reachable at {@link Env.NTFY_URL} (inside Docker:
 * `http://ntfy:80`). Messages are published to `NTFY_TOPIC`,
 * authenticated with the write-only `NTFY_USER` / `NTFY_PASSWORD`
 * credentials provisioned automatically at first boot by
 * `config/ntfy-entrypoint.sh`.
 *
 * Publishing failures are logged and swallowed: a notification must never
 * crash the recorder or interrupt the recording flow.
 */
class NtfyNotifier {
  /** Pre-bound child logger. */
  private readonly logger: Logger;

  /**
   * @param {Env} env Validated environment configuration.
   * @param {Logger} logger Root application logger.
   */
  constructor(
    private readonly env: Env,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "ntfy-notifier" });
  }

  /**
   * Publishes a "recording finished" notification to the ntfy topic.
   *
   * @param {RecordingFinishedDetails} details Details of the completed
   *     recording.
   */
  public async notifyRecordingFinished(
    details: RecordingFinishedDetails,
  ): Promise<void> {
    const { cameraName, durationSeconds, filename, reason } = details;

    const message: string = [
      `Camera : ${cameraName}`,
      `Duration : ${formatDuration(durationSeconds)}`,
      `File : ${filename}`,
      `Reason : ${reason}`,
    ].join("\n");

    try {
      await this.publish({
        title: "Recording finished",
        message,
        tags: ["video_camera"],
      });
    } catch (error: unknown) {
      this.logger.error(
        { error, topic: this.env.NTFY_TOPIC },
        "Failed to publish ntfy notification.",
      );
    }
  }

  /**
   * Publishes a message to the configured ntfy topic.
   *
   * @param {NtfyPublishInput} input Message payload (title, body, emoji tags).
   * @throws {Error} When the ntfy server is unreachable or returns an error.
   */
  private async publish(input: NtfyPublishInput): Promise<void> {
    const url: string = `${this.env.NTFY_URL}/${this.env.NTFY_TOPIC}`;

    const headers: Record<string, string> = {
      Title: input.title,
      Tags: input.tags.join(","),
    };

    if (this.env.NTFY_PASSWORD) {
      const credentials: string = `${this.env.NTFY_USER}:${this.env.NTFY_PASSWORD}`;
      headers["Authorization"] =
        `Basic ${Buffer.from(credentials).toString("base64")}`;
    }

    this.logger.debug({ url }, "Publishing ntfy notification.");

    const response: Response = await fetch(url, {
      method: "POST",
      headers,
      body: input.message,
      signal: AbortSignal.timeout(NTFY_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `ntfy responded with status ${response.status} ${response.statusText}.`,
      );
    }

    this.logger.info(
      {
        statusCode: response.status,
        topic: this.env.NTFY_TOPIC,
      },
      "ntfy notification published.",
    );
  }
}

export { NtfyNotifier, type RecordingFinishedDetails };
