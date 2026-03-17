import * as e from "effect";
import * as ep from "@effect/platform";
import { CommandNotFoundError, HostPlatform, IHostShell, type RunOptions, type VerifiedCommand } from "./interface";

function hostPlatformFromNodePlatform(platform: string): HostPlatform {
  switch (platform) {
    case "darwin":
      return HostPlatform.MacOs();
    case "win32":
      return HostPlatform.Windows();
    case "linux":
      return HostPlatform.Linux();
    default:
      return HostPlatform.Other();
  }
}

function openUrlSpec(platform: HostPlatform, url: string): e.Option.Option<{ command: string; args: readonly string[] }> {
  return e.Match.value(platform).pipe(
    e.Match.tag("MacOs", () => e.Option.some({ command: "open", args: [url] })),
    e.Match.tag("Windows", () => e.Option.some({ command: "cmd", args: ["/c", "start", "", url] })),
    e.Match.tag("Linux", () => e.Option.some({ command: "xdg-open", args: [url] })),
    e.Match.tag("Other", () => e.Option.none()),
    e.Match.exhaustive,
  );
}

export const HostShellImpl = e.Layer.effect(IHostShell, e.Effect.gen(function*() {
  const commandExecutor = yield* ep.CommandExecutor.CommandExecutor;
  const platform = hostPlatformFromNodePlatform(process.platform);
  const commandPath = (command: string) => e.Option.fromNullable(Bun.which(command));

  return {
    getCommand: e.Effect.fn(function*(command: string) {
      const maybeCommandPath = commandPath(command);
      if (e.Option.isNone(maybeCommandPath)) {
        return yield* new CommandNotFoundError({
          missingCommand: command,
          installInstructions: `Install \`${command}\` and ensure it is on PATH.`,
        });
      }

      return {
        command,
        path: maybeCommandPath.value,
      };
    }),
    platform,
    openUrl: e.Effect.fn(function*(url: string) {
      const spec = openUrlSpec(platform, url);
      if (e.Option.isNone(spec)) return false;
      if (e.Option.isNone(commandPath(spec.value.command))) return false;

      const result = yield* e.Effect.scoped(e.Effect.gen(function*() {
        // TODO: switch tool to ink and node-pty all sub CLI invocations for direct control over piping
        const proc = yield* e.pipe(
          ep.Command.make(spec.value.command, ...spec.value.args),
          ep.Command.workingDirectory(process.cwd()),
          ep.Command.env({}),
          ep.Command.stdin(e.Stream.empty),
          ep.Command.stdout("pipe"),
          ep.Command.stderr("pipe"),
          commandExecutor.start,
        );
        const exitCode: number = yield* proc.exitCode;
        const stdout = yield* e.pipe(
          proc.stdout,
          e.Stream.runFold("", (output, chunk) => output + chunk),
        );
        const stderr = yield* e.pipe(
          proc.stderr,
          e.Stream.runFold("", (output, chunk) => output + chunk),
        );
        return {
          stdout,
          stderr,
          exitCode,
        };
      })).pipe(
        e.Effect.map(e.Option.some),
        e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
      );

      return e.Option.isSome(result) && result.value.exitCode === 0;
    }),
    runInheritIO: (opts: RunOptions) =>
      e.Effect.fn(function*({ command }: VerifiedCommand) {
        return yield* e.Effect.scoped(e.Effect.gen(function*() {
          const proc = yield* e.pipe(
            ep.Command.make(command, ...opts.args),
            ep.Command.workingDirectory(opts.runInDir ?? process.cwd()),
            ep.Command.env(opts.env ?? process.env),
            ep.Command.stdin("inherit"),
            ep.Command.stdout("inherit"),
            ep.Command.stderr("inherit"),
            commandExecutor.start,
          );
          const exitCode: number = yield* proc.exitCode;
          return { exitCode };
        }));
      }),
    run: (opts: RunOptions) =>
      e.Effect.fn(function*({ command }: VerifiedCommand) {
        return yield* e.Effect.scoped(e.Effect.gen(function*() {
          // TODO: switch tool to ink and node-pty all sub CLI invocations for direct control over piping
          const proc = yield* e.pipe(
            ep.Command.make(command, ...opts.args),
            ep.Command.workingDirectory(opts.runInDir ?? process.cwd()),
            ep.Command.env(opts.env ?? process.env),
            ep.Command.stdin(e.Stream.empty),
            ep.Command.stdout("pipe"),
            ep.Command.stderr("pipe"),
            commandExecutor.start,
          );
          const exitCode: number = yield* proc.exitCode;
          const stdout = yield* e.pipe(
            proc.stdout,
            e.Stream.runFold("", (output, chunk) => output + chunk),
          );
          const stderr = yield* e.pipe(
            proc.stderr,
            e.Stream.runFold("", (output, chunk) => output + chunk),
          );
          return {
            stdout,
            stderr,
            exitCode,
          };
        }));
      }),
  };
}));
