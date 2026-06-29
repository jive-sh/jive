import * as e from "effect";
import type { BadArgumentError, BadPreconditionsError, RepoIdentifier } from "@/modules";

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

export type IN = e.Data.TaggedEnum<{
  Repo: {repo: RepoIdentifier;};
  WorkspaceRoot: {};
  AbsoluteDirectory: {absolute: string;};
  RelativeDirectory: {relative: string;};
}>;
export const IN = e.Data.taggedEnum<IN>();

export interface IHostShell {
  cliArgEncode(argument: string): string;
  readonly run: <R = never> (
    cmd: string,
    args: string,
    at: IN,
    opts?: {
      usingBunShell?: boolean;
      withEnv?: Record<string, string>;
      withPathValidator?: (cmdPath: string, platform: HostPlatform) => e.Effect.Effect<void, CommandNotFoundError, R>;
    }) => {
    captureOutput: e.Effect.Effect<{stdout: string; stderr: string;}, BadArgumentError | BadPreconditionsError, R>;
    inheritIO: e.Effect.Effect<void, BadArgumentError | BadPreconditionsError, R>;
  }
  readonly platform: HostPlatform;
  readonly openUrl: (url: string) => e.Effect.Effect<void, BadPreconditionsError>;
}
