import { env } from "@/config/env";
import { createLogger } from "@/logging";
import { NodeEnv } from "@/types";
import { defineCommand, runMain } from "citty";
import { Eta } from "eta";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { Logger } from "pino";

/**
 * Configuration for the Lima config generation script.
 */
const GENERATE_CONFIG = {
  /** Output directory for generated Lima config files. */
  outputFolder: "dist",
  /**
   * Output file name pattern, where `{arch}` is replaced by
   * the target architecture.
   */
  outputFile: "lima-{arch}.yaml",
  /** Directory containing the Eta template for the Lima config. */
  templateFolder: "config",
  /** Eta template file name for the Lima config. */
  templateFile: "lima.yaml.eta",
} as const satisfies Record<string, string>;

/**
 * Supported target architectures for Lima VM configuration.
 */
enum Architecture {
  ARM64 = "arm64",
  AMD64 = "amd64",
}

/**
 * Lima VM configuration for a specific target architecture.
 */
interface LimaConfig {
  /** Lima/QEMU architecture identifier. */
  readonly arch: string;
  /** Cloud image URL for the target architecture. */
  readonly image: string;
  /** Number of virtual CPUs. */
  readonly cpus: number;
  /** Memory allocation (e.g. `512MiB`, `2GiB`). */
  readonly memory: string;
  /** Disk size (e.g. `8GiB`). */
  readonly disk: string;
}

const IMAGE_BASE_URL =
  "https://cloud.debian.org/images/cloud/bookworm/latest" as const satisfies string;

/**
 * Supported target architectures mapped to their Lima configurations.
 */
const CONFIGS = {
  [Architecture.ARM64]: {
    arch: "aarch64",
    image: `${IMAGE_BASE_URL}/debian-12-genericcloud-arm64.qcow2`,
    cpus: 1,
    memory: "512MiB",
    disk: "1GiB",
  },
  [Architecture.AMD64]: {
    arch: "x86_64",
    image: `${IMAGE_BASE_URL}/debian-12-genericcloud-amd64.qcow2`,
    cpus: 1,
    memory: "512MiB",
    disk: "1GiB",
  },
} as const satisfies Record<Architecture, LimaConfig>;

/**
 * Resolved CLI arguments after parsing by citty.
 */
interface GenerateArgs {
  /** Target architecture to generate the Lima config for. */
  readonly arch: string;
}

const logger: Logger = createLogger({
  ...env,
  NODE_ENV: NodeEnv.Development,
});

runMain(
  defineCommand({
    meta: {
      name: "generate-config",
      description:
        "Generate a Lima VM configuration file for a target architecture.",
    },
    args: {
      arch: {
        type: "string",
        description: `Target architecture. 
          One of: ${Object.keys(Architecture).join(", ")}.`,
        default: Architecture.AMD64,
      },
    },

    /**
     * @param {{ args: GenerateArgs }} context - Citty context containing
     *   parsed args.
     */
    run: ({ args }: { args: GenerateArgs }): void => {
      if (!(args.arch in CONFIGS)) {
        logger.error(
          `Unknown target: "${args.arch}". 
          Available: ${Object.keys(Architecture).join(", ")}`,
        );
        process.exit(1);
      }

      // Ensure output directory exists and write the rendered template
      // to the output file.
      mkdirSync(GENERATE_CONFIG.outputFolder, { recursive: true });
      const outputFile: string = join(
        GENERATE_CONFIG.outputFolder,
        GENERATE_CONFIG.outputFile.replace("{arch}", args.arch),
      );

      const eta: Eta = new Eta({
        views: join(process.cwd(), GENERATE_CONFIG.templateFolder),
        autoTrim: false,
      });
      const config: LimaConfig = CONFIGS[args.arch as keyof typeof CONFIGS];
      const yaml: string = eta.render(GENERATE_CONFIG.templateFile, config);

      writeFileSync(outputFile, yaml);
      logger.info(`Generated "${outputFile}".`);
    },
  }),
);
