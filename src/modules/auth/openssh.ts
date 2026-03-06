import * as e from "effect";

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const logWarningSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.logWarning(...message));
};
const logErrorSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.logError(...message));
};

const REQUIRED_OPENSSH_COMMANDS = ["ssh-keygen", "ssh-add"] as const;
let didWarnAtStartup = false;

type SpawnIo = "inherit" | "ignore" | "pipe";
type OpenSshCommand = (typeof REQUIRED_OPENSSH_COMMANDS)[number];

interface OpenSshSpawnOptions {
  cwd?: string;
  stdin?: SpawnIo;
  stdout?: SpawnIo;
  stderr?: SpawnIo;
}

export function ensureOpenSshForLogin(): boolean {
  const missing = listMissingOpenSshCommands();
  if (missing.length === 0) return true;

  printMissingOpenSshWarnings(
    missing,
    `jive login requires OpenSSH commands in PATH: ${REQUIRED_OPENSSH_COMMANDS.join(", ")}`,
    logErrorSync,
  );

  return false;
}

export function warnOnMissingOpenSshAtStartup(): void {
  if (didWarnAtStartup) return;
  didWarnAtStartup = true;

  const missing = listMissingOpenSshCommands();
  if (missing.length === 0) return;

  printMissingOpenSshWarnings(
    missing,
    "missing OpenSSH commands detected; `jive login` may not work until installed",
    logWarningSync,
  );
}

export function runOpenSshCommand(
  command: OpenSshCommand,
  args: string[],
  options: OpenSshSpawnOptions = {},
): e.Option.Option<ReturnType<typeof Bun.spawnSync>> {
  const commandPath = Bun.which(command);
  if (!commandPath) return e.Option.none();

  return e.Option.some(
    Bun.spawnSync([commandPath, ...args], {
      cwd: options.cwd,
      stdin: options.stdin ?? "inherit",
      stdout: options.stdout ?? "inherit",
      stderr: options.stderr ?? "inherit",
    }),
  );
}

function listMissingOpenSshCommands(): OpenSshCommand[] {
  return REQUIRED_OPENSSH_COMMANDS.filter((command) => !Bun.which(command));
}

function printMissingOpenSshWarnings(
  missing: OpenSshCommand[],
  header: string,
  out: (...message: ReadonlyArray<unknown>) => void,
): void {
  out(yellow(`WARNING: ${header}`));
  out(yellow(`WARNING: missing ${missing.join(", ")}`));

  for (const line of platformInstallHints()) {
    out(yellow(`WARNING: ${line}`));
  }
}

function platformInstallHints(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "macOS usually includes OpenSSH already.",
        "If missing, run: xcode-select --install",
      ];
    case "linux":
      return [
        "Install OpenSSH client from your distro package manager.",
        "Examples: sudo apt install openssh-client OR sudo dnf install openssh-clients",
      ];
    case "win32":
      return [
        "Enable Windows OpenSSH Client feature.",
        "Settings -> Optional Features -> Add a feature -> OpenSSH Client",
      ];
    default:
      return [
        "Install OpenSSH client tools and ensure ssh-keygen and ssh-add are on PATH.",
      ];
  }
}
