import { env } from "@/config/env";
import { createLogger } from "@/logging";
import { RingRecorderService } from "@/services/recorder.service";
import { TokenManager } from "@/services/token.manager";
import { Logger } from "pino";

/**
 * Application entry point – bootstraps the Ring Recorder service.
 *
 * Responsibilities:
 * 1. Create and configure the root logger.
 * 2. Instantiate the {@link TokenManager} for refresh token persistence.
 * 3. Instantiate and start the {@link RingRecorderService}.
 * 4. Handle graceful shutdown on termination signals (SIGINT, SIGTERM).
 * 5. Catch unhandled promise rejections to prevent silent failures.
 */
const bootstrap = async (): Promise<void> => {
  const logger: Logger = createLogger(env);

  logger.info(
    { nodeEnv: env.NODE_ENV, logLevel: env.LOG_LEVEL },
    "Starting Ring Recorder service.",
  );

  const tokenManager: TokenManager = new TokenManager(env, logger);
  const service: RingRecorderService = new RingRecorderService(
    env,
    tokenManager,
    logger,
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, "Shutdown signal received.");
    try {
      await service.stop();
      logger.info("Graceful shutdown complete.");
      process.exit(0);
    } catch (error: unknown) {
      logger.error({ err: error }, "Error during shutdown.");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Catch unhandled rejections – last resort before the process crashes.
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error({ reason }, "Unhandled promise rejection.");
    process.exit(1);
  });

  await service.start();
};

bootstrap().catch((error: unknown) => {
  console.error("Fatal error during bootstrap:", error);
  process.exit(1);
});
