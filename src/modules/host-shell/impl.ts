import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "node:path";
import { IHostShell, type HostShellCommand, type HostShellCommandResult, type HostShellProcess } from "./interface";

const WINDOWS_EXECUTABLE_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"] as const;

const appendExecutableExtensions = (commandPath: string): string[] => {
  if (process.platform !== "win32" || path.extname(commandPath)) {
    return [commandPath];
  }

  const pathExt = (process.env.PATHEXT ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const extensions = pathExt.length > 0 ? pathExt : [...WINDOWS_EXECUTABLE_EXTENSIONS];
  return [commandPath, ...extensions.map((extension) => `${commandPath}${extension}`)];
};

const resolveCommandCandidates = (command: string): string[] => {
  const directCandidates = appendExecutableExtensions(command);
  if (command.includes("/") || command.includes("\\")) {
    return directCandidates;
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const found = new Set<string>();
  for (const entry of pathEntries) {
    for (const candidate of appendExecutableExtensions(path.join(entry, command))) {
      found.add(candidate);
    }
  }

  return [...found];
};

const applyCommandSpec = (spec: HostShellCommand): ep.Command.Command => {
  let command = ep.Command.make(spec.command, ...spec.args);

  command = e.Option.match(spec.cwd, {
    onNone: () => command,
    onSome: (cwd) => ep.Command.workingDirectory(command, cwd),
  });

  if (Object.keys(spec.env).length > 0) {
    command = ep.Command.env(command, spec.env);
  }

  command = e.Option.match(spec.shell, {
    onNone: () => command,
    onSome: (shell) => ep.Command.runInShell(command, shell),
  });

  switch (spec.stdin) {
    case "inherit":
      command = ep.Command.stdin(command, "inherit");
      break;
    case "ignore":
      command = ep.Command.stdin(command, e.Stream.empty);
      break;
  }

  switch (spec.stdout) {
    case "inherit":
      command = ep.Command.stdout(command, "inherit");
      break;
  }

  switch (spec.stderr) {
    case "inherit":
      command = ep.Command.stderr(command, "inherit");
      break;
  }

  return command;
};

const collectStream = (
  stream: e.Stream.Stream<string, ep.Error.PlatformError>,
): e.Effect.Effect<string, ep.Error.PlatformError> =>
  e.pipe(
    stream,
    e.Stream.runFold("", (output, chunk) => output + chunk),
  );

export const HostShellImpl = e.Layer.effect(IHostShell, e.Effect.gen(function*() {
  const fileSystem = yield* ep.FileSystem.FileSystem;
  const commandExecutor = yield* ep.CommandExecutor.CommandExecutor;

  const isRunnableFile = e.Effect.fn(function*(candidatePath: string) {
    const accessible = yield* fileSystem.access(candidatePath, { ok: true }).pipe(
      e.Effect.as(true),
      e.Effect.catchAll(() => e.Effect.succeed(false)),
    );
    if (!accessible) return false;

    return yield* fileSystem.stat(candidatePath).pipe(
      e.Effect.map((info) => info.type !== "Directory"),
      e.Effect.catchAll(() => e.Effect.succeed(false)),
    );
  });

  const findCommand = e.Effect.fn(function*(command: string) {
    const candidates = resolveCommandCandidates(command);
    for (const candidate of candidates) {
      const runnable = yield* isRunnableFile(candidate);
      if (runnable) {
        return e.Option.some(candidate);
      }
    }

    return e.Option.none<string>();
  });

  const commandExists = e.Effect.fn(function*(command: string) {
    return e.Option.isSome(yield* findCommand(command));
  });

  const missingCommands = e.Effect.fn(function*(commands: readonly string[]) {
    const missing: string[] = [];
    const seen = new Set<string>();

    for (const command of commands) {
      if (seen.has(command)) continue;
      seen.add(command);

      const exists = yield* commandExists(command);
      if (!exists) missing.push(command);
    }

    return missing;
  });

  const start = e.Effect.fn(function*(spec: HostShellCommand) {
    const process = yield* commandExecutor.start(applyCommandSpec(spec));

    if (spec.stdout === "ignore") {
      yield* e.Effect.forkScoped(e.pipe(process.stdout, e.Stream.runDrain));
    }

    if (spec.stderr === "ignore") {
      yield* e.Effect.forkScoped(e.pipe(process.stderr, e.Stream.runDrain));
    }

    return {
      exitCode: e.Effect.map(process.exitCode, Number),
      stdout: spec.stdout === "pipe"
        ? e.Option.some(e.pipe(process.stdout, e.Stream.decodeText()))
        : e.Option.none(),
      stderr: spec.stderr === "pipe"
        ? e.Option.some(e.pipe(process.stderr, e.Stream.decodeText()))
        : e.Option.none(),
    } satisfies HostShellProcess;
  });

  const run = e.Effect.fn(function*(spec: HostShellCommand) {
    return yield* e.Effect.scoped(
      e.Effect.gen(function*() {
        const process = yield* start(spec);
        const stdout = e.Option.isSome(process.stdout)
          ? yield* collectStream(process.stdout.value)
          : "";
        const stderr = e.Option.isSome(process.stderr)
          ? yield* collectStream(process.stderr.value)
          : "";
        const exitCode = yield* process.exitCode;

        return { exitCode, stdout, stderr } satisfies HostShellCommandResult;
      }),
    );
  });

  return {
    requiredCLICommands: [],
    findCommand,
    commandExists,
    missingCommands,
    start,
    run,
  };
}));
