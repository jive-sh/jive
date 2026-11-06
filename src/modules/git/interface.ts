import type { EffectGen } from "effective-modules";
import type { BadArgumentError, BadPreconditionsError } from "@/errors";
import type { AccountKey } from "@/modules/account-key/interface";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";

export interface IGit {
  localOrgs(): EffectGen<string[], BadPreconditionsError>;
  localRepos(org: string): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
  submoduleExists(repo: RepoIdentifier): EffectGen<boolean, BadArgumentError | BadPreconditionsError>;
  /**
   * Adds the repo to the workspace as a submodule by its https URL, fetches its own submodules, and configures it and
   * them (`configureRepository`).
   */
  cloneAsSubmodule(repo: RepoIdentifier, accountKey: AccountKey): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  removeSubmodule(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  /** The workspace's submodules, named by the GitHub repo each one's URL names; a submodule on another host is left out. */
  getSubmodules(): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
  /** The top of the git repository `directory` is in. */
  repositoryRoot(directory: string): EffectGen<string, BadPreconditionsError>;
  /** `root`, every submodule checked out under it, and every repository inside it that git doesn't track, at any depth. */
  repositoriesUnder(root: string): EffectGen<ReadonlyArray<string>, BadPreconditionsError>;
  /**
   * Rewrites every GitHub URL in every .gitmodules under `root` to `https://github.com/<owner>/<repo>`, syncs them
   * into git config, and checks out every submodule not yet checked out, at any depth. A submodule already checked
   * out keeps its HEAD and working tree. Returns how many URLs it rewrote.
   */
  checkOutSubmodulesOverHttps(root: string, accountKey: AccountKey): EffectGen<number, BadPreconditionsError>;
  /**
   * Sets exactly what jive needs in `repository`: commits signed with the account key through `jive-ssh-keygen`, and
   * GitHub's https URLs fetched and pushed over SSH through the signing agent.
   */
  configureRepository(repository: string, accountKey: AccountKey): EffectGen<void, BadPreconditionsError>;
}
