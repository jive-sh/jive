import * as e from "effect";
import * as modules from "@/modules";
import { IN } from "@/modules/host-shell/interface";

export const BunImpl = e.Layer.effect(modules.IBun, e.Effect.gen(function*() {
  const hostShell = yield* modules.IHostShell;

  return {
    install: e.Effect.fn(function*(repo) {
      yield* hostShell.run("bun", "install", IN.Repo({repo})).inheritIO;
    }),
    link: e.Effect.fn(function*(repo) {
      yield* hostShell.run("bun", "link", IN.Repo({repo})).inheritIO;
    }),
    unlink: e.Effect.fn(function*(repo) {
      yield* hostShell.run("bun", "unlink", IN.Repo({repo})).inheritIO;
    }),
  };
}));
