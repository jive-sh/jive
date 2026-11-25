import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { BadArgumentError, BadPreconditionsError } from "@/errors";
import type { AccountKey } from "@/modules/account-key/interface";
import type { RepoLocation } from "@/modules/tool-state/interface";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";
import type { GitIdentity } from "./identity";

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

/** What `configureRepository` sets a repository up with: the account's signing key and the workspace's git identity. */
export interface RepositorySettings {
  readonly accountKey: AccountKey;
  readonly gitIdentity: GitIdentity;
}

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
   * else in the index changes, so uncommitted edits to `.gitmodules` stay unstaged. It logs where the repo goes, and
   * leaves its submodules and its config to `jive init`, which `jive load` runs in it afterwards. On a repo already
   * loaded it changes nothing.
   */
  loadAsSubmodule(repo: RepoIdentifier): EffectGen<LoadedSubmodule, BadArgumentError | BadPreconditionsError>;
  /** Clones the repo by its https URL into `directory`, fetching over SSH through `jive-ssh`, as `git clone` would. */
  clone(input: { readonly repo: RepoIdentifier; readonly directory: string }): EffectGen<void, BadPreconditionsError>;
  removeSubmodule(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  /** The top of the git repository `directory` is in. */
  repositoryRoot(directory: string): EffectGen<string, BadPreconditionsError>;
  /** The name and email `repository`'s own git config sets (`git config --local`); none unless it sets both. */
  localIdentity(repository: string): EffectGen<e.Option.Option<GitIdentity>, BadPreconditionsError>;
  /** Makes `directory` a new git repository whose first branch is `main` (`git init -b main`). */
  createRepository(directory: string): EffectGen<void, BadPreconditionsError>;
  /** `root`, every submodule checked out under it, and every repository inside it that git doesn't track, at any depth. */
  repositoriesUnder(root: string): EffectGen<ReadonlyArray<string>, BadPreconditionsError>;
  /**
   * Checks out every submodule under `root` not yet checked out, at any depth, fetching over SSH through `jive-ssh`
   * whatever URL its .gitmodules names; no .gitmodules is written. A submodule already checked out keeps its HEAD and
   * working tree. Returns how many it checked out.
   */
  checkOutSubmodules(root: string): EffectGen<number, BadPreconditionsError>;
  /**
   * Sets exactly what jive needs in `repository`: commits made as the workspace's git identity and signed with the
   * account key through `jive-ssh-sign`, and GitHub's https URLs fetched and pushed over SSH through `jive-ssh`.
   */
  configureRepository(input: { readonly repository: string; readonly settings: RepositorySettings }): EffectGen<void, BadPreconditionsError>;
}
