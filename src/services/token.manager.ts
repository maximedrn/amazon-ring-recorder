import { type Env } from "@/config/env";
import { type RefreshToken } from "@/types";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { type Logger } from "pino";

/**
 * Reads and atomically persists the Ring OAuth refresh token.
 *
 * Token resolution priority (highest → lowest):
 * 1. In-memory cache (already loaded this session),
 * 2. Token file on disk,
 * 3. Environment variable (first-run bootstrap).
 */
class TokenManager {
  /** In-memory cache – avoids repeated disk reads. */
  private cachedToken: RefreshToken | null = null;

  /**
   * @param {Env} env - Validated environment configuration.
   * @param {Logger} logger - Application logger.
   */
  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
  ) {}

  /**
   * Computes the full path to the token file on disk.
   *
   * @returns The absolute path where the refresh token is stored on disk.
   *
   */
  private getTokenFilePath(): string {
    return path.join(this.env.TOKEN_DIRECTORY, ".token");
  }

  /**
   * Returns the current refresh token from the highest-priority source.
   *
   * @returns The active {@link RefreshToken}.
   * @throws {Error} When no token can be resolved from any source.
   */
  public getToken(): RefreshToken {
    if (this.cachedToken) return this.cachedToken;
    this.cachedToken =
      this.readFromDisk() || (this.env.REFRESH_TOKEN as RefreshToken);
    return this.cachedToken;
  }

  /**
   * Atomically persists an updated refresh token to disk.
   *
   * Write strategy:
   * 1. Write `newToken` to a uniquely-named temp file in `os.tmpdir()`.
   * 2. `rename()` the temp file over the target path (atomic on POSIX).
   *
   * This guarantees the target file is never in a half-written state, even
   * if the process is interrupted mid-write.
   *
   * @param {string} token - The rotated {@link RefreshToken} to persist.
   */
  public async saveToken(token: string): Promise<void> {
    this.cachedToken = token as RefreshToken;

    const tokenFilePath: string = this.getTokenFilePath();
    const tempPath: string = `${tokenFilePath}-${Date.now()}`;

    try {
      writeFileSync(tempPath, token, { encoding: "utf8", mode: 0o600 });
      renameSync(tempPath, tokenFilePath);

      this.logger.info(
        { tokenFilePath },
        "Refresh token rotated and persisted.",
      );
    } catch (error: unknown) {
      this.logger.error(
        {
          err: error,
          tempPath,
          tokenFilePath,
          tokenDir: path.dirname(tokenFilePath),
          dirExists: existsSync(path.dirname(tokenFilePath)),
        },
        "Failed to persist refresh token. Service will continue but " +
          "may require manual re-authentication after restart.",
      );
    }
  }

  /**
   * Reads the token file from disk.
   *
   * @returns The token string, or `null` when the file is absent or empty.
   */
  private readFromDisk(): RefreshToken | null {
    if (!existsSync(this.getTokenFilePath())) return null;

    try {
      const contents: string = readFileSync(
        this.getTokenFilePath(),
        "utf8",
      ).trim();

      return contents ? (contents as RefreshToken) : null;
    } catch (error: unknown) {
      this.logger.warn(
        { err: error, tokenFilePath: this.getTokenFilePath() },
        "Failed to read token file.",
      );
      return null;
    }
  }
}

export { TokenManager };
