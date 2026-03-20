import * as e from "effect";
import type { RepoIdentifier } from "@/modules/tool-state/interface";
import { INpm } from "./interface";

export const NpmImpl = e.Layer.effect(INpm, e.Effect.gen(function*() {
  return {
    ensureSignedIn: e.Effect.fn(function*() {
      return yield* e.Effect.dieMessage("npm.ensureSignedIn is not implemented");
    }),
    createOrg: e.Effect.fn(function*(_org: string) {
      return yield* e.Effect.dieMessage("npm.createOrg is not implemented");
    }),
    ensureOrgExists: e.Effect.fn(function*(_org: string) {
      return yield* e.Effect.dieMessage("npm.ensureOrgExists is not implemented");
    }),
    setupTrustedPublishing: e.Effect.fn(function*(_repo: RepoIdentifier) {
      return yield* e.Effect.dieMessage("npm.setupTrustedPublishing is not implemented");
    }),
  };
}));
