import * as e from "effect";
import type { TemplateFile } from "jive-abstract-abstraction";
import { isPackageName } from "@/modules/tool-state/workspace-layout";

/**
 * The steps of `jive create <kind words…>` that need nothing but their input: reading its words and flags, naming
 * the abstract a kind resolves to, and reading and fixing up the rendered package.
 */

/** Every abstract's name starts with this; the rest is its kind, one word per menu level. */
export const ABSTRACT_NAME_PREFIX = "jive-abstract-";

const KIND_WORD = /^[a-z0-9]+$/;
const FLAG = /^--([^=]+)(?:=(.*))?$/s;

export interface CreateArguments {
  readonly kindWords: ReadonlyArray<string>;
  /** Each `--<input> <value>` or `--<input>=<value>` given, by input name. */
  readonly flags: { readonly [inputName: string]: string };
}

/** The words before the first flag name the kind; everything from the first flag on is `--<input> <value>` pairs. */
export function parseCreateArguments(args: ReadonlyArray<string>): e.Result.Result<CreateArguments, string> {
  const firstFlag = args.findIndex((arg) => arg.startsWith("--"));
  const kindWords = firstFlag === -1 ? args : args.slice(0, firstFlag);
  const flags: Record<string, string> = {};
  for (let index = firstFlag === -1 ? args.length : firstFlag; index < args.length; index++) {
    const match = FLAG.exec(args[index]!);
    if (match === null) return e.Result.fail(`expected a --<input> flag, got ${JSON.stringify(args[index])}`);
    const [, inputName, inlineValue] = match;
    const value = inlineValue !== undefined ? inlineValue : args[++index];
    if (value === undefined) return e.Result.fail(`--${inputName} needs a value`);
    if (Object.hasOwn(flags, inputName!)) return e.Result.fail(`--${inputName} is given twice`);
    flags[inputName!] = value;
  }
  return e.Result.succeed({ kindWords, flags });
}

/**
 * `jive-abstract-<kind words joined by hyphens>`. A hyphen is always a menu level, never part of a word, so a kind
 * word holds none: `agentic workflow` is `jive-abstract-agentic-workflow`.
 */
export function abstractNameForKind(kindWords: ReadonlyArray<string>): e.Result.Result<string, string> {
  if (kindWords.length === 0) return e.Result.fail("name the kind of package to create, e.g. `create library`");
  const bad = kindWords.filter((word) => !KIND_WORD.test(word));
  if (bad.length > 0) {
    return e.Result.fail(`${bad.map((word) => JSON.stringify(word)).join(", ")}: each word of a kind is lowercase letters and digits; a hyphen separates words, so give them as separate words`);
  }
  return e.Result.succeed(`${ABSTRACT_NAME_PREFIX}${kindWords.join("-")}`);
}

const RenderedManifest = e.Schema.fromJsonString(e.Schema.Struct({ name: e.Schema.String }));

/** The new package's name, from its rendered package.json; it decides where the package goes. */
export function newPackageName(files: ReadonlyArray<TemplateFile>): e.Result.Result<string, string> {
  const manifest = files.find((file) => file.path === "package.json");
  if (manifest === undefined) return e.Result.fail("the template has no package.json");
  const decoded = e.Schema.decodeUnknownResult(RenderedManifest)(manifest.contents);
  if (e.Result.isFailure(decoded)) return e.Result.fail("the template's package.json renders without a name");
  const { name } = decoded.success;
  return isPackageName(name) ? e.Result.succeed(name) : e.Result.fail(`${JSON.stringify(name)} is not an npm package name`);
}

const JsonObject = e.Schema.fromJsonString(e.Schema.Record(e.Schema.String, e.Schema.Unknown));
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies"] as const;

/**
 * Pins the new package's dependency on the abstract it was made from to the version it was made from, wherever its
 * package.json lists it: the sample in the abstract's repository names whichever version was current when it was
 * written.
 */
export function pinAbstractDependency(input: {
  readonly files: ReadonlyArray<TemplateFile>;
  readonly abstractName: string;
  readonly version: string;
}): ReadonlyArray<TemplateFile> {
  return input.files.map((file) => {
    if (file.path !== "package.json") return file;
    const decoded = e.Schema.decodeUnknownResult(JsonObject)(file.contents);
    if (e.Result.isFailure(decoded)) return file;
    const manifest: Record<string, unknown> = { ...decoded.success };
    let pinned = false;
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (typeof dependencies === "object" && dependencies !== null && Object.hasOwn(dependencies, input.abstractName)) {
        manifest[field] = { ...dependencies, [input.abstractName]: input.version };
        pinned = true;
      }
    }
    return pinned ? { path: file.path, contents: `${JSON.stringify(manifest, null, 2)}\n` } : file;
  });
}
