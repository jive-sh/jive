import { Context, Data } from "effect";
import type { Effect, Option } from "effect";

export class NpmRegistryUnreachable extends Data.TaggedError("NpmRegistryUnreachable")<{
  readonly packageName: string;
  readonly reason: string;
}> {}

export interface INpmRegistry {
  /** The version npm's `latest` tag points at, or none when the package was never published. */
  latestVersion(packageName: string): Effect.fn.Return<Option.Option<string>, NpmRegistryUnreachable>;
}

export class NpmRegistry extends Context.Service<NpmRegistry, INpmRegistry>()("NpmRegistry") {}
