import * as e from "effect";
import * as ep from "@effect/platform";

export class CommandNotFoundError extends e.Data.TaggedError("CommandNotFoundError")<{
  missingCommand: string;
  installInstructions: string;
}> {}

export type HostPlatform = e.Data.TaggedEnum<{
  MacOs: {},
  Windows: {},
  Linux: {},
  Other: {}
}>;
export const HostPlatform = e.Data.taggedEnum<HostPlatform>();

export interface RunOptions {
  readonly args: readonly string[];
  readonly runInDir?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface VerifiedCommand {
  command: string;
  path: string;
}

export class IHostShell extends e.Context.Tag("IHostShell")<IHostShell, {
  readonly getCommand: (command: string) => e.Effect.Effect<VerifiedCommand, CommandNotFoundError>;
  readonly platform: HostPlatform;
  readonly openUrl: (url: string) => e.Effect.Effect<boolean>;
  readonly runInheritIO: (opts: RunOptions) => (verifiedCommand: VerifiedCommand) => e.Effect.Effect<{exitCode: number}, ep.Error.PlatformError>;
  readonly run: (opts: RunOptions) => (verifiedCommand: VerifiedCommand) => e.Effect.Effect<{exitCode: number; stderr: string; stdout: string;}, ep.Error.PlatformError>;
}>() {}
