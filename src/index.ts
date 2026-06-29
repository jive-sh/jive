import * as e from "effect";
import { ModulesImpl } from "@/modules/runtime";
import { program } from "@/program";
import { CLI } from "./temp-libs/cli";

const runnable: e.Effect.Effect<void, never, never> = e.pipe(
  program,
  e.Effect.provide(ModulesImpl),
);

e.Effect
  .runPromiseExit(runnable)
  .then((exit) => {
    if (e.Exit.isSuccess(exit)) {
      return;
    }
    if (e.Exit.isFailure(exit)) {
      console.log(exit);
      process.exit(1);
    }
  });
