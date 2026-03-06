import * as e from "effect";
import { IDaemon } from "@/modules";

export const DaemonImpl = e.Layer.effect(IDaemon, e.Effect.gen(function*() {
  return {
    start: e.Effect.fn(function*() {
      yield* e.Effect.log("Daemon not yet implemented.");
    })(),
  };
}));
