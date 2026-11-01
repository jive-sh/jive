# design

Writes the Jive design page, `design/jive_design.html` in this repository, which is never edited by hand. Jive's design
is public, so the page's source (`design.json`) and its generator live here, beside the CLI.

```sh
bun run --cwd design generate
```

The page's Packages section reads every Jive package folder, so the generator runs only when this repository is checked
out at `packages/@jive-sh/jive` in a monorepo, and reads that monorepo's `packages/`. Run from a clone of
jive-sh/jive on its own, it stops with `NotInsideMonorepo` and writes nothing.

## Where each fact comes from

| On the page | Source |
| --- | --- |
| Open decisions | `design.json` → `openDecisions` |
| To delete or unpublish | `design.json` → `packagesToDelete` (name, reason); what is left (npm version, folder) is read from npm and `packages/`, and an entry with nothing left is reported as stale |
| Which packages appear | every folder `packages/<name>` and `packages/@<scope>/<name>` that `design.json` lists, a group's `namePrefix` matches, or that is built with Jive (a `jive` block, or a dependency on a `jive-abstract-*` package) |
| Group of a package | its `group` in `design.json`, else the first group whose `namePrefix` matches, else `groupForOtherPackages` |
| Indentation (extends) | the package's most specific `jive-abstract-*` dependency, when that package is in the same group; a backend's `jive["backend-convex"].clientPackageName` sits under the backend |
| Version badge | npm's `latest` tag |
| built / empty / docs only / stub | the folder: a `package.json`; nothing; only Markdown; other files |
| building, proposed | `building` and `proposed` in `design.json` |
| Purpose line | `purpose` in `design.json`, written without a final period |
| Row order | the order of `design.json`'s `packages`; packages it doesn't list follow by name |
| jive CLI commands and descriptions | `bun src/entrypoints/jive.ts --help`, run from this repository, and the same with each command's words for its subcommands (`jive git --help`) |
| stub / implemented | `jiveCli.stubs` in `design.json`, as the words after `jive`, because the help can't show it; a stub the help no longer lists is reported as stale |
| CLI docs | `jiveCli.docs` in `design.json`, paths from this repository's root; linked when the file exists, "not written" until then |

`design.json` holds only what the code can't show. A new package folder or an npm publish shows up on the next run
with no edit here. The run warns about entries that no longer match: a `proposed` package whose folder now exists, or
an entry with no folder, or a CLI stub the help no longer lists.

The page is not committed (`.gitignore`): its versions come from npm, so a committed copy would go stale at every publish,
and its doc links are `file://` paths on the machine that generated it.
