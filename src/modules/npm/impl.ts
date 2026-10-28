import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";
import type { INpm, NpmUser } from "./interface";

export class NpmImpl extends implementing(modules.npm) implements INpm {
  *ensureSignedIn(): EffectGen<NpmUser> {
    return yield* e.Effect.die("npm.ensureSignedIn is not implemented");
  }
  *createOrg(_org: string): EffectGen<void> {
    return yield* e.Effect.die("npm.createOrg is not implemented");
  }
  *ensureOrgExists(_org: string): EffectGen<void> {
    return yield* e.Effect.die("npm.ensureOrgExists is not implemented");
  }
  *setupTrustedPublishing(_repo: RepoIdentifier): EffectGen<void> {
    return yield* e.Effect.die("npm.setupTrustedPublishing is not implemented");
  }
}
