import { Effect, Layer, Option, Schema, pipe } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { NpmRegistry, NpmRegistryUnreachable, type INpmRegistry } from "./interface";

export const NPM_REGISTRY_URL = "https://registry.npmjs.org";

const Packument = Schema.Struct({
  body: Schema.Struct({
    "dist-tags": Schema.Struct({ latest: Schema.OptionFromOptionalKey(Schema.String) }),
  }),
});

class NpmRegistryImpl implements INpmRegistry {
  constructor(private readonly httpClient: HttpClient.HttpClient) {}

  *latestVersion(packageName: string): Effect.fn.Return<Option.Option<string>, NpmRegistryUnreachable> {
    // A scoped name keeps its @ but escapes the slash: @jive-sh%2Fserver.
    const request = pipe(
      HttpClientRequest.get(`${NPM_REGISTRY_URL}/${packageName.replace("/", "%2F")}`),
      HttpClientRequest.setHeader("accept", "application/vnd.npm.install-v1+json"),
    );
    const unreachable = (reason: string) => new NpmRegistryUnreachable({ packageName, reason });
    const response = yield* pipe(
      this.httpClient.execute(request),
      Effect.mapError((error) => unreachable(error.message)),
    );
    if (response.status === 404) return Option.none();
    if (response.status !== 200) return yield* unreachable(`HTTP ${response.status}`);
    const packument = yield* pipe(
      HttpClientResponse.schemaJson(Packument)(response),
      Effect.mapError((error) => unreachable(error.message)),
    );
    return packument.body["dist-tags"].latest;
  }
}

export const NpmRegistryLive = Layer.effect(
  NpmRegistry,
  Effect.gen(function* () {
    return new NpmRegistryImpl(yield* HttpClient.HttpClient);
  }),
);
