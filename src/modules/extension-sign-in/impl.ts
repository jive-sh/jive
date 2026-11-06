import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import type { OpenedSignInRequest } from "@/modules/jive-server/interface";
import type { IExtensionSignIn } from "./interface";

export class ExtensionSignInImpl extends implementing(modules.extensionSignIn) implements IExtensionSignIn {
  private readonly request = e.Ref.makeUnsafe(e.Option.none<OpenedSignInRequest>());
  private readonly firstRequest = e.Ref.makeUnsafe(e.Deferred.makeUnsafe<OpenedSignInRequest>());

  *expect(): EffectGen<void> {
    yield* e.Ref.set(this.request, e.Option.none());
    yield* e.Ref.set(this.firstRequest, e.Deferred.makeUnsafe<OpenedSignInRequest>());
  }

  *opened(request: OpenedSignInRequest): EffectGen<void> {
    yield* e.Ref.set(this.request, e.Option.some(request));
    yield* e.Deferred.succeed(yield* e.Ref.get(this.firstRequest), request);
  }

  *awaitOpened(): EffectGen<OpenedSignInRequest> {
    return yield* e.Deferred.await(yield* e.Ref.get(this.firstRequest));
  }

  *waiting(): EffectGen<e.Option.Option<OpenedSignInRequest>> {
    return e.Option.filter(yield* e.Ref.get(this.request), (request) => request.expiresAt > Date.now());
  }

  *ended(): EffectGen<void> {
    yield* e.Ref.set(this.request, e.Option.none());
  }
}
