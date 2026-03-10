import * as e from "effect";
import { ModulesImpl } from "@/modules/runtime";
import { program } from "@/program";

e.pipe(
  program,
  e.Effect.catchTag("MissingDependenciesError", e.Effect.fn(function* ({missingDependencies}) {
    yield* e.Effect.logError(`Missing required CLIs in this environment: ${missingDependencies.join(", ")}`);
    return;
  })),
  e.Effect.provide(ModulesImpl),
  e.Effect.runPromiseExit
).then((exit) => {
  if (e.Exit.isFailure(exit)) {
    process.exit(1);
  }
});
