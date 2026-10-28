import type { EffectGen } from "effective-modules";
import type { BadArgumentError, BadPreconditionsError } from "@/errors";
import type { CurrentUser } from "@/modules/auth/interface";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";

export interface IGit {
  localOrgs(): EffectGen<string[], BadPreconditionsError>;
  localRepos(org: string): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
  configureWorkspace(user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  submoduleExists(repo: RepoIdentifier): EffectGen<boolean, BadArgumentError | BadPreconditionsError>;
  cloneAsSubmodule(repo: RepoIdentifier, user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  configureSubmodule(repo: RepoIdentifier, user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  removeSubmodule(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  getSubmodules(): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
}
