import { Data, Effect, pipe } from "effect";
import type { CommandNotFoundError } from "../modules/host-shell/interface";
import type { NotLoggedInError } from "../modules/auth/interface";
import { TOOL_NAME } from "@/constants";
import type { NotInWorkspaceError } from "../modules/tool-state/interface";

export class BadArgumentError extends Data.TaggedError("BadArgumentError")<{
  readonly argument: string;
  readonly reason: string;
}> {}

export class BadPreconditionsError extends Data.TaggedError("BadPreconditionsError")<{
  readonly cause: string;
  readonly fix: string;
}> {
  public static withoutFix(cause: string, message?: string) {
    return new BadPreconditionsError({
      cause,
      fix: `Report bug to ${TOOL_NAME} maintainers${message ? `; internal error: ${message}` : ""}`
    })
  }
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
  public print(): Effect.Effect<void, never, never> {
    return pipe(
      Effect.log(this.cause),
      Effect.andThen(() => this.fix ? Effect.succeed(undefined) : Effect.log(this.fix))
    )
  }
}
