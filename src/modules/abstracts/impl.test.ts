import { afterAll, describe, expect, test } from "bun:test";
import * as e from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { HttpClient, HttpClientResponse } from "effect/http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { modules } from "@/modules";
import { AbstractsImpl, NPM_REGISTRY_URL } from "./impl";

/** Fetching an abstract from a workspace's build of it on disk, and from npm through a fake registry. */

const scratch = path.join(import.meta.dir, "..", "..", "..", "node_modules", ".cache", "abstracts-test");
mkdirSync(scratch, { recursive: true });
const workspaceRoot = mkdtempSync(path.join(scratch, "workspace-"));
afterAll(() => rmSync(workspaceRoot, { recursive: true, force: true }));

const published = { name: "jive-abstract-widget", version: "1.2.0", jive: { abstract: { replacements: { "example-widget": "packageName" } } } };
const templateFiles = [
  { path: "package.json.ejs", contents: '{ "name": "<%= packageName %>" }' },
  { path: "src/index.ts.ejs", contents: "export {};\n" },
];

/** A fake registry: each URL it knows answers its body, everything else 404, and every request is recorded. */
function fakeRegistry(routes: { readonly [url: string]: { readonly status: number; readonly body: string | Uint8Array } }) {
  const requests: Array<string> = [];
  const client = HttpClient.make((request) => {
    requests.push(request.url);
    const route = routes[request.url];
    return e.Effect.succeed(HttpClientResponse.fromWeb(request, new Response(route === undefined ? "not found" : route.body, { status: route === undefined ? 404 : route.status })));
  });
  return { requests, layer: e.Layer.succeed(HttpClient.HttpClient, client) };
}

function get(name: string, registry: ReturnType<typeof fakeRegistry>) {
  return e.Effect.runPromise(e.pipe(
    e.Effect.gen(function* () { return yield* (yield* modules.abstracts).get({ name, workspaceRoot }); }),
    e.Effect.result,
    e.Effect.provide(e.pipe(AbstractsImpl.Layer, e.Layer.provideMerge(registry.layer), e.Layer.provideMerge(BunFileSystem.layer))),
  ));
}

describe("from npm", () => {
  const documentUrl = `${NPM_REGISTRY_URL}/jive-abstract-widget`;
  const tarballUrl = `${NPM_REGISTRY_URL}/jive-abstract-widget/-/jive-abstract-widget-1.2.0.tgz`;
  const document = JSON.stringify({ "dist-tags": { latest: "1.2.0" }, versions: { "1.2.0": { dist: { tarball: tarballUrl } } } });

  test("downloads the latest version's tarball and reads its template and replacements", async () => {
    const tarball = await new Bun.Archive({
      "package/package.json": JSON.stringify(published),
      "package/README.md": "# jive-abstract-widget",
      ...Object.fromEntries(templateFiles.map((file) => [`package/template/${file.path}`, file.contents])),
    }, { compress: "gzip" }).bytes();
    const registry = fakeRegistry({ [documentUrl]: { status: 200, body: document }, [tarballUrl]: { status: 200, body: tarball } });

    const result = await get("jive-abstract-widget", registry);
    expect(e.Result.isSuccess(result) && result.success).toEqual({
      name: "jive-abstract-widget",
      version: "1.2.0",
      replacements: { "example-widget": "packageName" },
      templateFiles,
      source: expect.objectContaining({ _tag: "Registry", tarballUrl }),
    });
    expect(registry.requests).toEqual([documentUrl, tarballUrl]);
  });

  test("says npm has no such package when the registry answers 404", async () => {
    const result = await get("jive-abstract-widget", fakeRegistry({}));
    expect(e.Result.isFailure(result) && result.failure.reason).toBe("npm has no package named jive-abstract-widget");
  });

  test("refuses a package built without a template", async () => {
    const tarball = await new Bun.Archive({ "package/package.json": JSON.stringify({ name: "jive-abstract-widget", version: "1.2.0" }) }, { compress: "gzip" }).bytes();
    const result = await get("jive-abstract-widget", fakeRegistry({ [documentUrl]: { status: 200, body: document }, [tarballUrl]: { status: 200, body: tarball } }));
    expect(e.Result.isFailure(result) && result.failure.reason).toContain("was not built with jive-abstract-abstraction");
  });
});

test("takes the workspace's build of the abstract over npm, with the checkout's version", async () => {
  const checkout = path.join(workspaceRoot, "packages", "jive-abstract-widget");
  const built = path.join(checkout, "dist", "base");
  mkdirSync(path.join(built, "template", "src"), { recursive: true });
  writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "jive-abstract-widget", version: "1.3.0" }));
  writeFileSync(path.join(built, "package.json"), JSON.stringify({ ...published, version: "1.3.0-local" }));
  for (const file of templateFiles) writeFileSync(path.join(built, "template", file.path), file.contents);
  const registry = fakeRegistry({});

  const result = await get("jive-abstract-widget", registry);
  expect(e.Result.isSuccess(result) && result.success).toEqual({
    name: "jive-abstract-widget",
    version: "1.3.0",
    replacements: { "example-widget": "packageName" },
    templateFiles,
    source: expect.objectContaining({ _tag: "Workspace", directory: built }),
  });
  expect(registry.requests).toEqual([]);
  rmSync(checkout, { recursive: true });
});

test("refuses a workspace build of another version than its checkout, naming the rebuild", async () => {
  const checkout = path.join(workspaceRoot, "packages", "jive-abstract-widget");
  const built = path.join(checkout, "dist", "base");
  mkdirSync(path.join(built, "template"), { recursive: true });
  writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "jive-abstract-widget", version: "1.4.0" }));
  writeFileSync(path.join(built, "package.json"), JSON.stringify({ ...published, version: "1.3.0-local" }));

  const result = await get("jive-abstract-widget", fakeRegistry({}));
  expect(e.Result.isFailure(result) && result.failure.reason).toContain("is jive-abstract-widget 1.3.0-local, not of its checkout's version 1.4.0; run `bun run jive:cicd:build`");
  rmSync(checkout, { recursive: true });
});
