import { type Env } from "@/config/env";
import { relative, sep } from "path";
import { type Logger } from "pino";

/**
 * HTTP request timeout used when talking to the filebrowser API.
 */
const FILEBROWSER_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Share link lifetime in days (matching ntfy message requirement).
 */
const SHARE_EXPIRATION_DAYS = 1;

/**
 * Creates public, expiring share links for completed recordings through the
 * filebrowser API.
 *
 * The filebrowser server is reachable at {@link Env.FILEBROWSER_URL} (inside
 * Docker: `http://filebrowser:80`). The recorder authenticates as the
 * dedicated `FILEBROWSER_SHARE_USER` account (provisioned with `--perm.share`
 * at first boot by `config/filebrowser-entrypoint.sh`) and asks for a share
 * link expiring after {@link SHARE_EXPIRATION_DAYS} day.
 *
 * The returned link (`FILEBROWSER_PUBLIC_URL/share/<hash>`) is public: the
 * video can be watched without logging in, until the share expires.
 *
 * Failures are logged and swallowed: a share link must never crash the
 * recorder. When the service is not configured (`FILEBROWSER_SHARE_PASSWORD`
 * or `FILEBROWSER_PUBLIC_URL` missing), `null` is returned and the
 * notification is simply published without a link.
 */
class FilebrowserShareService {
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
    this.logger = logger.child({ component: "filebrowser-share" });
  }

  /**
   * Returns `true` when a public share link can be produced: both the
   * public base URL and the share account password must be configured.
   *
   * @returns {boolean} Service availability.
   */
  public isConfigured(): boolean {
    return Boolean(
      this.env.FILEBROWSER_PUBLIC_URL && this.env.FILEBROWSER_SHARE_PASSWORD,
    );
  }

  /**
   * Creates a public share link for a completed recording.
   *
   * @param {string} absoluteVideoPath Absolute path of the recorded video
   *     on the shared filesystem.
   * @returns {Promise<string | null>} Public share URL, or `null` when the
   *     service is not configured or the share could not be created.
   */
  public async createShareLink(
    absoluteVideoPath: string,
  ): Promise<string | null> {
    if (!this.isConfigured()) {
      this.logger.debug(
        "filebrowser share service not configured, no share link created.",
      );
      return null;
    }

    try {
      const token: string = await this.login();
      const hash: string = await this.createShare(
        token,
        this.toVirtualPath(absoluteVideoPath),
      );

      const url: string = `${this.publicBaseUrl()}/share/${hash}`;
      this.logger.info({ url }, "filebrowser share link created.");

      return url;
    } catch (error: unknown) {
      this.logger.warn(
        { error },
        "Failed to create filebrowser share link, notification sent without it.",
      );
      return null;
    }
  }

  /**
   * Strips any trailing slashes from the public base URL.
   *
   * @returns {string} Normalized public base URL.
   */
  private publicBaseUrl(): string {
    return this.env.FILEBROWSER_PUBLIC_URL.replace(/\/+$/, "");
  }

  /**
   * Maps an absolute recording path to the path filebrowser exposes it at.
   *
   * `OUTPUT_DIRECTORY` is mounted inside the filebrowser container (as
   * `/srv`), so the share path is the recording path relative to
   * `OUTPUT_DIRECTORY`, each segment URL-encoded, with a leading slash.
   *
   * @param {string} absoluteVideoPath Absolute path of the recorded video.
   * @returns {string} Filebrowser virtual path, e.g. `/doorbell-123.mp4`.
   */
  private toVirtualPath(absoluteVideoPath: string): string {
    const relativePath: string = relative(
      this.env.OUTPUT_DIRECTORY,
      absoluteVideoPath,
    );

    const encodedSegments: string[] = relativePath
      .split(sep)
      .map((segment: string) => encodeURIComponent(segment));

    return `/${encodedSegments.join("/")}`;
  }

  /**
   * Authenticates as the share account and returns a JWT.
   *
   * @returns {Promise<string>} Filebrowser JWT token.
   * @throws {Error} When login fails.
   */
  private async login(): Promise<string> {
    const response: Response = await fetch(
      `${this.env.FILEBROWSER_URL}/api/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.env.FILEBROWSER_SHARE_USER,
          password: this.env.FILEBROWSER_SHARE_PASSWORD,
        }),
        signal: AbortSignal.timeout(FILEBROWSER_REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      throw new Error(
        `filebrowser login responded with status ${response.status}.`,
      );
    }

    return (await response.text()).trim();
  }

  /**
   * Creates a share for the given virtual path.
   *
   * @param {string} token Filebrowser JWT token.
   * @param {string} virtualPath Filebrowser path to share.
   * @returns {Promise<string>} Share hash.
   * @throws {Error} When the share could not be created.
   */
  private async createShare(
    token: string,
    virtualPath: string,
  ): Promise<string> {
    const url: string =
      `${this.env.FILEBROWSER_URL}/api/share${virtualPath}` +
      `?expires=${SHARE_EXPIRATION_DAYS}&unit=days`;

    const response: Response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth": token,
      },
      body: JSON.stringify({
        expires: String(SHARE_EXPIRATION_DAYS),
        unit: "days",
      }),
      signal: AbortSignal.timeout(FILEBROWSER_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `filebrowser share responded with status ${response.status}.`,
      );
    }

    const body: unknown = await response.json();
    const hash: unknown =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)["hash"]
        : undefined;

    if (typeof hash !== "string" || hash === "") {
      throw new Error("filebrowser share response did not contain a hash.");
    }

    return hash;
  }
}

export { FilebrowserShareService };
