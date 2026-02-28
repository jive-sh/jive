import { Effect } from "effect";
import * as path from "path";
import * as fs from "fs";

/**
 * Walks up from cwd until it finds a .jive directory.
 * Returns the workspace root (parent of .jive), or null if not found.
 */
export function findWorkspaceRootSync(): string | null {
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, ".jive"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export const findWorkspaceRoot = Effect.sync(() => findWorkspaceRootSync());

/**
 * Returns all orgs loaded in the workspace, without the @ prefix.
 */
export const localOrgs = Effect.gen(function*() {
  const root = yield* findWorkspaceRoot;
  if (!root) return [] as string[];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith("@"))
    .map(d => d.name.slice(1)); // strip @ for display
});

/**
 * Fetches public repos for a given org from GitHub.
 * org should be passed without the @ prefix.
 */
export const remoteRepos = (org: string) => Effect.gen(function*() {
  const response = yield* Effect.promise(() =>
    fetch(`https://api.github.com/users/${org}/repos?per_page=100`, {
      headers: { Accept: "application/vnd.github+json" },
    })
  );
  if (!response.ok) return [] as string[];
  const repos = yield* Effect.promise(() => response.json() as Promise<Array<{ name: string }>>);
  return repos.map(r => r.name);
});

/**
 * Returns all repos loaded for a given org in the workspace.
 * org should be passed without the @ prefix.
 */
export const localRepos = (org: string) => Effect.gen(function*() {
  const root = yield* findWorkspaceRoot;
  if (!root) return [] as string[];
  const orgDir = path.join(root, `@${org}`);
  if (!fs.existsSync(orgDir)) return [] as string[];
  return fs.readdirSync(orgDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
});
