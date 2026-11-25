import * as e from "effect";
import { Cli } from "jive-abstract-library";
import { TOOL_NAME } from "@/constants";
import type { NotInWorkspaceError } from "@/modules/tool-state/interface";

/** No Jive session on this machine, or the server no longer honours it. */
export class NotLoggedInError extends e.Data.TaggedError("NotLoggedInError")<{
  readonly reason?: string;
}> {}

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

/**
 * The words after `command` are not the ones it takes. The entrypoint prints that command's help, as `--help` does,
 * before `report`.
 */
export class UsageError extends e.Data.TaggedError("UsageError")<{
  readonly command: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}> {
  /**
   * Prints each problem, then stops the CLI with exit code 2, the one jive-abstract-library's `Cli` gives words it
   * can't run.
   */
  public report(): e.Effect.Effect<never, Cli.CliError> {
    return e.Effect.andThen(
      e.Effect.forEach(this.problems, (problem) => e.Effect.logError(problem), { discard: true }),
      e.Effect.fail(new Cli.CliError({ message: this.problems.join("\n"), exitCode: 2 })),
    );
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
      cause: `${err.path} is in no git repository, and a ${TOOL_NAME} workspace is the nearest git repository from where it runs`,
      fix: `Run this inside the repository, or \`${TOOL_NAME} init\` to make this folder one`
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
