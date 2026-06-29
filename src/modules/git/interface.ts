import type { RepoIdentifier } from "@/modules/tool-state/interface";
import type { CurrentUser } from "@/modules/auth/interface";
import type { BadArgumentError, BadPreconditionsError } from "@/modules";
import type { GenEffect } from "@/temp-libs/effective-modules";

export interface IGit {
  localOrgs(): GenEffect<string[], BadPreconditionsError>;
  localRepos(org: string): GenEffect<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
  configureWorkspace(user: CurrentUser): GenEffect<void, BadArgumentError | BadPreconditionsError>;
  submoduleExists(repo: RepoIdentifier): GenEffect<boolean, BadArgumentError | BadPreconditionsError>;
  cloneAsSubmodule(repo: RepoIdentifier, user: CurrentUser): GenEffect<void, BadArgumentError | BadPreconditionsError>;
  configureSubmodule(repo: RepoIdentifier, user: CurrentUser): GenEffect<void, BadArgumentError | BadPreconditionsError>;
  removeSubmodule(repo: RepoIdentifier): GenEffect<void, BadArgumentError | BadPreconditionsError>;
  getSubmodules(): GenEffect<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
}
