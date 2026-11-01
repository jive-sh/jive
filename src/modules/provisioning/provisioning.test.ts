import { expect, test } from "bun:test";
import * as e from "effect";
import { modules } from "@/modules";
import { JiveServerImpl } from "@/modules/jive-server/impl";
import { ProvisionAnswer, type Session } from "@/modules/jive-server/interface";
import { SessionImpl } from "@/modules/session/impl";
import { ProvisioningImpl } from "./impl";

/** `provision` against a fake server answering a scripted sequence, and a fake stored session. */

const session: Session = { sessionToken: "jive_pipeline_session", expiresAt: Date.now() + 3_600_000 };

function run(answers: ReadonlyArray<ProvisionAnswer>, stored: e.Option.Option<Session> = e.Option.some(session)) {
  const calls: Array<{ sessionToken: string; kind: string; instance: unknown }> = [];
  const layer = e.pipe(
    ProvisioningImpl.Layer,
    e.Layer.provideMerge(SessionImpl.mockLayer({ *current() { return stored; } })),
    e.Layer.provideMerge(JiveServerImpl.mockLayer({
      *provision({ session: given, kind, instance }: { session: Session; kind: string; instance: unknown }) {
        calls.push({ sessionToken: given.sessionToken, kind, instance });
        return answers[Math.min(calls.length, answers.length) - 1]!;
      },
    })),
  );
  const outcome = e.Effect.runPromise(e.pipe(
    e.Effect.gen(function* () {
      return yield* (yield* modules.provisioning).ensure({ kind: "connector-package-registry", instance: { packageName: "@acme/widget" } });
    }),
    e.Effect.result,
    e.Effect.provide(layer),
  ));
  return { outcome, calls };
}

test("sends the session, the kind and the instance, and answers the instance id when it is ready", async () => {
  const { outcome, calls } = run([ProvisionAnswer.Ready({ instanceId: "npm:@acme/widget" })]);
  const result = await outcome;
  expect(e.Result.isSuccess(result) && result.success).toEqual({ instanceId: "npm:@acme/widget" });
  expect(calls).toEqual([{ sessionToken: "jive_pipeline_session", kind: "connector-package-registry", instance: { packageName: "@acme/widget" } }]);
});

test("asks again while another deploy provisions the instance", async () => {
  const { outcome, calls } = run([
    ProvisionAnswer.InProgress({ retryAfterSeconds: 0 }),
    ProvisionAnswer.InProgress({ retryAfterSeconds: 0 }),
    ProvisionAnswer.Ready({ instanceId: "npm:@acme/widget" }),
  ]);
  expect(e.Result.isSuccess(await outcome)).toBe(true);
  expect(calls.length).toBe(3);
});

test("gives up rather than wait past 10 minutes", async () => {
  const { outcome, calls } = run([ProvisionAnswer.InProgress({ retryAfterSeconds: 601 })]);
  const result = await outcome;
  expect(e.Result.isFailure(result) && result.failure.reason).toContain("after 10 minutes");
  expect(calls.length).toBe(1);
});

test("a refusal fails with the server's reason", async () => {
  const reason = "the organization jive-sh has no implementation configured for connector-package-registry";
  const result = await run([ProvisionAnswer.Refused({ reason })]).outcome;
  expect(e.Result.isFailure(result) && result.failure.reason).toContain(reason);
});

test("an outside system needing a person fails with its page, without asking again", async () => {
  const { outcome, calls } = run([ProvisionAnswer.PersonNeeded({ reason: "npm wants a second factor", url: "https://www.npmjs.com/auth/x" })]);
  const result = await outcome;
  expect(e.Result.isFailure(result) && result.failure.reason).toContain("https://www.npmjs.com/auth/x");
  expect(calls.length).toBe(1);
});

test("with no session it calls nothing and says to sign the job in", async () => {
  const { outcome, calls } = run([ProvisionAnswer.Ready({ instanceId: "x" })], e.Option.none());
  const result = await outcome;
  expect(e.Result.isFailure(result) && result.failure.reason).toContain("jive login --cicd");
  expect(calls.length).toBe(0);
});
