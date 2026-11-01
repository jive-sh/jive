import { Context, Data } from "effect";
import type { Effect, Option, PlatformError } from "effect";

/** One command the jive CLI's help lists. */
export interface CliCommand {
  /** The words after `jive`: ["git", "setup"]. */
  readonly words: ReadonlyArray<string>;
  readonly description: Option.Option<string>;
  /** Present when the command is a group, like `jive git`. */
  readonly subcommands: ReadonlyArray<CliCommand>;
}

/** `jive … --help` printed something that is not help, such as a crash. */
export class JiveCliHelpUnreadable extends Data.TaggedError("JiveCliHelpUnreadable")<{
  readonly command: string;
  readonly output: string;
}> {}

export interface IJiveCli {
  /** Every command `bun <entrypoint> --help` lists, run in `cwd`, with each group's subcommands from its own help. */
  commands(input: {
    readonly entrypoint: string;
    readonly cwd: string;
  }): Effect.fn.Return<ReadonlyArray<CliCommand>, JiveCliHelpUnreadable | PlatformError.PlatformError>;
}

export class JiveCli extends Context.Service<JiveCli, IJiveCli>()("JiveCli") {}
