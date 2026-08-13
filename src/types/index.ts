/**
 * Node.js runtime environment.
 * Mirrors the conventional `NODE_ENV` values.
 */
enum NodeEnv {
  Development = "development",
  Production = "production",
  Test = "test",
}

/**
 * Log verbosity levels, from most to least verbose.
 * Used both as a Zod enum and as a TypeScript enum so the values are
 * accessible at runtime without string literals scattered around.
 */
enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

/**
 * Lifecycle state of a single camera recording session.
 *
 * ```
 * Idle ──► Starting ──► Active ──► Idle
 *              └──► Idle (on error)
 * ```
 */
enum RecordingStatus {
  /** No recording is running and none is being set up. */
  Idle = "IDLE",
  /** An ffmpeg session is being established (async). */
  Starting = "STARTING",
  /** An ffmpeg session is actively recording. */
  Active = "ACTIVE",
}

/**
 * Branded type for a Ring camera identifier.
 * Prevents accidentally passing a raw `number` where a camera ID is expected.
 */
type CameraId = number & { readonly __brand: "CameraId" };

/**
 * Branded type for a filesystem-safe recording output pattern.
 */
type OutputPattern = string & { readonly __brand: "OutputPattern" };

/**
 * Branded string type for a Ring refresh token.
 * Prevents accidentally swapping a token with another opaque string.
 */
type RefreshToken = string & { readonly __brand: "RefreshToken" };

export {
  LogLevel,
  NodeEnv,
  RecordingStatus,
  type CameraId,
  type OutputPattern,
  type RefreshToken,
};
