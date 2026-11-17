import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { BadPreconditionsError } from "@/errors";
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
 * The workspace: a monorepo whose root package.json says `"jive": { "root": true }`. Every repo jive loads into it is a
 * submodule at `packages/<its package.json name>` (`workspace-layout.ts`).
 */
export interface IToolState {
  /** The nearest directory, from the current one upward, whose package.json marks it the workspace root. */
  findWorkspaceRoot(): EffectGen<e.Option.Option<string>>;
  assertInWorkspace(): EffectGen<{ workspaceRoot: string }, NotInWorkspaceError>;
  /**
   * Adds `"jive": { "root": true }` to `directory`'s package.json, creating the file when there is none, and keeps the
   * rest of it. Returns whether it wrote the file (false when the mark was already there).
   */
  markWorkspaceRoot(directory: string): EffectGen<boolean, BadPreconditionsError>;
}
