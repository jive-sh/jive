import * as e from "effect";
import { ModulesImpl } from "@/modules/runtime";
import { PlainTextLogger } from "@/logging";
import { program } from "@/program";

const handled = e.pipe(
  program,
  e.Effect.catchTag("MissingDependenciesError", e.Effect.fn(function* ({missingDependencies}) {
    yield* e.Effect.logError(`Missing required CLIs in this environment: ${missingDependencies.join(", ")}`);
    return;
  })),
);

const main = e.pipe(
  handled,
  e.Effect.tapErrorCause((cause) => e.Effect.logError(e.Cause.pretty(cause))),
  e.Effect.provide(ModulesImpl),
  e.Effect.provide(PlainTextLogger),
);

void e.Effect.runPromiseExit(main).then((exit) => {
  if (e.Exit.isFailure(exit)) {
    process.exit(1);
  }
});
