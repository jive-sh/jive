import { pathToFileURL } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { test as buntest, expect } from "bun:test";
import { Effect, Layer, Option, Path, Result, pipe } from "effect";
import { DesignDataFileLive } from "../src/modules/design-data/impl";
import { DesignDataFile, type DesignData } from "../src/modules/design-data/interface";
import { deriveDesignPage } from "../src/modules/design-page/derive";
import { DesignPageGeneratorLive } from "../src/modules/design-page/impl";
import { DesignPageGenerator } from "../src/modules/design-page/interface";
import { parseHelp } from "../src/modules/jive-cli/help";
import { JiveCli, type CliCommand, type IJiveCli } from "../src/modules/jive-cli/interface";
import { NpmRegistry, type INpmRegistry } from "../src/modules/npm-registry/interface";
import { FolderContents } from "../src/modules/package-folders/interface";
import { PackageFoldersLive } from "../src/modules/package-folders/impl";

const publishedVersions: Record<string, string> = {
  "@other/unrelated": "0.0.1",
  "jive-abstract-base": "2.0.0",
  "@acme/server-client": "0.1.0",
  "@acme/building": "1.2.0",
};

const fakeNpmRegistry: INpmRegistry = {
  *latestVersion(packageName) {
    return Option.fromNullishOr(publishedVersions[packageName]);
  },
};

const cliCommand = (
  words: ReadonlyArray<string>,
  description: string | undefined,
  subcommands: ReadonlyArray<CliCommand> = [],
): CliCommand => ({ words, description: Option.fromNullishOr(description), subcommands });

const fakeJiveCli: IJiveCli = {
  *commands() {
    return [
      cliCommand(["make"], "make a <repo>"),
      cliCommand(["git"], undefined, [cliCommand(["git", "setup"], "set up git")]),
      cliCommand(["whoami"], "print the account"),
    ];
  },
};

const layer = pipe(
  DesignPageGeneratorLive,
  Layer.provideMerge(
    Layer.mergeAll(
      DesignDataFileLive,
      PackageFoldersLive,
      Layer.succeed(NpmRegistry, fakeNpmRegistry),
      Layer.succeed(JiveCli, fakeJiveCli),
    ),
  ),
  Layer.provideMerge(BunServices.layer),
);

function test(name: string, body: () => Effect.fn.Return<void, unknown, DesignPageGenerator | DesignDataFile | Path.Path>) {
  buntest(name, async () => {
    await Effect.runPromise(Effect.provide(Effect.gen(body), layer));
  });
}

/** Each row as "name | badge | text", the way it reads on the page. */
const rowsOf = (html: string) =>
  [...html.matchAll(/<div class="row"><span class="name[^"]*">(.*?)<\/span>(?:<span><span class="b [a-z]+">(.*?)<\/span><\/span>|<span><\/span>)<span[^>]*>(.*?)<\/span><\/div>/g)].map(
    ([, name, badge, text]) => `${name} | ${badge ?? ""} | ${text}`,
  );

function* fixtureInputs() {
  const path = yield* Path.Path;
  const fixture = path.join(import.meta.dir, "fixture");
  return {
    designDataPath: path.join(fixture, "design.json"),
    packagesRoot: path.join(fixture, "packages"),
    repoRoot: fixture,
    jiveCliEntrypoint: "cli.ts",
  };
}

test("derives the tree, statuses and npm versions from the fixture packages", function* () {
  const { html, staleNotes } = yield* (yield* DesignPageGenerator).generate(yield* fixtureInputs());
  expect(rowsOf(html)).toEqual([
    "1. Pick one | open | Context first. <b>a.</b> First &lt;option&gt; (recommended). <b>b.</b> Second option.",
    "@other/unrelated | delete | Unused. Left: npm 0.0.1, folder packages/@other/unrelated.",
    "@acme/ |  | Acme itself",
    "├─ @acme/server | built | Backend.",
    "│  └─ @acme/server-client | 0.1.0 | Its client.",
    "├─ @acme/building | building | Work (1.2.0 on npm). Next: ship it.",
    "└─ @acme/unlisted | built | ",
    "jive-abstract-* |  | ",
    "├─ jive-abstract-base | 2.0.0 | Base.",
    "│  ├─ jive-abstract-proposed | proposed | Planned.",
    "│  └─ jive-abstract-child | built | ",
    "│     └─ jive-abstract-grandchild | built | ",
    "├─ jive-abstract-docs | docs only | ",
    "├─ jive-abstract-empty | empty | ",
    "└─ jive-abstract-stub | stub | ",
    "elsewhere |  | ",
    "└─ @other/consumer | built | ",
    "├─ jive make | stub | make a &lt;repo&gt;",
    "├─ jive git |  | ",
    "│  └─ jive git setup | implemented | set up git",
    "└─ jive whoami | implemented | print the account",
    `<a href="${pathToFileURL((yield* Path.Path).join(import.meta.dir, "fixture", "docs", "cli.md")).href}">docs/cli.md</a> | doc | `,
    "docs/not-yet.md | not written | ",
  ]);
  expect(staleNotes).toEqual([
    "@acme/gone has no package folder: delete its entry or mark it proposed",
    `jive-abstract-docs has a package folder now: delete "proposed" from its entry`,
    "@other/already-gone is gone from npm and packages/: delete its packagesToDelete entry",
    `jiveCli.stubs: "jive gone" is not in the CLI's help: delete it`,
  ]);
});

test("rejects design data that names a group that does not exist", function* () {
  const path = yield* Path.Path;
  const designDataFile = yield* DesignDataFile;
  const result = yield* Effect.result(
    Effect.gen(() => designDataFile.load(path.join(import.meta.dir, "fixture", "design-unknown-group.json"))),
  );
  expect(Result.isFailure(result) && result.failure.reason).toBe(
    `x names group "missing", which is neither in groups nor groupForOtherPackages`,
  );
});

buntest("fails when a package extends two abstracts and neither extends the other", async () => {
  const data: DesignData = {
    openDecisions: [],
    packagesToDelete: [],
    groups: [],
    groupForOtherPackages: { label: "other", description: Option.none() },
    packages: [],
    jiveCli: { stubs: [], docs: [] },
  };
  const manifest = (abstractDependencies: ReadonlyArray<string>) =>
    FolderContents.Manifest({ hasJiveBlock: true, abstractDependencies, generatedClientName: Option.none() });
  const result = await Effect.runPromise(
    Effect.result(
      Effect.gen(() =>
        deriveDesignPage({
          data,
          folders: [
            { name: "jive-abstract-a", path: "jive-abstract-a", contents: manifest([]) },
            { name: "jive-abstract-b", path: "jive-abstract-b", contents: manifest([]) },
            { name: "consumer", path: "consumer", contents: manifest(["jive-abstract-a", "jive-abstract-b"]) },
          ],
          publishedVersionOf: () => Option.none(),
        }),
      ),
    ),
  );
  expect(Result.isFailure(result) && result.failure._tag).toBe("AmbiguousExtends");
});

buntest("reads the command list from jive's help, including commands with no description", () => {
  const help = [
    "Usage: jive <command>",
    "",
    "Commands:",
    "  create    create a repo from a template",
    "  git",
    "  init     ",
    "",
    "Flags:",
    "  --help, -h            Show this help",
  ].join("\n");
  expect(parseHelp(help)).toEqual(
    Option.some([
      { name: "create", description: Option.some("create a repo from a template") },
      { name: "git", description: Option.none() },
      { name: "init", description: Option.none() },
    ]),
  );
  expect(parseHelp("Usage: jive init [flags]\n\nFlags:\n  --help, -h   Show this help\n")).toEqual(Option.some([]));
  expect(parseHelp("error: Cannot find module")).toEqual(Option.none());
});
