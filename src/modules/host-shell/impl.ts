import * as e from "effect";
import * as ep from "@effect/platform";
import { CommandNotFoundError, HostPlatform, IHostShell, IN } from "./interface";
import { BadArgumentError, BadPreconditionsError, IToolState } from "@/modules";
import { TOOL_NAME } from "@/constants";
import * as path from "node:path";
import { magenta } from "@/logging";
import { $ } from "bun";

function getPlatform(platform: string): HostPlatform {
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
  const toolState = yield* IToolState;
  const commandExecutor = yield* ep.CommandExecutor.CommandExecutor;
  const platform = getPlatform(process.platform);
  const fileSystem = yield* ep.FileSystem.FileSystem;

  return {
    platform,
    openUrl: e.Effect.fn(function*(url: string) {
      return yield* e.Effect.die(undefined);
      /*const spec = openUrlSpec(platform, url);
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
          e.Effect.catchTag("BadArgument", )
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
      */
    }),
    run: (cmd, args, at, opts) => {
      const execString = magenta(`${cmd} ${args}`);

      const assertIsDirectory = e.Effect.fn(function*(dir: string) {
        const notADirectoryError = new BadPreconditionsError({
          cause: `${dir} is not a directory`,
          fix: `Rerun ${execString} from a valid directory`
        });
        yield* e.Effect.fn(function*() {
          const exists = yield* fileSystem.exists(dir);
          if (!exists) return yield* notADirectoryError;
          const isDirectory = (yield* fileSystem.stat(dir)).type === "Directory";
          if (!isDirectory) return yield* notADirectoryError;
        }, e.flow(
          e.Effect.catchTag("BadArgument", "SystemError", ({message, name}) => new BadPreconditionsError({
            cause: `Unexpected ${name} accessing ${dir}`,
            fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
          })),
        ))();
      });

      const assertInWorkspace = e.Effect.fn(function*(dir: string) {
        const { workspaceRoot } = yield* toolState.assertInWorkspace;
        const relative = path.relative(workspaceRoot, dir);
        const withinWorkspace = (relative || relative === "") && !relative.startsWith('..') && !path.isAbsolute(relative);
        if (!withinWorkspace) return yield* new BadArgumentError({
          argument: "directory",
          reason: `Cannot run any commands (e.g. ${execString}) outside workspace ${workspaceRoot}; ${dir} is outside.`
        });
      }, e.flow(
        e.Effect.catchTag("NotInWorkspaceError", BadPreconditionsError.fromNotInWorkspaceError)
      ));

      const directory = e.Effect.gen(function*() {
        return yield* e.pipe(
          at,
          IN.$match({
            AbsoluteDirectory: e.Effect.fn(function*({absolute: dir}) {
              if (!path.isAbsolute(dir)) return yield* new BadArgumentError({
                argument: "directory",
                reason: `Directory ${dir} is not an absolute directory even though it was passed as one.`
              });
              yield* assertIsDirectory(dir);
              yield* assertInWorkspace(dir);
              return dir;
            }),
            RelativeDirectory: e.Effect.fn(function*({relative: dir}) {
              if (path.isAbsolute(dir)) return yield* new BadArgumentError({
                argument: "directory",
                reason: `Directory ${dir} is not a relative directory even though it was passed as one.`
              })
              const { workspaceRoot } = yield* toolState.assertInWorkspace;
              const resolvedDir = path.resolve(workspaceRoot, dir);
              yield* assertIsDirectory(resolvedDir);
              yield* assertInWorkspace(resolvedDir);
              return resolvedDir;
            }, e.flow(
              e.Effect.catchTag("NotInWorkspaceError", BadPreconditionsError.fromNotInWorkspaceError)
            )),
            Repo: e.Effect.fn(function*({repo}) {
              const {absolutePath} = yield* toolState.verifyRepoIntegrity(repo);
              return absolutePath;
            }),
            WorkspaceRoot: e.Effect.fn(function*() {
              const { workspaceRoot } = yield* toolState.assertInWorkspace;
              return workspaceRoot;
            }, e.flow(
              e.Effect.catchTag("NotInWorkspaceError", BadPreconditionsError.fromNotInWorkspaceError)
            ))
          })
        )
      });

      const validateCommand = e.Effect.fn(function*(command: string) {
        const maybeCommandPath = e.Option.fromNullable(Bun.which(command));
        if (e.Option.isNone(maybeCommandPath)) {
          return yield* BadPreconditionsError.fromCommandNotFoundError(new CommandNotFoundError({
            missingCommand: command,
            installInstructions: `Install \`${command}\` and ensure it is on PATH.`,
          }));
        }
        return {
          command,
          path: maybeCommandPath.value,
        };
      });

      const getProcess = e.Effect.fn(function*(inheritIO: boolean) {
        const { command, path } = yield* validateCommand(cmd);
        if (opts?.withPathValidator) {
          yield* e.pipe(
            opts.withPathValidator(path, platform),
            e.Effect.catchTag("CommandNotFoundError", BadPreconditionsError.fromCommandNotFoundError)
          );
        }
        const proc = e.pipe(
          // TODO: this split by " " method might not work for cases where a multiword arg is present (string with spaces enclosed in quotes)
          ep.Command.make(command, ...args.split(" ")),
          ep.Command.workingDirectory(yield* directory),
          ep.Command.env(opts?.withEnv ?? process.env)
        );
        if (inheritIO) {
          return yield* e.pipe(
            proc,
            ep.Command.stdin("inherit"),
            ep.Command.stdout("inherit"),
            ep.Command.stderr("inherit"),
            commandExecutor.start,
          )
        } else {
          return yield* e.pipe(
            proc,
            ep.Command.stdin(e.Stream.empty),
            ep.Command.stdout("pipe"),
            ep.Command.stderr("pipe"),
            commandExecutor.start
          );
        }
      }, e.flow(
        e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new BadPreconditionsError({
          cause: `Unexpected ${name} running ${execString}`,
          fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
        }))
      ));

      return {
        inheritIO: e.Effect.scoped(e.Effect.gen(function*() {
          yield* e.Effect.log(`Running ${execString}`);
          if (opts?.usingBunShell) { 
            const {exitCode} = yield* e.pipe(
              e.Effect.tryPromise(() => $`${cmd} ${args}`),
              e.Effect.catchTag("UnknownException", ({name, message}) => new BadPreconditionsError({
                cause: `Failed to execute ${execString} due to unexpected ${name}`,
                fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
              }))
            );
            if (exitCode !== 0) return yield* e.Effect.dieMessage(`${execString} exited with code ${exitCode}`);
          } else {
            const exitCode = yield* e.pipe(
              getProcess(true),
              e.Effect.flatMap(proc => proc.exitCode),
              e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new BadPreconditionsError({
                cause: `Unexpected ${name} running ${execString}`,
                fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
              }))
            );
            if (exitCode !== 0) return yield* e.Effect.dieMessage(`${execString} exited with code ${exitCode}`);
          }
        })),
        captureOutput: e.Effect.scoped(e.Effect.fn(function*() {
          yield* e.Effect.log(`Running ${execString}`);
          if (opts?.usingBunShell) {
            const stdoutCapture = new Response();
            const stderrCapture = new Response();
            const {exitCode, stdout, stderr} = yield* e.pipe(
              e.Effect.tryPromise(() => $`${cmd} ${args} < ${null} > ${stdoutCapture} 2> ${stderrCapture}`.quiet()),
              e.Effect.flatMap(e.Effect.fn(function*({exitCode}) {
                const stdout = yield* e.Effect.tryPromise(() => stdoutCapture.text());
                const stderr = yield* e.Effect.tryPromise(() => stderrCapture.text());
                return {
                  stdout,
                  stderr,
                  exitCode
                }
              })),
              e.Effect.catchTag("UnknownException", ({name, message}) => new BadPreconditionsError({
                cause: `Failed to execute ${execString} due to unexpected ${name}`,
                fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
              }))
            );
            if (exitCode !== 0) {
              yield* e.Effect.log(stdout);
              yield* e.Effect.log(stderr);
              return yield* e.Effect.dieMessage(`${execString} exited with exit code ${exitCode}`);
            }
            return {stderr, stdout};
          } else {
            const proc = yield* getProcess(false);
            const exitCode = yield* proc.exitCode;
            const stdout = yield* e.pipe(
              proc.stdout,
              e.Stream.runFold("", (output, chunk) => output + chunk)
            );
            const stderr = yield* e.pipe(
              proc.stderr,
              e.Stream.runFold("", (output, chunk) => output + chunk)
            );
            if (exitCode !== 0) {
              yield* e.Effect.log(stdout);
              yield* e.Effect.log(stderr);
              return yield* e.Effect.dieMessage(`${execString} exited with exit code ${exitCode}`);
            }
            return {
              stdout,
              stderr
            };
          }
        }, e.flow(
          e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new BadPreconditionsError({
            cause: `Unexpected ${name} running ${execString}`,
            fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
          }))
        ))())
      }
    }
  };
}));
