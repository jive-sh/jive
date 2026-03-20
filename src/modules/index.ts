export { IAuth } from "./auth/interface";
export { AuthImpl } from "./auth/impl";
export { IBun } from "./bun/interface";
export { BunImpl } from "./bun/impl";
export { IDaemon } from "./daemon/interface";
export { DaemonImpl } from "./daemon/impl";
export { IGit } from "./git/interface";
export { GitImpl } from "./git/impl";
export { IGitHub } from "./github/interface";
export { GitHubImpl } from "./github/impl";
export { IHostShell } from "./host-shell/interface";
export { HostShellImpl } from "./host-shell/impl";
export { INpm } from "./npm/interface";
export { NpmImpl } from "./npm/impl";
export { ISsh } from "./ssh/interface";
export { SshImpl } from "./ssh/impl";
export { ITemplates } from "./templates/interface";
export { TemplatesImpl } from "./templates/impl";
export { IToolState, RepoIdentifier } from "./tool-state/interface";
export { ToolStateImpl } from "./tool-state/impl";
export { IYubiKey } from "./yubikey/interface";
export { YubiKeyImpl } from "./yubikey/impl";

import * as e from "effect";
import type { CommandNotFoundError } from "./host-shell/interface";
import type { NotLoggedInError } from "./auth/interface";
import { TOOL_NAME } from "@/constants";
import type { NotInWorkspaceError } from "./tool-state/interface";

export class BadArgumentError extends e.Data.TaggedError("BadArgumentError")<{
  readonly argument: string;
  readonly reason: string;
}> {}

export class BadPreconditionsError extends e.Data.TaggedError("BadPreconditionsError")<{
  readonly cause: string;
  readonly fix: string;
}> {
  public static fromNotInWorkspaceError(err: NotInWorkspaceError) {
    return new BadPreconditionsError({
      cause: `${err.path} is not within a ${TOOL_NAME} workspace.`,
      fix: `Run again from within ${TOOL_NAME} workspace`
    })
  }
  public static fromNotLoggedInError(err: NotLoggedInError) {
    return new BadPreconditionsError({
      cause: `You are not logged in${err.reason ? ` (${err.reason})` : ""}`,
      fix: `Run \`${TOOL_NAME} login\``
    });
  }
  public static fromCommandNotFoundError(err: CommandNotFoundError) {
    return new BadPreconditionsError({
      cause: `Command \`${err.missingCommand}\` is required but was not found`,
      fix: err.installInstructions
    });
  }
  public print(): e.Effect.Effect<void, never, never> {
    return e.pipe(
      e.Effect.log(this.cause),
      e.Effect.andThen(() => this.fix ? e.Effect.succeed(undefined) : e.Effect.log(this.fix))
    )
  }
}
