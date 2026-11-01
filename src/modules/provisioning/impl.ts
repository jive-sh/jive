import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { TOOL_NAME } from "@/constants";
import { modules } from "@/modules";
import { ProvisionAnswer } from "@/modules/jive-server/interface";
import { ProvisionFailed, type IProvisioning } from "./interface";

const IN_PROGRESS_TIMEOUT_MS = 10 * 60 * 1000;

export class ProvisioningImpl extends implementing(modules.provisioning).uses(modules.session, modules.jiveServer) implements IProvisioning {
  *ensure({ kind, instance }: { readonly kind: string; readonly instance: unknown }): EffectGen<{ readonly instanceId: string }, ProvisionFailed> {
    const { session: sessions, jiveServer } = this.dependencies;
    // No sign-in here: a pipeline signs in with `jive login --cicd` first, and the server refuses a person's session.
    const maybeSession = yield* sessions.current();
    if (e.Option.isNone(maybeSession)) {
      return yield* new ProvisionFailed({ reason: `not signed in to Jive; run \`${TOOL_NAME} login --cicd\` first` });
    }
    const deadline = (yield* e.Clock.currentTimeMillis) + IN_PROGRESS_TIMEOUT_MS;
    while (true) {
      const answer = yield* e.pipe(
        e.Effect.gen(() => jiveServer.provision({ session: maybeSession.value, kind, instance })),
        e.Effect.mapError(({ reason }) => new ProvisionFailed({ reason: `the server could not provision ${kind}: ${reason}` })),
      );
      if (ProvisionAnswer.$is("Ready")(answer)) return { instanceId: answer.instanceId };
      if (ProvisionAnswer.$is("Refused")(answer)) {
        return yield* new ProvisionFailed({ reason: `Jive refused to provision ${kind}: ${answer.reason}` });
      }
      if (ProvisionAnswer.$is("PersonNeeded")(answer)) {
        return yield* new ProvisionFailed({ reason: `${kind} needs a person first: ${answer.reason} (${answer.url})` });
      }
      if ((yield* e.Clock.currentTimeMillis) + answer.retryAfterSeconds * 1000 > deadline) {
        return yield* new ProvisionFailed({ reason: `another deploy was still provisioning this ${kind} instance after 10 minutes` });
      }
      yield* e.Effect.log(`Another deploy is provisioning this ${kind} instance; asking again in ${answer.retryAfterSeconds}s`);
      yield* e.Effect.sleep(e.Duration.seconds(answer.retryAfterSeconds));
    }
  }
}
