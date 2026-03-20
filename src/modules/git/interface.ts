import * as e from "effect";
import type { RepoIdentifier } from "@/modules/tool-state/interface";
import type { CurrentUser } from "@/modules/auth/interface";
import type { BadArgumentError, BadPreconditionsError } from "@/modules";

export class IGit extends e.Context.Tag("IGit")<IGit, {
  readonly localOrgs: e.Effect.Effect<string[], BadPreconditionsError>;
  readonly localRepos: (org: string) => e.Effect.Effect<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
  readonly configureWorkspace: (user: CurrentUser) => e.Effect.Effect<void, BadArgumentError | BadPreconditionsError>;
  readonly submoduleExists: (repo: RepoIdentifier) => e.Effect.Effect<boolean, BadArgumentError | BadPreconditionsError>;
  readonly cloneAsSubmodule: (repo: RepoIdentifier, user: CurrentUser) => e.Effect.Effect<void, BadArgumentError | BadPreconditionsError>;
  readonly configureSubmodule: (repo: RepoIdentifier, user: CurrentUser) => e.Effect.Effect<void, BadArgumentError | BadPreconditionsError>;
  readonly removeSubmodule: (repo: RepoIdentifier) => e.Effect.Effect<void, BadArgumentError | BadPreconditionsError>;
  readonly getSubmodules: e.Effect.Effect<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
}>() {}
