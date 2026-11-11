import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { BadArgumentError, BadPreconditionsError } from "@/errors";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";

/** Which of the workspace's links a run makes. */
export type LinkScope = e.Data.TaggedEnum<{
  /** Every package's workspace dependencies, in every package. */
  Workspace: {};
  /** The workspace's packages into the package in this directory, and it into every package that depends on it. */
  Touching: { readonly directory: string };
}>;
export const LinkScope = e.Data.taggedEnum<LinkScope>();

/** What happened to one dependency of one workspace package on another. */
export type LinkResult = e.Data.TaggedEnum<{
  /** `node_modules/<dependency>` in the dependent is now a symlink to `target`. */
  Linked: { readonly target: string };
  /** The dependent already names a local copy itself (`link:`, `file:`, `workspace:`), so its choice stands. */
  LocalSpecifier: {};
  /** `bun install` hasn't put the dependency in the dependent's node_modules (a peer dependency, or no install yet). */
  NotInstalled: {};
  /** The dependency publishes only what its build makes (no entry point in its source package.json), and it has no build. */
  NotBuilt: {};
  /** The dependency's build is of another version than its checkout. */
  StaleBuild: { readonly builtVersion: string };
  /** Two repositories in the workspace are packages of this name, so neither is linked. */
  SameName: { readonly directories: ReadonlyArray<string> };
}>;
export const LinkResult = e.Data.taggedEnum<LinkResult>();

export interface WorkspaceLink {
  readonly dependent: string;
  readonly dependency: string;
  /** What the dependent's package.json asks for, e.g. `0.3.6` or `^0.2.0`. */
  readonly specifier: string;
  /** The version in the dependency's checkout. */
  readonly checkoutVersion: string;
  /** Whether that version satisfies the specifier: false means the checkout wins over a pin it doesn't meet. */
  readonly specifierSatisfied: boolean;
  readonly result: LinkResult;
}

export interface IBun {
  install(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  /**
   * Links the workspace's packages to each other, the way a monorepo's workspace links its members: wherever a package
   * among `repositories` depends on another one, its `node_modules/<name>` becomes a symlink to that package's checkout
   * (or to the checkout's build, for a package that publishes only its build). The checkout wins over whatever the
   * dependent pins, and nothing is written to any package.json or bun.lock, so each repository's own install and CI
   * stay as they are. A later `bun install` or `bun add` in a dependent puts the registry copy back; linking again
   * restores the symlinks.
   */
  linkWorkspace(input: { readonly repositories: ReadonlyArray<string>; readonly scope: LinkScope }): EffectGen<ReadonlyArray<WorkspaceLink>, BadPreconditionsError>;
  /**
   * Undoes `linkWorkspace` for the package in `packageDirectory`, before it leaves the workspace: every other package
   * among `repositories` whose `node_modules` links into it gets the link removed and `bun install` run, which puts
   * the registry copy back. Returns the names of the packages it reinstalled.
   */
  unlinkPackage(input: { readonly repositories: ReadonlyArray<string>; readonly packageDirectory: string }): EffectGen<ReadonlyArray<string>, BadPreconditionsError>;
}
