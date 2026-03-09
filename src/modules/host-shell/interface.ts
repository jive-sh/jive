import * as e from "effect";
import * as ep from "@effect/platform";

export type HostShellInput = "inherit" | "ignore";
export type HostShellOutput = "inherit" | "ignore" | "pipe";

export interface HostShellCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: e.Option.Option<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: HostShellInput;
  readonly stdout: HostShellOutput;
  readonly stderr: HostShellOutput;
  readonly shell: e.Option.Option<boolean | string>;
}

export interface HostShellProcess {
  readonly exitCode: e.Effect.Effect<number, ep.Error.PlatformError>;
  readonly stdout: e.Option.Option<e.Stream.Stream<string, ep.Error.PlatformError>>;
  readonly stderr: e.Option.Option<e.Stream.Stream<string, ep.Error.PlatformError>>;
}

export interface HostShellCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class IHostShell extends e.Context.Tag("IHostShell")<IHostShell, {
  readonly requiredCLICommands: readonly string[];
  readonly findCommand: (command: string) => e.Effect.Effect<e.Option.Option<string>>;
  readonly commandExists: (command: string) => e.Effect.Effect<boolean>;
  readonly missingCommands: (commands: readonly string[]) => e.Effect.Effect<string[]>;
  readonly start: (command: HostShellCommand) => e.Effect.Effect<HostShellProcess, ep.Error.PlatformError, e.Scope.Scope>;
  readonly run: (command: HostShellCommand) => e.Effect.Effect<HostShellCommandResult, ep.Error.PlatformError>;
}>() {}
