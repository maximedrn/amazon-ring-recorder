import { type OutputPattern } from "@/types";
import { format } from "date-fns";
import path from "path";
import slugify from "slugify";

/**
 * Formats a `Date` as a compact, filesystem-safe timestamp.
 *
 * @param {Date} date - Date to format. Defaults to `new Date()`.
 * @returns {string} Formatted timestamp string.
 */
const buildTimestamp = (date: Date = new Date()): string => {
  return format(date, "yyyyMMdd-HHmmss");
};

/**
 * Builds a typed, filesystem-safe output file path for a camera.
 *
 * Uses `slugify` to normalize the camera name (lowercase, unicode-safe,
 * strips special chars), then appends a timestamp of the recording start.
 *
 * Each motion event writes a single continuous MP4 file: the recording
 * session duration is bounded by motion inactivity, not by file segmentation.
 *
 * The return value is branded as {@link OutputPattern} so it cannot be
 * confused with an arbitrary `string`.
 *
 * @param {string} outputDirectory - Directory where recordings are written.
 * @param {string} cameraName - Raw camera name from the Ring API.
 * @param {Date} date - Recording start time. Defaults to `new Date()`.
 * @returns {OutputPattern} Branded absolute output file path.
 */
const buildOutputPattern = (
  outputDirectory: string,
  cameraName: string,
  date: Date = new Date(),
): OutputPattern => {
  const slug: string = slugify(cameraName, {
    lower: true,
    strict: true,
    locale: "en",
  });

  const timestamp: string = buildTimestamp(date);
  const filename: string = `${slug}-${timestamp}.mp4`;

  return path.join(outputDirectory, filename) as OutputPattern;
};

/**
 * Formats a duration in seconds as a compact human-readable string,
 * e.g. `1m 05s`.
 *
 * @param {number} seconds - Duration in whole seconds. Must be positive.
 * @returns {string} Formatted duration string.
 */
const formatDuration = (seconds: number): string => {
  const minutes: number = Math.floor(seconds / 60);
  const remainingSeconds: number = seconds % 60;
  if (minutes === 0) return `${String(remainingSeconds).padStart(2, "0")}s`;
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
};

export { buildOutputPattern, buildTimestamp, formatDuration };
