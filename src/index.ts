import * as e from "effect";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cli } from "jive-abstract-library";
import { version } from "../package.json";
import { ModulesLayer } from "@/modules/runtime";
import { jive } from "@/program";

BunRuntime.runMain(e.pipe(
  Cli.run(jive, { version }),
  e.Effect.catchTags({
    BadArgumentError: error => error.report(),
    BadPreconditionsError: error => error.report(),
  }),
  e.Effect.provide(ModulesLayer),
  e.Effect.provide(Cli.terminalLogger),
  e.Effect.provide(BunServices.layer),
));
