import * as path from "node:path";

/**
 * Jive's one layout, which tools that build on jive rely on: each repo loaded into a workspace sits at
 * `packages/<its package.json name>`, so `@jive-sh/jive` is at `packages/@jive-sh/jive` and `jive-abstract-library`
 * at `packages/jive-abstract-library`. There is no option to place a repo elsewhere.
 */
export const PACKAGES_DIRECTORY = "packages";

/** npm's rule for a package name, scoped or not; it also keeps the path from leaving `packages/`. */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export const isPackageName = (name: string): boolean => PACKAGE_NAME.test(name);

/** Where the package `packageName` sits, relative to the workspace root, with `/` separators. */
export const packageRelativePath = (packageName: string): string => path.posix.join(PACKAGES_DIRECTORY, packageName);
