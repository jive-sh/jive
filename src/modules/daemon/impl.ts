import * as e from "effect";
import * as modules from "@/modules";

export const DaemonImpl = e.Layer.effect(modules.IDaemon, e.Effect.gen(function*() {
  return {
    requiredCLICommands: [],
    start: e.Effect.fn(function*() {
      yield* e.Effect.log("Daemon not yet implemented.");
    })(),
  };
}));
