import * as e from "effect";
import type { RepoIdentifier } from "@/modules/tool-state/interface";

export interface NpmUser {
  readonly username: string;
}

export interface INpm {
  /**
   * Signs in to npm if necessary and returns the current npm user.
   */
  readonly ensureSignedIn: () => e.Effect.Effect<NpmUser>;
  /**
   * Creates an npm org.
   */
  readonly createOrg: (org: string) => e.Effect.Effect<void>;
  /**
   * Ensures an npm org exists, creating it when necessary.
   */
  readonly ensureOrgExists: (org: string) => e.Effect.Effect<void>;
  /**
   * Sets up npm trusted publishing for the package associated with a repo.
   */
  readonly setupTrustedPublishing: (repo: RepoIdentifier) => e.Effect.Effect<void>;
}
