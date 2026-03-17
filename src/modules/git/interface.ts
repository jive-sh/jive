import * as e from "effect";
import type { RepoIdentifier, CurrentUser } from "@/modules";

export interface GitService {
  readonly localOrgs: e.Effect.Effect<string[]>;
  readonly localRepos: (org: string) => e.Effect.Effect<string[]>;
  readonly submoduleExists: (repo: RepoIdentifier) => e.Effect.Effect<boolean>;
  readonly cloneAsSubmodule: (repo: RepoIdentifier, user: CurrentUser) => e.Effect.Effect<boolean>;
  readonly configureSubmodule: (repo: RepoIdentifier, user: CurrentUser) => e.Effect.Effect<void>;
  readonly removeSubmodule: (repo: RepoIdentifier) => e.Effect.Effect<void>;
}

export class IGit extends e.Context.Tag("IGit")<IGit, GitService>() {}
