import { afterAll, expect, test } from "bun:test";
import { encodeTemplate } from "jive-abstract-abstraction";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/**
 * `jive create` run as a process, as a person runs it, in a workspace holding a build of `jive-abstract-widget` whose
 * template was encoded from a sample the way jive-abstract-abstraction's build encodes it; nothing reaches npm.
 */

const entrypoint = path.join(import.meta.dir, "entrypoints", "jive.ts");
const scratch = path.join(import.meta.dir, "..", "node_modules", ".cache", "create-test");
mkdirSync(scratch, { recursive: true });
const workspace = mkdtempSync(path.join(scratch, "workspace-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));
writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ jive: { root: true } }));

const replacements = { "example-widget": "packageName", Widgets: "title" };
const sample = [
  { path: "package.json", contents: `${JSON.stringify({ name: "example-widget", devDependencies: { "jive-abstract-widget": "0.0.1" } }, null, 2)}\n` },
  { path: "README.md", contents: "# Widgets\n\nexample-widget keeps <% as it is.\n" },
  { path: "src/example-widget.ts", contents: 'export const name = "example-widget";\n' },
];
const checkout = path.join(workspace, "packages", "jive-abstract-widget");
const built = path.join(checkout, "dist", "base");
mkdirSync(built, { recursive: true });
writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "jive-abstract-widget", version: "2.0.0" }));
writeFileSync(path.join(built, "package.json"), JSON.stringify({ name: "jive-abstract-widget", version: "2.0.0-local", jive: { abstract: { replacements } } }));
for (const file of encodeTemplate({ files: sample, replacements }).files) {
  const target = path.join(built, "template", file.path);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, file.contents);
}

async function jive(input: { readonly args: ReadonlyArray<string>; readonly stdin?: string }) {
  const proc = Bun.spawn(["bun", entrypoint, ...input.args], {
    cwd: workspace,
    env: process.env,
    stdin: input.stdin === undefined ? "ignore" : new Blob([input.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
}

const read = (relativePath: string) => readFileSync(path.join(workspace, relativePath), "utf8");

test("writes the package at packages/<its name>, its inputs given as flags, pinned to the abstract's version", async () => {
  const { exitCode, stdout } = await jive({ args: ["create", "widget", "--packageName", "gear", "--title=Gears & Co"] });
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Creating from jive-abstract-widget 2.0.0, the workspace's build at packages/jive-abstract-widget/dist/base");
  expect(JSON.parse(read("packages/gear/package.json"))).toEqual({ name: "gear", devDependencies: { "jive-abstract-widget": "2.0.0" } });
  expect(read("packages/gear/README.md")).toBe("# Gears & Co\n\ngear keeps <% as it is.\n");
  expect(read("packages/gear/src/gear.ts")).toBe('export const name = "gear";\n');
});

test("refuses, writing nothing, an input that would put a \"/\" in a file name", async () => {
  const { exitCode, stderr } = await jive({ args: ["create", "widget", "--packageName", "@acme/gear", "--title", "Gears"] });
  expect(exitCode).toBe(1);
  expect(stderr).toContain("src/{packageName}.ts.ejs renders to the name \"@acme/gear.ts\", which is not one file or folder name");
  expect(existsSync(path.join(workspace, "packages/@acme"))).toBe(false);
});

test("asks on the terminal for each input not given as a flag", async () => {
  const { exitCode, stdout } = await jive({ args: ["create", "widget", "--title", "Sprockets"], stdin: "sprocket\n" });
  expect(exitCode).toBe(0);
  expect(stdout).toContain("packageName: ");
  expect(read("packages/sprocket/src/sprocket.ts")).toBe('export const name = "sprocket";\n');
});

test("refuses a flag the template does not ask for, writing nothing", async () => {
  const { exitCode, stderr } = await jive({ args: ["create", "widget", "--packageName", "cog", "--title", "Cogs", "--colour", "red"] });
  expect({ exitCode, stderr }).toEqual({ exitCode: 1, stderr: "ERROR: Invalid --colour: jive-abstract-widget's template asks for --packageName, --title\n" });
  expect(existsSync(path.join(workspace, "packages/cog"))).toBe(false);
});

test("refuses to write over a package already there", async () => {
  const { exitCode, stderr } = await jive({ args: ["create", "widget", "--packageName", "jive-abstract-widget", "--title", "x"] });
  expect(exitCode).toBe(1);
  expect(stderr).toContain("packages/jive-abstract-widget already exists");
});

test("names the abstract it could not get", async () => {
  const { exitCode, stderr } = await jive({ args: ["create", "Widget"] });
  expect({ exitCode, stderr }).toEqual({ exitCode: 1, stderr: 'ERROR: Invalid kind: "Widget": each word of a kind is lowercase letters and digits; a hyphen separates words, so give them as separate words\n' });
});
