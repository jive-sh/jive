import * as e from "effect";

export class IDaemon extends e.Context.Tag("IDaemon")<IDaemon, {
  readonly requiredCLICommands: readonly string[];
  readonly start: e.Effect.Effect<void>;
}>() {}
