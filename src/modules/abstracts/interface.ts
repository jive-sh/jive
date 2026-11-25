import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { TemplateFile } from "jive-abstract-abstraction";

/**
 * Fetching an abstract's template: the package `jive create` makes a new package from. An abstract publishes its
 * template under `template/` and the replacements that say which inputs the template asks for in its package.json's
 * `jive.abstract` (both written by jive-abstract-abstraction's build).
 */

/** The abstract can't be had: npm has no package of that name, or it was not built with a template. */
export class AbstractUnavailable extends e.Data.TaggedError("AbstractUnavailable")<{ readonly reason: string }> {}

/** Where an abstract's template came from. */
export type AbstractSource = e.Data.TaggedEnum<{
  /** The workspace's build of its checkout, `packages/<name>/dist/base`. */
  Workspace: { readonly directory: string };
  /** Its latest version on npm. */
  Registry: { readonly tarballUrl: string };
}>;
export const AbstractSource = e.Data.taggedEnum<AbstractSource>();

export interface Abstract {
  readonly name: string;
  /** The version its dependents pin: the checkout's for a workspace build, the published one from npm. */
  readonly version: string;
  /** Each literal of the sample package the template was built from, mapped to the input that replaces it. */
  readonly replacements: { readonly [literal: string]: string };
  /** The template's files, by path under `template/`, each ending in `.ejs`. */
  readonly templateFiles: ReadonlyArray<TemplateFile>;
  readonly source: AbstractSource;
}

export interface IAbstracts {
  /**
   * The abstract named `name`, template included: the workspace's build of it when the workspace holds a built
   * checkout of it at `packages/<name>` (as workspace links run a checkout's build in place of its release), and
   * otherwise its latest version on npm.
   */
  get(input: { readonly name: string; readonly workspaceRoot: string }): EffectGen<Abstract, AbstractUnavailable>;
}
