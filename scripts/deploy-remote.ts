import { env } from "@/config/env";
import { createLogger } from "@/logging";
import { NodeEnv } from "@/types";
import { password } from "@inquirer/prompts";
import { ListrInquirerPromptAdapter } from "@listr2/prompt-adapter-inquirer";
import { defineCommand, runMain } from "citty";
import { execa } from "execa";
import { existsSync, mkdirSync, rmSync, statSync } from "fs";
import { Listr, type ListrTask } from "listr2";
import { NodeSSH, SSHExecCommandResponse } from "node-ssh";
import { basename, join } from "path";
import { type Logger } from "pino";

interface DeployImageConfig {
  /** Docker image name without tag. */
  readonly name: string;
  /** Container user used to own persistent volume data, when applicable. */
  readonly containerUser: string | null;
}

type VolumeOwnerImageConfig = DeployImageConfig & {
  readonly containerUser: string;
};

interface DeployConfig {
  /** Local directory where the Docker image archive is written. */
  readonly outputDirectory: string;
  /** Docker images that must exist locally and be transferred remotely. */
  readonly images: readonly DeployImageConfig[];
  /** Single tar archive containing every Docker image. */
  readonly imageTar: string;
  /** Project-root compose file uploaded to the remote host as-is. */
  readonly composeFile: string;
  /** Local `.env` file uploaded to the remote host. */
  readonly envFile: string;
}

/**
 * Static deploy configuration — centralizes all path and naming constants
 * so they are never scattered across the file as bare string literals.
 */
const DEPLOY_CONFIG = {
  outputDirectory: "dist",
  images: [
    {
      name: "amazon-ring-recorder",
      containerUser: "recorder",
    },
    {
      name: "filebrowser",
      containerUser: null,
    },
  ],
  imageTar: join("dist", "amazon-ring-recorder.tar"),
  composeFile: "docker-compose.yaml",
  envFile: ".env",
} as const satisfies DeployConfig;

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
   * Target Docker platform architecture.
   * Examples: `linux/arm64`, `linux/amd64`, `linux/arm/v7`.
   */
  readonly arch: string;
}

const PrivilegeMode = {
  Root: "root",
  SudoNoPassword: "sudo-nopasswd",
  SudoPassword: "sudo-password",
  None: "none",
} as const;

type PrivilegeMode = (typeof PrivilegeMode)[keyof typeof PrivilegeMode];

/**
 * Privilege escalation mode available on the remote host.
 */
type RemotePrivilege =
  | { readonly mode: typeof PrivilegeMode.Root }
  | {
      readonly mode: typeof PrivilegeMode.SudoNoPassword;
      readonly pty: boolean;
    }
  | {
      readonly mode: typeof PrivilegeMode.SudoPassword;
      readonly password: string;
      readonly pty: boolean;
    }
  | { readonly mode: typeof PrivilegeMode.None };

/**
 * Shared Listr2 context passed between tasks.
 */
interface TaskContext {
  /** Active SSH connection to the remote host. */
  ssh: NodeSSH;
  /** Absolute path of the home directory on the remote host. */
  remoteHome: string;
  /** Privilege escalation strategy detected on the remote host. */
  privilege: RemotePrivilege;
}

/**
 * Type helper to extract the second argument of a Listr task function.
 */
type DeployTaskWrapper = Parameters<ListrTask<TaskContext>["task"]>[1];

/**
 * Quotes a string so it can safely be passed as one POSIX shell argument.
 */
const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

/** Returns a fully-qualified local Docker image reference. */
const imageReference = (image: DeployImageConfig): string =>
  `${image.name}:latest`;

/** Returns the remote path of the single multi-image tar archive. */
const remoteImageTar = (context: TaskContext): string =>
  join(context.remoteHome, basename(DEPLOY_CONFIG.imageTar));

/**
 * Returns the image whose container user should own the persistent data.
 */
const getVolumeOwnerImage = (): VolumeOwnerImageConfig => {
  const image: DeployImageConfig | undefined = DEPLOY_CONFIG.images.find(
    (candidate: DeployImageConfig): boolean =>
      candidate.containerUser !== null,
  );

  if (!image || image.containerUser === null) {
    throw new Error(
      "No Docker image with a container user is configured for volume ownership.",
    );
  }

  return image as VolumeOwnerImageConfig;
};

/**
 * Detects how privileged commands can be executed on the remote host.
 *
 * The remote machine is never reconfigured: no sudoers changes are made.
 */
const detectRemotePrivilege = async (
  ssh: NodeSSH,
  args: DeployArgs,
  task: DeployTaskWrapper,
): Promise<RemotePrivilege> => {
  const uid: SSHExecCommandResponse = await ssh.execCommand("id -u");
  if (uid.code !== 0) {
    throw new Error(`Unable to determine remote UID: ${uid.stderr}`);
  }

  if (uid.stdout.trim() === "0") return { mode: PrivilegeMode.Root };

  const hasSudo: SSHExecCommandResponse =
    await ssh.execCommand("command -v sudo");
  if (hasSudo.code !== 0) return { mode: PrivilegeMode.None };

  const passwordless: SSHExecCommandResponse =
    await ssh.execCommand("sudo -n true");
  if (passwordless.code === 0) {
    return { mode: PrivilegeMode.SudoNoPassword, pty: false };
  }

  // Some sudo configurations require a TTY even for non-interactive use.
  const passwordlessWithPty: SSHExecCommandResponse = await ssh.execCommand(
    "sudo -n true",
    { execOptions: { pty: true } },
  );
  if (passwordlessWithPty.code === 0) {
    return { mode: PrivilegeMode.SudoNoPassword, pty: true };
  }

  const sudoPassword: string = await task
    .prompt(ListrInquirerPromptAdapter)
    .run(password, {
      message: `sudo password for ${args.user}@${args.host}`,
      mask: true,
    });

  const validation: SSHExecCommandResponse = await ssh.execCommand(
    "sudo -S -p '' -v",
    { stdin: `${sudoPassword}\n` },
  );
  if (validation.code === 0) {
    return {
      mode: PrivilegeMode.SudoPassword,
      password: sudoPassword,
      pty: false,
    };
  }

  // Retry with a pseudo-TTY for hosts configured with `requiretty`.
  const validationWithPty: SSHExecCommandResponse = await ssh.execCommand(
    "sudo -S -p '' -v",
    {
      stdin: `${sudoPassword}\n`,
      execOptions: { pty: true },
    },
  );
  if (validationWithPty.code === 0) {
    return {
      mode: PrivilegeMode.SudoPassword,
      password: sudoPassword,
      pty: true,
    };
  }

  throw new Error(
    `Unable to obtain sudo privileges: ${
      validationWithPty.stderr || validation.stderr || "authentication failed"
    }`,
  );
};

interface RemoteExecutionOptions {
  readonly elevated?: boolean;
}

/**
 * Executes a remote SSH command and optionally elevates it to root.
 */
const remoteExecution = async (
  context: TaskContext,
  command: string,
  options: RemoteExecutionOptions = {},
): Promise<string> => {
  let remoteCommand: string = command;
  let stdin: string | undefined;
  let pty = false;

  if (options.elevated && context.privilege.mode !== PrivilegeMode.Root) {
    if (context.privilege.mode === PrivilegeMode.None) {
      throw new Error(
        "Root privileges are required on the remote host, but the SSH " +
          "user is not root and sudo is unavailable.",
      );
    }

    const quotedCommand: string = shellQuote(command);

    if (context.privilege.mode === PrivilegeMode.SudoNoPassword) {
      remoteCommand = `sudo -n -- sh -c ${quotedCommand}`;
      pty = context.privilege.pty;
    } else {
      remoteCommand = `sudo -S -p '' -- sh -c ${quotedCommand}`;
      stdin = `${context.privilege.password}\n`;
      pty = context.privilege.pty;
    }
  }

  const response: SSHExecCommandResponse = await context.ssh.execCommand(
    remoteCommand,
    {
      ...(stdin === undefined ? {} : { stdin }),
      ...(pty ? { execOptions: { pty: true } } : {}),
    },
  );

  if (response.code === 0) return response.stdout;

  throw new Error(
    `Remote command failed (exit ${String(response.code)}): ${response.stderr}`,
  );
};

/**
 * Builds every Docker Compose image for the target architecture and exports
 * all expected images into one Docker tar archive.
 *
 * @param {string} arch - Target Docker platform.
 * @returns {ListrTask[]} Build task list.
 */
const buildTasks = (arch: string): ListrTask[] => [
  {
    title: `Build Docker images (${arch})`,
    task: async (): Promise<void> => {
      await execa(
        "docker",
        ["compose", "-f", DEPLOY_CONFIG.composeFile, "build"],
        {
          env: {
            ...process.env,
            DOCKER_DEFAULT_PLATFORM: arch,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      for (const image of DEPLOY_CONFIG.images) {
        const reference: string = imageReference(image);
        const inspect = await execa(
          "docker",
          ["image", "inspect", reference],
          {
            reject: false,
            stdout: "ignore",
            stderr: "ignore",
          },
        );

        if (inspect.exitCode !== 0) {
          throw new Error(
            `Expected Docker image ${reference} was not produced by ` +
              `${DEPLOY_CONFIG.composeFile}. Ensure the corresponding Compose ` +
              `service declares \`image: ${reference}\` and has a build section.`,
          );
        }
      }
    },
  },
  {
    title: "Export Docker images to archive",
    task: async (): Promise<void> => {
      mkdirSync(DEPLOY_CONFIG.outputDirectory, { recursive: true });

      if (existsSync(DEPLOY_CONFIG.imageTar)) {
        rmSync(DEPLOY_CONFIG.imageTar);
      }

      await execa(
        "docker",
        [
          "save",
          "-o",
          DEPLOY_CONFIG.imageTar,
          ...DEPLOY_CONFIG.images.map(imageReference),
        ],
        { stdout: "ignore", stderr: "pipe" },
      );

      if (!existsSync(DEPLOY_CONFIG.imageTar)) {
        throw new Error("Docker image archive was not created.");
      }

      const sizeMb: string = (
        statSync(DEPLOY_CONFIG.imageTar).size /
        (1024 * 1024)
      ).toFixed(1);

      logger.info(
        {
          imageTar: DEPLOY_CONFIG.imageTar,
          images: DEPLOY_CONFIG.images.map(imageReference),
          arch,
          size: `${sizeMb} MB`,
        },
        "Docker images exported.",
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
    task: async (
      context: TaskContext,
      task: DeployTaskWrapper,
    ): Promise<void> => {
      const ssh: NodeSSH = new NodeSSH();

      await ssh.connect({
        host: args.host,
        port: Number(args.port),
        username: args.user,
        privateKeyPath: args.identityFile,
        readyTimeout: 20000,
      });

      context.ssh = ssh;

      const homeResponse: SSHExecCommandResponse =
        await ssh.execCommand('printf %s "$HOME"');
      if (homeResponse.code !== 0 || homeResponse.stdout.trim() === "") {
        throw new Error(
          `Unable to determine remote home directory: ${homeResponse.stderr}`,
        );
      }

      context.remoteHome = homeResponse.stdout.trim();
      context.privilege = await detectRemotePrivilege(ssh, args, task);

      logger.info(
        {
          host: args.host,
          remoteHome: context.remoteHome,
          privilegeMode: context.privilege.mode,
        },
        "SSH connected.",
      );
    },
  },
];

/**
 * Returns Listr2 tasks that upload the multi-image Docker archive, `.env`,
 * and `docker-compose.yaml` to the remote host.
 *
 * @returns {ListrTask<TaskContext>[]} File upload task list.
 */
const copyFileTasks = (): ListrTask<TaskContext>[] => [
  {
    title: "Upload Docker image archive",
    task: async (context: TaskContext): Promise<void> => {
      await context.ssh.putFile(
        DEPLOY_CONFIG.imageTar,
        remoteImageTar(context),
      );
    },
  },
  {
    title: `Upload ${DEPLOY_CONFIG.envFile} file`,
    task: async (context: TaskContext): Promise<void> => {
      const remoteEnvFile: string = join(
        context.remoteHome,
        DEPLOY_CONFIG.envFile,
      );

      await context.ssh.putFile(DEPLOY_CONFIG.envFile, remoteEnvFile);
      await remoteExecution(context, `chmod 600 ${shellQuote(remoteEnvFile)}`);
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
 * Returns Listr2 tasks that prepare the remote host, load every image from
 * the single tar archive, and fix persistent volume permissions.
 *
 * @returns {ListrTask<TaskContext>[]} Remote setup task list.
 */
const setupRemoteTasks = (): ListrTask<TaskContext>[] => [
  {
    title: "Ensure Docker is installed",
    task: async (context: TaskContext): Promise<void> => {
      const present: boolean = await context.ssh
        .execCommand("command -v docker")
        .then(
          (response: SSHExecCommandResponse): boolean => response.code === 0,
        );

      if (present) return;

      await remoteExecution(
        context,
        "curl -fsSL https://get.docker.com | sh",
        { elevated: true },
      );
    },
  },
  {
    title: "Load Docker images",
    task: async (context: TaskContext): Promise<void> => {
      const archive: string = remoteImageTar(context);

      await remoteExecution(context, `docker load -i ${shellQuote(archive)}`, {
        elevated: true,
      });

      // The tarball was uploaded as the SSH user, so it can be removed without
      // privilege escalation once all images have been loaded.
      await remoteExecution(context, `rm -f ${shellQuote(archive)}`);
    },
  },
  {
    title: "Fix volume permissions",
    task: async (context: TaskContext): Promise<void> => {
      const dataDirectory: string = join(context.remoteHome, "data");
      const recordingsDirectory: string = join(dataDirectory, "recordings");

      // The deployment directory belongs to the SSH user, so creating it does
      // not require root privileges.
      await remoteExecution(
        context,
        `mkdir -p ${shellQuote(dataDirectory)} ${shellQuote(recordingsDirectory)}`,
      );

      const ownerImage: VolumeOwnerImageConfig = getVolumeOwnerImage();
      const containerUser: string = ownerImage.containerUser;

      const uid: string = (
        await remoteExecution(
          context,
          [
            "docker",
            "run",
            "--rm",
            shellQuote(imageReference(ownerImage)),
            "id",
            "-u",
            shellQuote(containerUser),
          ].join(" "),
          { elevated: true },
        )
      ).trim();

      if (!/^\d+$/.test(uid)) {
        throw new Error(
          `Unable to resolve UID for container user ${containerUser} in ` +
            `${imageReference(ownerImage)}: received ${JSON.stringify(uid)}.`,
        );
      }

      await remoteExecution(
        context,
        `chown -R ${uid}:${uid} ${shellQuote(dataDirectory)}`,
        { elevated: true },
      );
    },
  },
];

/**
 * Returns Listr2 tasks that start the containers via `docker compose`.
 *
 * Docker's own service handles auto-restart on boot.
 * `restart: unless-stopped` in the compose file is sufficient.
 *
 * @returns {ListrTask<TaskContext>[]} Service start task list.
 */
const runTasks = (): ListrTask<TaskContext>[] => [
  {
    title: "Start containers",
    task: async (context: TaskContext): Promise<void> => {
      const composeFile: string = join(
        context.remoteHome,
        DEPLOY_CONFIG.composeFile,
      );

      await remoteExecution(
        context,
        [
          "docker",
          "compose",
          "-f",
          shellQuote(composeFile),
          "up",
          "-d",
          "--no-build",
        ].join(" "),
        { elevated: true },
      );
    },
  },
];

/**
 * Waits for the containers to initialize then logs their status.
 *
 * @param {TaskContext} context - Shared deployment context.
 */
const printStatus = async (context: TaskContext): Promise<void> => {
  logger.info("Waiting 3s for container initialization.");
  await new Promise<void>((resolve: () => void) => setTimeout(resolve, 3_000));

  const composeFile: string = join(
    context.remoteHome,
    DEPLOY_CONFIG.composeFile,
  );

  const stdout: string = await remoteExecution(
    context,
    ["docker", "compose", "-f", shellQuote(composeFile), "ps"].join(" "),
    { elevated: true },
  );

  logger.info({ stdout }, "Container status.");
  logger.info(
    { images: DEPLOY_CONFIG.images.map(imageReference) },
    "Deployment complete.",
  );
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
      const context: TaskContext = {
        ssh: new NodeSSH(),
        remoteHome: "",
        privilege: { mode: PrivilegeMode.None },
      };

      logger.info({ args }, "Starting remote deployment.");

      const tasks: Listr<TaskContext> = new Listr<TaskContext>(
        [
          {
            title: `Build (${args.arch})`,
            task: (_: TaskContext, task: DeployTaskWrapper) =>
              task.newListr(buildTasks(args.arch), { concurrent: false }),
          },
          {
            title: "Connect to remote host",
            task: (_: TaskContext, task: DeployTaskWrapper) =>
              task.newListr(connectTasks(args), { concurrent: false }),
          },
          {
            title: "Copy files to remote host",
            task: (_: TaskContext, task: DeployTaskWrapper) =>
              task.newListr(copyFileTasks(), { concurrent: false }),
          },
          {
            title: "Setup remote host",
            task: (_: TaskContext, task: DeployTaskWrapper) =>
              task.newListr(setupRemoteTasks(), { concurrent: false }),
          },
          {
            title: "Run service",
            task: (_: TaskContext, task: DeployTaskWrapper) =>
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
        await printStatus(context);
      } catch (error: unknown) {
        logger.error({ err: error }, "Deployment failed.");
        process.exitCode = 1;
      } finally {
        context.ssh.dispose();
      }
    },
  }),
);
