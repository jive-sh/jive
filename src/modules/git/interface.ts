import type { EffectGen } from "effective-modules";
import type { BadArgumentError, BadPreconditionsError } from "@/errors";
import type { AccountKey } from "@/modules/account-key/interface";
import type { CurrentUser } from "@/modules/auth/interface";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";

/** The name and email commits are made under. */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface IGit {
  /** The top of the git repository the current directory is in. */
  currentRepositoryRoot(): EffectGen<string, BadPreconditionsError>;
  /** Clones a GitHub repo over SSH, with its submodules, authenticating through the signing agent. Returns where it went. */
  cloneWithAccountKey(input: { readonly repo: RepoIdentifier; readonly accountKey: AccountKey; readonly intoDirectory: string }): EffectGen<string, BadPreconditionsError>;
  /**
   * Makes the repository at `directory` and every submodule checked out under it commit as `identity`, sign commits
   * and tags with the account key, and push through the signing agent. Returns each repository configured.
   */
  configureSigning(input: { readonly directory: string; readonly identity: GitIdentity; readonly accountKey: AccountKey }): EffectGen<ReadonlyArray<string>, BadPreconditionsError>;
  localOrgs(): EffectGen<string[], BadPreconditionsError>;
  localRepos(org: string): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
  configureWorkspace(user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  submoduleExists(repo: RepoIdentifier): EffectGen<boolean, BadArgumentError | BadPreconditionsError>;
  cloneAsSubmodule(repo: RepoIdentifier, user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  configureSubmodule(repo: RepoIdentifier, user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  removeSubmodule(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  getSubmodules(): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
}
