import * as e from "effect";

export class IDaemon extends e.Context.Tag("IDaemon")<IDaemon, {
  readonly start: e.Effect.Effect<void>;
}>() {}
