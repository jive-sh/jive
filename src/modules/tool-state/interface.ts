import * as e from "effect";
import type { EffectGen } from "effective-modules";
export { RepoIdentifier } from "./repo-identifier";

export class NotInWorkspaceError extends e.Data.TaggedError("NotInWorkspaceError")<{
  path: string;
}> {}

export interface RepoLocation {
  readonly absolutePath: string;
  /** Relative to the workspace root, with `/` separators, as `.gitmodules` records it. */
  readonly relativePath: string;
}

/**
 * The workspace: the nearest git repository from the current directory up, at any nesting level, a submodule
 * included. Nothing marks it and nothing else picks it; to work in an outer repository, run jive there (Alex,
 * 2026-11-25: "no weird edge cases for the auto complete behavior just looking at the nearest git repo root"). Every
 * repo jive loads into it is a submodule at `packages/<its package.json name>` (`workspace-layout.ts`).
 */
export interface IToolState {
  /**
   * The root of the nearest git repository at or above `directory`: the nearest folder holding `.git`, the directory
   * of a repository or the file of a submodule or worktree. None when no folder from there up holds one.
   */
  findWorkspaceRoot(directory: string): EffectGen<e.Option.Option<string>>;
  /** The workspace the current directory is in. */
  assertInWorkspace(): EffectGen<{ workspaceRoot: string }, NotInWorkspaceError>;
}
