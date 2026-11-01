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
   * Adds the repo to the workspace as a submodule by its https URL, fetches its own submodules, and configures it and
   * them for the user (`configureRepository`).
   */
  cloneAsSubmodule(repo: RepoIdentifier, user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  removeSubmodule(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  /** The workspace's submodules, named by the GitHub repo each one's URL names; a submodule on another host is left out. */
  getSubmodules(): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
  /** The top of the git repository `directory` is in. */
  repositoryRoot(directory: string): EffectGen<string, BadPreconditionsError>;
  /** `root` and every submodule checked out under it, at any depth. */
  repositoriesUnder(root: string): EffectGen<ReadonlyArray<string>, BadPreconditionsError>;
  /**
   * Rewrites every GitHub URL in every .gitmodules under `root` to the repo's https URL, which GitHub and every clone
   * can follow, syncs them into git config, and checks out every submodule not yet checked out, at any depth. A
   * submodule already checked out keeps its HEAD and working tree. Returns how many URLs it rewrote.
   */
  checkOutSubmodulesOverHttps(root: string, user: CurrentUser): EffectGen<number, BadPreconditionsError>;
  /**
   * Makes `repository` commit as the user, sign commits and tags with the account key, fetch GitHub over https
   * through `git-credential-jive`, and push to GitHub over SSH through the signing agent.
   */
  configureRepository(repository: string, user: CurrentUser): EffectGen<void, BadPreconditionsError>;
}
