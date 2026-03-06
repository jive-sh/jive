import * as e from "effect";
import { AuthImpl } from "./modules";
import { ModuleDependenciesLive } from "./modules/runtime";
import { program } from "./program";

const ModulesLive = e.Layer.mergeAll(ModuleDependenciesLive, AuthImpl);

void e.Effect.runPromise(e.Effect.provide(program, ModulesLive)).catch((error) => {
  e.Effect.runSync(e.Effect.logError(error));
  process.exit(1);
});
