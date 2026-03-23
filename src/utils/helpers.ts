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
 * Builds a typed, filesystem-safe ffmpeg segment output pattern for a camera.
 *
 * Uses `slugify` to normalise the camera name (lowercase, unicode-safe,
 * strips special chars), then appends a timestamp and a zero-padded segment
 * index placeholder for ffmpeg's segment muxer.
 *
 * The return value is branded as {@link OutputPattern} so it cannot be
 * confused with an arbitrary `string`.
 *
 * @param {string} outputDirectory - Directory where recordings are written.
 * @param {string} cameraName - Raw camera name from the Ring API.
 * @param {Date} date - Recording start time. Defaults to `new Date()`.
 * @returns {OutputPattern} Branded absolute output pattern string.
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
  const filename: string = `${slug}-${timestamp}-%04d.mp4`;

  return path.join(outputDirectory, filename) as OutputPattern;
};

export { buildOutputPattern, buildTimestamp };
