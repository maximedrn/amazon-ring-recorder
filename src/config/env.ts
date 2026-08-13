import { LogLevel, NodeEnv } from "@/types/index";
import "dotenv/config";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { z } from "zod";

/**
 * Returns `true` when `value` parses as an absolute URL.
 *
 * @param {string} value - Candidate URL.
 * @returns {boolean} URL validity.
 */
const isValidUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const envSchema = z.object({
  REFRESH_TOKEN: z
    .string({ error: "REFRESH_TOKEN is required." })
    .min(10, "REFRESH_TOKEN is too short to be valid."),
  OUTPUT_DIRECTORY: z
    .string()
    .transform((value: string) => path.resolve(value)),
  TOKEN_DIRECTORY: z
    .string()
    .transform((value: string) => path.resolve(value)),
  CAMERA_POLLING_SECONDS: z.coerce
    .number({ error: "CAMERA_POLLING_SECONDS must be a number." })
    .int()
    .positive()
    .default(20),
  LOG_LEVEL: z.enum(LogLevel).default(LogLevel.Info),
  NODE_ENV: z.enum(NodeEnv).default(NodeEnv.Production),
  NTFY_URL: z
    .string({ error: "NTFY_URL must be a non-empty string." })
    .min(1, "NTFY_URL cannot be empty.")
    .refine((value: string): boolean => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, "NTFY_URL must be a valid URL.")
    .default("http://ntfy:80"),
  NTFY_TOPIC: z
    .string({ error: "NTFY_TOPIC must be a non-empty string." })
    .min(1, "NTFY_TOPIC cannot be empty.")
    .default("recordings"),
  NTFY_USER: z.string().default("recorder"),
  NTFY_PASSWORD: z.string().default(""),
  FILEBROWSER_URL: z
    .string({ error: "FILEBROWSER_URL must be a non-empty string." })
    .min(1, "FILEBROWSER_URL cannot be empty.")
    .refine(isValidUrl, "FILEBROWSER_URL must be a valid URL.")
    .default("http://filebrowser:80"),
  FILEBROWSER_PUBLIC_URL: z
    .string()
    .default("")
    .refine(
      (value: string): boolean => value === "" || isValidUrl(value),
      "FILEBROWSER_PUBLIC_URL must be a valid URL.",
    ),
  FILEBROWSER_SHARE_USER: z.string().default("share"),
  FILEBROWSER_SHARE_PASSWORD: z.string().default(""),
});

/**
 * Fully-typed, validated environment configuration.
 * Inferred directly from {@link envSchema} – no duplication.
 */
type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates `process.env` at module load time.
 *
 * On failure, prints a human-readable summary of all validation errors and
 * exits the process immediately so misconfiguration is caught at startup,
 * not buried in a runtime crash later.
 *
 * @returns {Env} Validated environment configuration as a plain object.
 */
function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted: string = result.error.issues
      .map(
        (error: z.core.$ZodIssue) =>
          `[${error.path.join(".")}] ${error.message}`,
      )
      .join("\n");
    console.error("Invalid environment configuration:\n" + formatted);
    process.exit(1);
  }

  // Ensure critical directories exist immediately after validation.
  ensureDirectory(result.data.OUTPUT_DIRECTORY);
  ensureDirectory(result.data.TOKEN_DIRECTORY);

  return result.data;
}

/**
 * Creates a directory (and any missing parents) if it does not exist.
 *
 * @param {string} directory - Absolute path to create.
 */
const ensureDirectory = (directory: string): void => {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
};

/**
 * Validated, frozen environment configuration.
 *
 * Import this constant anywhere in the application instead of reading
 * `process.env` directly.
 */
const env: Readonly<Env> = Object.freeze(parseEnv());

export { env, type Env };
