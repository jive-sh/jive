import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import type { ISigningAgent } from "./interface";
import { failure, identitiesAnswer, parsePublicKeyLine, parseRequest, sameBytes, signResponse } from "./protocol";

export class SigningAgentImpl extends implementing(modules.signingAgent).uses(modules.accountKey) implements ISigningAgent {
  *answer(message: Uint8Array): EffectGen<Uint8Array> {
    const { accountKey } = this.dependencies;
    const request = parseRequest(message);
    if (request._tag === "Unsupported") return failure();

    const maybeKey = yield* accountKey.cached();
    if (e.Option.isNone(maybeKey)) {
      yield* e.Effect.logWarning("No account public key on this machine yet; run `jive git setup` to fetch it");
      return request._tag === "RequestIdentities" ? identitiesAnswer([]) : failure();
    }
    const identity = parsePublicKeyLine(maybeKey.value.publicKey);
    if (request._tag === "RequestIdentities") return identitiesAnswer([identity]);

    if (!sameBytes(request.keyBlob, identity.keyBlob)) {
      yield* e.Effect.logWarning("Refused a sign request for a key this agent does not hold");
      return failure();
    }
    const signed = yield* e.Effect.result(e.Effect.gen(() => accountKey.sign(request.data)));
    if (e.Result.isFailure(signed)) {
      yield* e.Effect.logError(`Could not sign: ${signed.failure.reason}`);
      return failure();
    }
    yield* e.Effect.log(`Signed ${request.data.length} bytes`);
    return signResponse(signed.success);
  }
}
