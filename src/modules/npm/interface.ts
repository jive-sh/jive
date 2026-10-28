import type { EffectGen } from "effective-modules";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";

export interface NpmUser {
  readonly username: string;
}

export interface INpm {
  /**
   * Signs in to npm if necessary and returns the current npm user.
   */
  ensureSignedIn(): EffectGen<NpmUser>;
  /**
   * Creates an npm org.
   */
  createOrg(org: string): EffectGen<void>;
  /**
   * Ensures an npm org exists, creating it when necessary.
   */
  ensureOrgExists(org: string): EffectGen<void>;
  /**
   * Sets up npm trusted publishing for the package associated with a repo.
   */
  setupTrustedPublishing(repo: RepoIdentifier): EffectGen<void>;
}
