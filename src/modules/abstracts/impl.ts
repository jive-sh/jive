import * as e from "effect";
import * as path from "node:path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { PublishedAbstractManifest, TEMPLATE_DIRECTORY, type TemplateFile } from "jive-abstract-abstraction";
import { modules } from "@/modules";
import { isBuildOfCheckout, packageRelativePath } from "@/modules/tool-state/workspace-layout";
import { AbstractSource, AbstractUnavailable, type Abstract, type IAbstracts } from "./interface";

export const NPM_REGISTRY_URL = "https://registry.npmjs.org";

/** jive-abstract-library builds the package it publishes into `dist/base`. */
const BUILT_PACKAGE_DIRECTORY = path.join("dist", "base");
/** npm puts a package's files under `package/` in its tarball. */
const TARBALL_ROOT = "package/";

/** The parts of npm's abbreviated package document a download needs. */
const Packument = e.Schema.Struct({
  "dist-tags": e.Schema.Struct({ latest: e.Schema.String }),
  versions: e.Schema.Record(e.Schema.String, e.Schema.Struct({ dist: e.Schema.Struct({ tarball: e.Schema.String }) })),
});

const CheckoutManifest = e.Schema.fromJsonString(e.Schema.Struct({ version: e.Schema.NonEmptyString }));
const PublishedManifest = e.Schema.fromJsonString(PublishedAbstractManifest);

export class AbstractsImpl extends implementing(modules.abstracts).uses(HttpClient.HttpClient, e.FileSystem.FileSystem) implements IAbstracts {
  *get({ name, workspaceRoot }: { readonly name: string; readonly workspaceRoot: string }): EffectGen<Abstract, AbstractUnavailable> {
    const checkout = path.join(workspaceRoot, packageRelativePath(name));
    const built = path.join(checkout, BUILT_PACKAGE_DIRECTORY);
    if (yield* this.exists(path.join(built, TEMPLATE_DIRECTORY))) return yield* this.fromWorkspace({ name, checkout, built });
    return yield* this.fromRegistry(name);
  }

  private *fromWorkspace({ name, checkout, built }: { readonly name: string; readonly checkout: string; readonly built: string }): EffectGen<Abstract, AbstractUnavailable> {
    const fs = this.getDependency(e.FileSystem.FileSystem);
    const read = (file: string) => e.pipe(fs.readFileString(file), e.Effect.mapError(({ message }) => new AbstractUnavailable({ reason: `cannot read ${file}: ${message}` })));
    const manifest = yield* decode({ schema: PublishedManifest, text: yield* read(path.join(built, "package.json")), problem: `${built}/package.json ${NOT_AN_ABSTRACT}` });
    const { version } = yield* decode({ schema: CheckoutManifest, text: yield* read(path.join(checkout, "package.json")), problem: `${checkout}/package.json has no version` });
    if (manifest.name !== name || !isBuildOfCheckout({ builtVersion: manifest.version, checkoutVersion: version })) {
      return yield* new AbstractUnavailable({ reason: `the workspace's build of ${name} at ${built} is ${manifest.name} ${manifest.version}, not of its checkout's version ${version}; run \`bun run jive:cicd:build\` in ${checkout}` });
    }
    const templateDir = path.join(built, TEMPLATE_DIRECTORY);
    const entries = yield* e.pipe(fs.readDirectory(templateDir, { recursive: true }), e.Effect.mapError(({ message }) => new AbstractUnavailable({ reason: `cannot list ${templateDir}: ${message}` })));
    const templateFiles: Array<TemplateFile> = [];
    for (const entry of [...entries].sort()) {
      const file = path.join(templateDir, entry);
      const info = yield* e.pipe(fs.stat(file), e.Effect.mapError(({ message }) => new AbstractUnavailable({ reason: `cannot read ${file}: ${message}` })));
      if (info.type === "File") templateFiles.push({ path: entry.split(path.sep).join("/"), contents: yield* read(file) });
    }
    return { name, version, replacements: manifest.jive.abstract.replacements, templateFiles, source: AbstractSource.Workspace({ directory: built }) };
  }

  private *fromRegistry(name: string): EffectGen<Abstract, AbstractUnavailable> {
    const client = this.getDependency(HttpClient.HttpClient);
    const documentUrl = `${NPM_REGISTRY_URL}/${name.replace("/", "%2f")}`;
    const unreachable = (url: string) => (error: { readonly reason: { readonly _tag: string } }) =>
      new AbstractUnavailable({ reason: `could not reach ${url} (${error.reason._tag})` });

    const response = yield* e.pipe(
      client.execute(e.pipe(HttpClientRequest.get(documentUrl), HttpClientRequest.setHeader("accept", "application/vnd.npm.install-v1+json"))),
      e.Effect.mapError(unreachable(documentUrl)),
    );
    if (response.status === 404) return yield* new AbstractUnavailable({ reason: `npm has no package named ${name}` });
    const document = yield* e.pipe(
      HttpClientResponse.filterStatusOk(response),
      e.Effect.flatMap(HttpClientResponse.schemaBodyJson(Packument)),
      e.Effect.mapError(() => new AbstractUnavailable({ reason: `${documentUrl} answered ${response.status} in an unexpected shape` })),
    );
    const version = document["dist-tags"].latest;
    const published = document.versions[version];
    if (published === undefined) return yield* new AbstractUnavailable({ reason: `${documentUrl} names ${version} its latest version but does not list it` });
    const tarballUrl = published.dist.tarball;

    const tarball = yield* e.pipe(
      client.execute(HttpClientRequest.get(tarballUrl)),
      e.Effect.flatMap(HttpClientResponse.filterStatusOk),
      e.Effect.flatMap((ok) => ok.arrayBuffer),
      e.Effect.mapError(unreachable(tarballUrl)),
    );
    const files = yield* e.Effect.tryPromise({
      try: async () => {
        const entries = await new Bun.Archive(tarball).files();
        return Promise.all([...entries].map(async ([entry, file]) => ({ path: entry, contents: await file.text() })));
      },
      catch: (error) => new AbstractUnavailable({ reason: `${tarballUrl} is not a package tarball: ${error instanceof Error ? error.message : String(error)}` }),
    });

    const manifestFile = files.find((file) => file.path === `${TARBALL_ROOT}package.json`);
    if (manifestFile === undefined) return yield* new AbstractUnavailable({ reason: `${tarballUrl} holds no package.json` });
    const manifest = yield* decode({ schema: PublishedManifest, text: manifestFile.contents, problem: `${name}@${version}'s package.json ${NOT_AN_ABSTRACT}` });
    const templatePrefix = `${TARBALL_ROOT}${TEMPLATE_DIRECTORY}/`;
    const templateFiles = files
      .filter((file) => file.path.startsWith(templatePrefix))
      .map((file) => ({ path: file.path.slice(templatePrefix.length), contents: file.contents }))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (templateFiles.length === 0) return yield* new AbstractUnavailable({ reason: `${name}@${version} has no ${TEMPLATE_DIRECTORY}/: it was not built with jive-abstract-abstraction` });
    return { name, version, replacements: manifest.jive.abstract.replacements, templateFiles, source: AbstractSource.Registry({ tarballUrl }) };
  }

  private *exists(file: string): EffectGen<boolean> {
    return yield* e.pipe(this.getDependency(e.FileSystem.FileSystem).exists(file), e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false)));
  }
}

const NOT_AN_ABSTRACT = "lacks a name, a version or jive.abstract.replacements: the abstract was not built with jive-abstract-abstraction";

function decode<A>({ schema, text, problem }: { readonly schema: e.Schema.Codec<A, string>; readonly text: string; readonly problem: string }) {
  return e.pipe(e.Schema.decodeUnknownEffect(schema)(text), e.Effect.mapError(() => new AbstractUnavailable({ reason: problem })));
}
