import { Effect, Layer, Option, PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { parseHelp } from "./help";
import { JiveCli, JiveCliHelpUnreadable, type CliCommand, type IJiveCli } from "./interface";

class JiveCliImpl implements IJiveCli {
  constructor(private readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) {}

  *commands(input: { readonly entrypoint: string; readonly cwd: string }) {
    return yield* this.commandsUnder(input, []);
  }

  private *commandsUnder(
    input: { readonly entrypoint: string; readonly cwd: string },
    words: ReadonlyArray<string>,
  ): Effect.fn.Return<ReadonlyArray<CliCommand>, JiveCliHelpUnreadable | PlatformError.PlatformError> {
    const output = yield* this.spawner.string(
      ChildProcess.make("bun", [input.entrypoint, ...words, "--help"], { cwd: input.cwd }),
      { includeStderr: true },
    );
    const listings = parseHelp(output);
    if (Option.isNone(listings)) {
      return yield* new JiveCliHelpUnreadable({ command: ["jive", ...words, "--help"].join(" "), output });
    }
    return yield* Effect.forEach(
      listings.value,
      (listing) => {
        const childWords = [...words, listing.name];
        return Effect.map(
          Effect.gen(() => this.commandsUnder(input, childWords)),
          (subcommands): CliCommand => ({ words: childWords, description: listing.description, subcommands }),
        );
      },
      { concurrency: 8 },
    );
  }
}

export const JiveCliLive = Layer.effect(
  JiveCli,
  Effect.gen(function* () {
    return new JiveCliImpl(yield* ChildProcessSpawner.ChildProcessSpawner);
  }),
);
