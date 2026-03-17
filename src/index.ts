import * as e from "effect";
import { ModulesImpl } from "@/modules/runtime";
import { program } from "@/program";
import { CLI } from "./temp-libs/cli";

e.pipe(
  program,
  e.Effect.provide(ModulesImpl),
  e.Effect.catchTag("CommandNotFoundError", err => {
    if (CLI.isAutocompleteRequest()) {
      return e.Effect.succeed(undefined);
    } else {
      return e.Effect.fail(err);
    }
  }),
  e.Effect.runPromiseExit
).then((exit) => {
  if (e.Exit.isFailure(exit)) {
    process.exit(1);
  }
});
