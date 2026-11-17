import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { BadArgumentError, BadPreconditionsError } from "@/errors";
import type { AccountKey } from "@/modules/account-key/interface";
import type { RepoLocation } from "@/modules/tool-state/interface";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";

/** A GitHub repo the workspace's root `.gitmodules` lists. */
export interface LoadedRepository {
  readonly repo: RepoIdentifier;
  /** The submodule's name in `.gitmodules`, which also names its git directory under `.git/modules`. */
  readonly submoduleName: string;
  readonly location: RepoLocation;
}

/** How `loadAsSubmodule` got the repo to its place. */
export type LoadOutcome = e.Data.TaggedEnum<{
  /** Cloned from GitHub and added as a submodule. */
  Cloned: {};
  /** A checkout of the repo was already at its place; it was added as a submodule as it is, uncommitted work included. */
  Adopted: {};
  /** It was already a submodule at its place; nothing was added. */
  AlreadyLoaded: {};
}>;
export const LoadOutcome = e.Data.taggedEnum<LoadOutcome>();

export interface LoadedSubmodule {
  readonly packageName: string;
  readonly location: RepoLocation;
  readonly outcome: LoadOutcome;
}

export interface IGit {
  /** The GitHub orgs of the workspace's loaded repos. */
  localOrgs(): EffectGen<string[], BadPreconditionsError>;
  localRepos(org: string): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError>;
  /** Where a loaded repo is, failing when the workspace's `.gitmodules` doesn't list it or it isn't checked out. */
  loadedRepository(repo: RepoIdentifier): EffectGen<LoadedRepository, BadArgumentError | BadPreconditionsError>;
  /**
   * Makes the repo a submodule of the workspace at `packages/<its package.json name>`: cloned by its https URL, or a
   * checkout of it already there adopted as it is. Only its own `.gitmodules` entry and its gitlink are staged; nothing
   * else in the index changes, so uncommitted edits to `.gitmodules` stay unstaged. Then fetches its submodules and
   * configures it and them (`configureRepository`). Running it again on a loaded repo only fetches and configures.
   */
  loadAsSubmodule(input: { readonly repo: RepoIdentifier; readonly accountKey: AccountKey }): EffectGen<LoadedSubmodule, BadArgumentError | BadPreconditionsError>;
  removeSubmodule(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  /** The top of the git repository `directory` is in. */
  repositoryRoot(directory: string): EffectGen<string, BadPreconditionsError>;
  /** The top of the outermost git repository holding `directory`: its repository, or the superproject it is a submodule of, at any depth. */
  outermostRepositoryRoot(directory: string): EffectGen<string, BadPreconditionsError>;
  /** `root`, every submodule checked out under it, and every repository inside it that git doesn't track, at any depth. */
  repositoriesUnder(root: string): EffectGen<ReadonlyArray<string>, BadPreconditionsError>;
  /**
   * Rewrites every GitHub URL in every .gitmodules under `root` to `https://github.com/<owner>/<repo>`, syncs them
   * into git config, and checks out every submodule not yet checked out, at any depth. A submodule already checked
   * out keeps its HEAD and working tree. Returns how many URLs it rewrote.
   */
  checkOutSubmodulesOverHttps(root: string): EffectGen<number, BadPreconditionsError>;
  /**
   * Sets exactly what jive needs in `repository`: commits signed with the account key through `jive-ssh-sign`, and
   * GitHub's https URLs fetched and pushed over SSH through `jive-ssh`.
   */
  configureRepository(repository: string, accountKey: AccountKey): EffectGen<void, BadPreconditionsError>;
}
