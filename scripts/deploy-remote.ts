import { env } from "@/config/env";
import { createLogger } from "@/logging";
import { NodeEnv } from "@/types";
import { defineCommand, runMain } from "citty";
import Dockerode from "dockerode";
import { execa } from "execa";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "fs";
import { Listr, type ListrTask } from "listr2";
import { NodeSSH, SSHExecCommandResponse } from "node-ssh";
import { join } from "path";
import { type Logger } from "pino";

/**
 * Static deploy configuration — centralises all path and naming constants
 * so they are never scattered across the file as bare string literals.
 */
const DEPLOY_CONFIG = {
  /** Local directory where the image tarball is written before upload. */
  outputDirectory: "dist",
  /** Docker image name used for both local build and remote load. */
  imageName: "amazon-ring-recorder",
  /** Local path where the exported image tarball is written. */
  imageTar: join("dist", "amazon-ring-recorder.tar"),
  /** Project-root compose file uploaded to the remote host as-is. */
  composeFile: "docker-compose.yaml",
  /** Local `.env` file uploaded to the remote host. */
  envFile: ".env",
} as const satisfies Record<string, string>;

// Force development mode for the deploy script — always pretty-print locally
// regardless of the NODE_ENV value in .env.
const logger: Logger = createLogger({
  ...env,
  NODE_ENV: NodeEnv.Development,
});

/**
 * Resolved CLI arguments after parsing by citty.
 */
interface DeployArgs {
  /** Hostname or IP address of the remote host. */
  readonly host: string;
  /** SSH port. */
  readonly port: string;
  /** SSH username on the remote host. */
  readonly user: string;
  /** Path to the SSH identity file. */
  readonly identityFile: string;
  /**
   * Target Docker platform architecture passed to `docker buildx build`.
   * Examples: `linux/arm64`, `linux/amd64`, `linux/arm/v7`.
   */
  readonly arch: string;
}

/**
 * Shared Listr2 context passed between tasks.
 */
interface TaskContext {
  /** Active SSH connection to the remote host. */
  ssh: NodeSSH;
  /** Absolute path of the home directory on the remote host. */
  remoteHome: string;
}

/**
 * Executes a remote SSH command and throws if the exit code is non-zero.
 *
 * @param {NodeSSH} ssh - Active SSH connection.
 * @param {string}  command - Shell command to execute on the remote host.
 * @returns {Promise<string>} Stdout of the command.
 * @throws {Error} When the remote command exits with a non-zero code.
 */
const remoteExecution = async (
  ssh: NodeSSH,
  command: string,
): Promise<string> => {
  const response: SSHExecCommandResponse = await ssh.execCommand(command);
  if (response.code === 0) return response.stdout;
  const { code, stderr }: { code: number | null; stderr: string } = response;
  throw new Error(`Remote command failed (exit ${String(code)}): ${stderr}`);
};

/**
 * Builds a Docker image for the target architecture via `docker buildx`
 * and exports it as a tarball using the Dockerode API.
 *
 * `buildx` is required for cross-platform compilation and is not yet
 * supported natively by the Dockerode API — hence the `execa` call for
 * the build step only.
 *
 * @param {string} arch - Target platform.
 * @returns {ListrTask[]} Build task list.
 */
const buildTasks = (arch: string): ListrTask[] => [
  {
    title: `Build Docker image (${arch})`,
    task: async (): Promise<void> => {
      await execa(
        "docker",
        [
          "build",
          `--platform=${arch}`,
          "-t",
          `${DEPLOY_CONFIG.imageName}:latest`,
          ".",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
    },
  },
  {
    title: "Export image to tarball",
    task: async (): Promise<void> => {
      mkdirSync(DEPLOY_CONFIG.outputDirectory, { recursive: true });
      if (existsSync(DEPLOY_CONFIG.imageTar)) rmSync(DEPLOY_CONFIG.imageTar);

      const docker: Dockerode = new Dockerode();
      const image: Dockerode.Image = docker.getImage(
        `${DEPLOY_CONFIG.imageName}:latest`,
      );
      const stream: NodeJS.ReadableStream = await image.get();

      await new Promise<void>((resolve, reject): void => {
        const destination: NodeJS.WritableStream = createWriteStream(
          DEPLOY_CONFIG.imageTar,
        );
        stream.pipe(destination);
        destination.on("finish", resolve);
        destination.on("error", reject);
        stream.on("error", reject);
      });

      if (!existsSync(DEPLOY_CONFIG.imageTar))
        throw new Error("Tarball not found after export.");

      const sizeMb: string = (
        statSync(DEPLOY_CONFIG.imageTar).size /
        (1024 * 1024)
      ).toFixed(1);

      logger.info(
        { imageTar: DEPLOY_CONFIG.imageTar, arch, size: `${sizeMb} MB` },
        "Image exported.",
      );
    },
  },
];

/**
 * Returns Listr2 tasks that open the SSH connection and resolve the
 * remote home directory.
 *
 * @param {DeployArgs} args - Resolved CLI arguments.
 * @returns {ListrTask<TaskContext>[]} Connection task list.
 */
const connectTasks = (args: DeployArgs): ListrTask<TaskContext>[] => [
  {
    title: "Establish SSH connection",
    task: async (context: TaskContext): Promise<void> => {
      const ssh: NodeSSH = new NodeSSH();

      await ssh.connect({
        host: args.host,
        port: parseInt(args.port, 10),
        username: args.user,
        privateKeyPath: args.identityFile,
        tryKeyboard: false,
        readyTimeout: 10_000,
      });
      context.ssh = ssh;
      context.remoteHome = (
        await ssh.execCommand(["echo", "~"].join(" "))
      ).stdout.trim();

      logger.info(
        { host: args.host, remoteHome: context.remoteHome },
        "SSH connected.",
      );
    },
  },
];

/**
 * Returns Listr2 tasks that upload all required files to the remote host:
 * the Docker image tarball, the `.env`, and the `docker-compose.yaml`.
 *
 * @returns {ListrTask<TaskContext>[]} File upload task list.
 */
const copyFileTasks = (): ListrTask<TaskContext>[] => [
  {
    title: "Upload Docker image",
    task: async (context: TaskContext): Promise<void> => {
      await context.ssh.putFile(
        DEPLOY_CONFIG.imageTar,
        `${context.remoteHome}/${DEPLOY_CONFIG.imageName}.tar`,
      );
    },
  },
  {
    title: `Upload ${DEPLOY_CONFIG.envFile} file`,
    task: async (context: TaskContext): Promise<void> => {
      await context.ssh.putFile(
        DEPLOY_CONFIG.envFile,
        join(context.remoteHome, DEPLOY_CONFIG.envFile),
      );
      await remoteExecution(
        context.ssh,
        ["chmod", "600", join(context.remoteHome, DEPLOY_CONFIG.envFile)].join(
          " ",
        ),
      );
    },
  },
  {
    title: `Upload ${DEPLOY_CONFIG.composeFile}`,
    task: async (context: TaskContext): Promise<void> => {
      await context.ssh.putFile(
        DEPLOY_CONFIG.composeFile,
        join(context.remoteHome, DEPLOY_CONFIG.composeFile),
      );
    },
  },
];

/**
 * Returns Listr2 tasks that prepare the remote host:
 * optionally install Docker and load the image tarball into the
 * remote Docker daemon.
 *
 * @returns {ListrTask<TaskContext>[]} Remote setup task list.
 */
const setupRemoteTasks = (): ListrTask<TaskContext>[] => [
  {
    title: "Ensure Docker is installed",
    task: async (context: TaskContext): Promise<void> => {
      const present: boolean = await context.ssh
        .execCommand(["command", "-v", "docker"].join(" "))
        .then((response: SSHExecCommandResponse): boolean => !response.code);

      if (present) return;
      await remoteExecution(
        context.ssh,
        ["curl", "-fsSL", "https://get.docker.com", "|", "sudo", "sh"].join(
          " ",
        ),
      );
      const user: string = await remoteExecution(context.ssh, "whoami");
      await remoteExecution(
        context.ssh,
        ["sudo", "usermod", "-aG", "docker", `${user}`].join(" "),
      );
    },
  },
  {
    title: "Load Docker image",
    task: async (context: TaskContext): Promise<void> => {
      await remoteExecution(
        context.ssh,
        [
          "sudo",
          "docker",
          "load",
          "-i",
          join(context.remoteHome, `${DEPLOY_CONFIG.imageName}.tar`),
        ].join(" "),
      );
    },
  },
  {
    title: "Fix volume permissions",
    task: async (context: TaskContext): Promise<void> => {
      await remoteExecution(
        context.ssh,
        [
          "sudo",
          "mkdir",
          "-p",
          join(context.remoteHome, "data"),
          join(context.remoteHome, "data", "recordings"),
        ].join(" "),
      );
      const uid: string = (
        await remoteExecution(
          context.ssh,
          [
            "sudo",
            "docker",
            "run",
            "--rm",
            `${DEPLOY_CONFIG.imageName}:latest`,
            "id",
            "-u",
            "recorder",
          ].join(" "),
        )
      ).trim();
      await remoteExecution(
        context.ssh,
        [
          "sudo",
          "chown",
          "-R",
          `${uid}:${uid}`,
          join(context.remoteHome, "data"),
        ].join(" "),
      );
    },
  },
];

/**
 * Returns Listr2 tasks that start the container via `docker compose`.
 *
 * Docker's own systemd service handles auto-restart on boot.
 * `restart: unless-stopped` in the compose file is sufficient —
 * no custom systemd unit file needed.
 *
 * @returns {ListrTask<TaskContext>[]} Service start task list.
 */
const runTasks = (): ListrTask<TaskContext>[] => [
  {
    title: "Start container",
    task: async (context: TaskContext): Promise<void> => {
      await remoteExecution(
        context.ssh,
        [
          "sudo",
          "docker",
          "compose",
          "-f",
          join(context.remoteHome, DEPLOY_CONFIG.composeFile),
          "up",
          "-d",
          "--no-build",
        ].join(" "),
      );
    },
  },
];

/**
 * Waits for the container to initialise then logs its status and useful
 * follow-up commands for the operator.
 *
 * @param {NodeSSH} ssh - Active SSH connection.
 * @param {string} remoteHome - Absolute path of the remote home directory.
 */
const printStatus = async (
  ssh: NodeSSH,
  remoteHome: string,
): Promise<void> => {
  logger.info("Waiting 3s for container initialisation.");
  await new Promise<void>((resolve: () => void) => setTimeout(resolve, 3_000));

  const response: SSHExecCommandResponse = await ssh.execCommand(
    [
      "sudo",
      "docker",
      "compose",
      "-f",
      `${remoteHome}/docker-compose.yaml`,
      "ps",
    ].join(" "),
  );

  logger.info({ stdout: response.stdout }, "Container status.");
  logger.info({ image: DEPLOY_CONFIG.imageName }, "Deployment complete.");
};

runMain(
  defineCommand({
    meta: {
      name: "deploy-remote",
      description: "Deploy ring-recorder to a remote host via Docker.",
    },
    args: {
      host: {
        type: "string",
        description: "Hostname or IP address of the remote host.",
        default: "raspberrypi.local",
      },
      port: {
        type: "string",
        description: "SSH port.",
        default: "22",
      },
      user: {
        type: "string",
        description: "SSH username on the remote host.",
        default: "pi",
      },
      identityFile: {
        type: "string",
        description: "Path to SSH private key.",
        default: "~/.ssh/id_ed25519",
      },
      arch: {
        type: "string",
        description: "Target Docker platform architecture.",
        default: "linux/arm64",
      },
    },

    /**
     * Main command handler.
     *
     * `env` is Zod-validated on module import — if execution reaches this
     * point, all required variables are present, typed, and transformed.
     *
     * @param {{ args: DeployArgs }} context - Citty context containing
     *   parsed args.
     */
    run: async ({ args }: { args: DeployArgs }): Promise<void> => {
      const context: TaskContext = { ssh: new NodeSSH(), remoteHome: "" };

      const tasks: Listr<TaskContext> = new Listr<TaskContext>(
        [
          {
            title: `Build (${args.arch})`,
            task: (_, task) =>
              task.newListr(buildTasks(args.arch), { concurrent: false }),
          },
          {
            title: "Connect to remote host",
            task: (_, task) =>
              task.newListr(connectTasks(args), { concurrent: false }),
          },
          {
            title: "Copy files to remote host",
            task: (_, task) =>
              task.newListr(copyFileTasks(), { concurrent: false }),
          },
          {
            title: "Setup remote host",
            task: (_, task) =>
              task.newListr(setupRemoteTasks(), { concurrent: false }),
          },
          {
            title: "Run service",
            task: (_, task) =>
              task.newListr(runTasks(), { concurrent: false }),
          },
        ],
        {
          ctx: context,
          rendererOptions: { collapseSubtasks: false },
        },
      );

      try {
        await tasks.run();
        await printStatus(context.ssh, context.remoteHome);
      } catch (error: unknown) {
        logger.error({ err: error }, "Deployment failed.");
        process.exit(1);
      } finally {
        context.ssh.dispose();
      }
    },
  }),
);
