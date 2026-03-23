import { type Env } from "@/config/env";
import { NodeEnv } from "@/types";
import pino, { type Logger } from "pino";

/**
 * Creates the root application logger.
 *
 * @param {Env} env - Validated environment configuration.
 * @returns A configured pino {@link Logger} instance.
 */
const createLogger = (env: Env): Logger => {
  const isProduction: boolean = env.NODE_ENV === NodeEnv.Production;

  return pino({
    level: env.LOG_LEVEL,
    // In production let pino emit plain JSON (fastest, no extra process).
    // In development pipe through pino-pretty for readable console output.
    ...(isProduction
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
              ignore: "pid,hostname",
              messageKey: "msg",
            },
          },
        }),
    // Redact sensitive fields from every log line (defence in depth).
    redact: {
      paths: ["REFRESH_TOKEN", "refreshToken", "newRefreshToken"],
      censor: "[REDACTED]",
    },
    // Serialise Error objects properly (message + stack).
    serializers: {
      err: pino.stdSerializers.err,
    },
  });
};

export { createLogger };
