import * as e from "effect";
import { Cli } from "jive-abstract-library";
import { TOOL_NAME } from "@/constants";
import type { NotLoggedInError } from "@/modules/auth/interface";
import type { NotInWorkspaceError } from "@/modules/tool-state/interface";

export class BadArgumentError extends e.Data.TaggedError("BadArgumentError")<{
  readonly argument: string;
  readonly reason: string;
}> {
  /** Prints the error for the person who ran the command, then stops the CLI with exit code 1. */
  public report(): e.Effect.Effect<never, Cli.CliError> {
    const message = `Invalid ${this.argument}: ${this.reason}`;
    return e.Effect.andThen(e.Effect.logError(message), e.Effect.fail(new Cli.CliError({ message, exitCode: 1 })));
  }
}

export class BadPreconditionsError extends e.Data.TaggedError("BadPreconditionsError")<{
  readonly cause: string;
  readonly fix: string;
}> {
  public static withoutFix(cause: string, message?: string) {
    return new BadPreconditionsError({
      cause,
      fix: `Report bug to ${TOOL_NAME} maintainers${message ? `; internal error: ${message}` : ""}`
    });
  }
  public static fromNotInWorkspaceError(err: NotInWorkspaceError) {
    return new BadPreconditionsError({
      cause: `${err.path} is not within a ${TOOL_NAME} workspace.`,
      fix: `Run again from within ${TOOL_NAME} workspace`
    });
  }
  public static fromNotLoggedInError(err: NotLoggedInError) {
    return new BadPreconditionsError({
      cause: `You are not logged in${err.reason ? ` (${err.reason})` : ""}`,
      fix: `Run \`${TOOL_NAME} login\``
    });
  }
  public static commandNotFound(command: string) {
    return new BadPreconditionsError({
      cause: `Command \`${command}\` is required but was not found`,
      fix: `Install \`${command}\` and ensure it is on PATH.`,
    });
  }
  /** Prints the cause and, when there is one, the fix, then stops the CLI with exit code 1. */
  public report(): e.Effect.Effect<never, Cli.CliError> {
    const message = this.fix ? `${this.cause}\nFix: ${this.fix}` : this.cause;
    return e.Effect.andThen(e.Effect.logError(message), e.Effect.fail(new Cli.CliError({ message, exitCode: 1 })));
  }
}
