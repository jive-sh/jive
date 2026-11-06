import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { OSPlatform, OSPlatformImpl } from "jive-abstract-library";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { EffectGen } from "effective-modules";
import { modules } from "@/modules";
import { ToolStateImpl } from "@/modules/tool-state/impl";
import { BunImpl } from "./impl";
import { LinkScope, type IBun, type LinkResult, type WorkspaceLink } from "./interface";

/**
 * Linking on a scratch workspace inside this package's node_modules: each package is a directory with a package.json,
 * each dependent's node_modules holds a stand-in for the registry copy, and no bun runs (the host records the
 * `bun install` that unlinking asks for).
 */

const scratchRoot = path.join(import.meta.dir, "..", "..", "..", "node_modules", ".cache", "jive-test-scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratch = realpathSync(mkdtempSync(path.join(scratchRoot, "link-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let workspace = "";
const directory = (name: string) => path.join(workspace, name);
const installedIn = (dependent: string, dependency: string) => path.join(directory(dependent), "node_modules", ...dependency.split("/"));
const spawned: Array<{ command: string; args: ReadonlyArray<string>; cwd: string | undefined }> = [];

function writePackage(name: string, manifest: Record<string, unknown>, { installed = [] as ReadonlyArray<string>, folder = name } = {}) {
  mkdirSync(directory(folder), { recursive: true });
  writeFileSync(path.join(directory(folder), "package.json"), JSON.stringify({ name, ...manifest }, null, 2));
  for (const dependency of installed) {
    mkdirSync(installedIn(folder, dependency), { recursive: true });
    writeFileSync(path.join(installedIn(folder, dependency), "package.json"), JSON.stringify({ name: dependency, version: "0.0.1" }));
  }
}

function writeBuild(folder: string, manifest: Record<string, unknown>) {
  mkdirSync(path.join(directory(folder), "dist", "base"), { recursive: true });
  writeFileSync(path.join(directory(folder), "dist", "base", "package.json"), JSON.stringify(manifest));
}

beforeEach(() => {
  workspace = mkdtempSync(path.join(scratch, "workspace-"));
  spawned.length = 0;
  // Imported from its checkout: its source package.json names an entry point.
  writePackage("@acme/source", { version: "2.0.0", exports: { ".": "./index.ts" } });
  // Built by a Jive abstract: only dist/base is importable, and it is of the checkout's version.
  writePackage("built", { version: "1.0.0" });
  writeBuild("built", { name: "built", version: "1.0.0-local" });
  writePackage("stale", { version: "1.0.0" });
  writeBuild("stale", { name: "stale", version: "0.9.0-local" });
  writePackage("unbuilt", { version: "1.0.0" });
  writePackage("peer", { version: "1.0.0", main: "index.js" });
  writePackage("twin", { version: "1.0.0", main: "index.js" }, { folder: "twin-a" });
  writePackage("twin", { version: "1.0.0", main: "index.js" }, { folder: "twin-b" });
  writePackage("app", {
    version: "0.0.0",
    dependencies: { "@acme/source": "1.0.0", built: "^1.0.0", stale: "1.0.0", unbuilt: "1.0.0", twin: "1.0.0", "not-in-workspace": "1.0.0" },
    peerDependencies: { peer: "^1.0.0" },
  }, { installed: ["@acme/source", "built", "stale", "unbuilt", "twin", "not-in-workspace"] });
  writePackage("pinned-locally", { version: "0.0.0", devDependencies: { "@acme/source": "link:@acme/source", built: "1.0.0" } }, { installed: ["@acme/source", "built"] });
});

const repositories = () => ["@acme/source", "built", "stale", "unbuilt", "peer", "twin-a", "twin-b", "app", "pinned-locally"].map(directory);

/** The host as the bun module sees it, except that a process it starts is recorded and exits 0. */
const recordingHost = e.Layer.effect(OSPlatform, e.Effect.gen(function* () {
  const real = yield* OSPlatform;
  return Object.assign(Object.create(real), {
    *spawnProcess(input: { command: string; args?: ReadonlyArray<string>; cwd?: string }) {
      spawned.push({ command: input.command, args: input.args ?? [], cwd: input.cwd });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
})).pipe(e.Layer.provide(OSPlatformImpl.Layer));

function run<A>(use: (bun: IBun) => EffectGen<A, unknown>): Promise<A> {
  return e.Effect.runPromise(e.pipe(
    e.Effect.gen(function* () { return yield* use(yield* modules.bun); }),
    e.Effect.provide(BunImpl.Layer),
    e.Effect.provide(ToolStateImpl.mockLayer({})),
    e.Effect.provide(recordingHost),
    e.Effect.provide(BunServices.layer),
  ));
}

const linkAll = (scope: LinkScope = LinkScope.Workspace()) => run(bun => bun.linkWorkspace({ repositories: repositories(), scope }));
const resultOf = (links: ReadonlyArray<WorkspaceLink>, dependent: string, dependency: string): LinkResult["_tag"] | undefined =>
  links.find(link => link.dependent === dependent && link.dependency === dependency)?.result._tag;
const pointsAt = (dependent: string, dependency: string) =>
  lstatSync(installedIn(dependent, dependency)).isSymbolicLink() ? realpathSync(installedIn(dependent, dependency)) : "registry copy";

describe("linking the workspace's packages", () => {
  test("each dependency on a workspace package points at its checkout, or at its build when only the build is importable", async () => {
    const links = await linkAll();

    expect(resultOf(links, "app", "@acme/source")).toBe("Linked");
    expect(pointsAt("app", "@acme/source")).toBe(directory("@acme/source"));
    expect(resultOf(links, "app", "built")).toBe("Linked");
    expect(pointsAt("app", "built")).toBe(path.join(directory("built"), "dist", "base"));
    // Relative, as `bun link` writes it.
    expect(path.isAbsolute(readlinkSync(installedIn("app", "built")))).toBe(false);
  });

  test("the checkout wins over a pin it doesn't meet, and the link says so", async () => {
    const link = (await linkAll()).find(candidate => candidate.dependent === "app" && candidate.dependency === "@acme/source")!;
    expect(link).toMatchObject({ specifier: "1.0.0", checkoutVersion: "2.0.0", specifierSatisfied: false });
    const built = (await linkAll()).find(candidate => candidate.dependent === "app" && candidate.dependency === "built")!;
    expect(built.specifierSatisfied).toBe(true);
  });

  test("what isn't linked is left as installed, with the reason", async () => {
    const links = await linkAll();
    expect(resultOf(links, "app", "stale")).toBe("StaleBuild");
    expect(resultOf(links, "app", "unbuilt")).toBe("NotBuilt");
    expect(resultOf(links, "app", "peer")).toBe("NotInstalled");
    expect(resultOf(links, "app", "twin")).toBe("SameName");
    expect(resultOf(links, "pinned-locally", "@acme/source")).toBe("LocalSpecifier");
    expect(resultOf(links, "app", "not-in-workspace")).toBeUndefined();
    for (const dependency of ["stale", "unbuilt", "twin", "not-in-workspace"]) expect(pointsAt("app", dependency)).toBe("registry copy");
    expect(pointsAt("pinned-locally", "@acme/source")).toBe("registry copy");
    expect(existsSync(installedIn("app", "peer"))).toBe(false);
  });

  test("no package.json changes, nothing runs, and linking again changes nothing", async () => {
    const manifests = () => repositories().map(repository => readFileSync(path.join(repository, "package.json"), "utf8"));
    const before = manifests();
    const first = await linkAll();
    const second = await linkAll();
    expect(manifests()).toEqual(before);
    expect(second).toEqual(first);
    expect(spawned).toEqual([]);
  });

  test("a scope links into one package, or into and out of one package", async () => {
    const into = await linkAll(LinkScope.Into({ directory: directory("pinned-locally") }));
    expect(new Set(into.map(link => link.dependent))).toEqual(new Set(["pinned-locally"]));
    expect(pointsAt("app", "built")).toBe("registry copy");

    const touching = await linkAll(LinkScope.Touching({ directory: directory("built") }));
    expect(touching.map(link => `${link.dependency} into ${link.dependent}`).sort()).toEqual(["built into app", "built into pinned-locally"]);
  });

  test("unlinking a package removes every link into it and reinstalls each package that had one", async () => {
    await linkAll();
    const reinstalled = await run(bun => bun.unlinkPackage({ repositories: repositories(), packageDirectory: directory("built") }));
    expect([...reinstalled].sort()).toEqual(["app", "pinned-locally"]);
    expect(existsSync(installedIn("app", "built"))).toBe(false);
    expect(pointsAt("app", "@acme/source")).toBe(directory("@acme/source"));
    expect(spawned.map(({ command, args, cwd }) => ({ command, args, cwd })).sort((a, b) => (a.cwd ?? "").localeCompare(b.cwd ?? ""))).toEqual([
      { command: "bun", args: ["install"], cwd: directory("app") },
      { command: "bun", args: ["install"], cwd: directory("pinned-locally") },
    ]);
  });
});
