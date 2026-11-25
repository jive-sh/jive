import { describe, expect, test } from "bun:test";
import * as e from "effect";
import { abstractNameForKind, newPackageName, parseCreateArguments, pinAbstractDependency } from "./new-package";

describe("abstractNameForKind", () => {
  const kinds = [
    { kindWords: ["library"], name: "jive-abstract-library" },
    { kindWords: ["abstraction"], name: "jive-abstract-abstraction" },
    { kindWords: ["agentic", "workforce", "software", "factory"], name: "jive-abstract-agentic-workforce-software-factory" },
  ];
  test.each(kinds)("resolves $kindWords to $name", ({ kindWords, name }) => {
    expect(abstractNameForKind(kindWords)).toEqual(e.Result.succeed(name));
  });

  const refused = [
    { name: "no words", kindWords: [] as Array<string>, message: "name the kind" },
    { name: "a hyphenated word", kindWords: ["agentic-workflow"], message: '"agentic-workflow": each word of a kind' },
    { name: "an uppercase word", kindWords: ["Library"], message: '"Library"' },
  ];
  test.each(refused)("refuses $name", ({ kindWords, message }) => {
    const result = abstractNameForKind(kindWords);
    expect(e.Result.isFailure(result) && result.failure).toContain(message);
  });
});

describe("parseCreateArguments", () => {
  test("takes the words before the first flag as the kind, and each --input value or --input=value after it", () => {
    expect(parseCreateArguments(["agentic", "workflow", "--packageName", "my-flow", "--description=a b=c"])).toEqual(e.Result.succeed({
      kindWords: ["agentic", "workflow"],
      flags: { packageName: "my-flow", description: "a b=c" },
    }));
  });

  test("takes no flags as asking for every input", () => {
    expect(parseCreateArguments(["library"])).toEqual(e.Result.succeed({ kindWords: ["library"], flags: {} }));
  });

  const refused = [
    { name: "a flag without a value", args: ["library", "--packageName"], message: "--packageName needs a value" },
    { name: "a flag given twice", args: ["library", "--packageName", "a", "--packageName=b"], message: "--packageName is given twice" },
    { name: "a word after the flags", args: ["library", "--packageName", "a", "extra"], message: 'got "extra"' },
  ];
  test.each(refused)("refuses $name", ({ args, message }) => {
    const result = parseCreateArguments(args);
    expect(e.Result.isFailure(result) && result.failure).toContain(message);
  });
});

describe("newPackageName", () => {
  test("reads the name from the rendered package.json", () => {
    expect(newPackageName([{ path: "package.json", contents: '{ "name": "@acme/my-lib" }' }])).toEqual(e.Result.succeed("@acme/my-lib"));
  });

  test.each([
    { name: "a name npm refuses", contents: '{ "name": "My Lib" }', message: '"My Lib" is not an npm package name' },
    { name: "a name that leaves packages/", contents: '{ "name": "../escape" }', message: "is not an npm package name" },
    { name: "no name", contents: "{}", message: "renders without a name" },
  ])("refuses $name", ({ contents, message }) => {
    const result = newPackageName([{ path: "package.json", contents }]);
    expect(e.Result.isFailure(result) && result.failure).toContain(message);
  });
});

test("pinAbstractDependency pins the abstract wherever package.json depends on it, and leaves other files alone", () => {
  const files = pinAbstractDependency({
    abstractName: "jive-abstract-library",
    version: "0.15.0",
    files: [
      { path: "package.json", contents: JSON.stringify({ name: "my-lib", devDependencies: { "jive-abstract-library": "0.14.1", typescript: "^5.9.3" } }) },
      { path: "src/package.json", contents: '{ "devDependencies": { "jive-abstract-library": "0.1.0" } }' },
    ],
  });
  expect(JSON.parse(files[0]!.contents)).toEqual({ name: "my-lib", devDependencies: { "jive-abstract-library": "0.15.0", typescript: "^5.9.3" } });
  expect(files[1]).toEqual({ path: "src/package.json", contents: '{ "devDependencies": { "jive-abstract-library": "0.1.0" } }' });
});
