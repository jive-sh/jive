import type { EffectGen } from "effective-modules";
import type { BadArgumentError, BadPreconditionsError } from "@/errors";
import type { CurrentUser } from "@/modules/auth/interface";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";

/** The name and email commits are made under. */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface IGit {
  localOrgs(): EffectGen<string[], BadPreconditionsError>;
  localRepos(org: string): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
  submoduleExists(repo: RepoIdentifier): EffectGen<boolean, BadArgumentError | BadPreconditionsError>;
  /**
   * Adds the repo to the workspace as a submodule by its https URL, fetches its own submodules recursively, and
   * configures it and them to commit as the user, sign with the account key and push through the signing agent.
   */
  cloneAsSubmodule(repo: RepoIdentifier, user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  removeSubmodule(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  getSubmodules(): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
}
