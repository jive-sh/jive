import { expect, test } from "bun:test";
import * as e from "effect";
import type { FunctionReference, FunctionReturnType } from "convex/server";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import type { api } from "@jive-sh/server-client";
import {
  AccountValue,
  ClaimValue,
  OpenedSignInRequestValue,
  PipelineSignInValue,
  ProvisionValue,
  PublicKeyValue,
  SignatureValue,
} from "./contract";

/**
 * jive's decoders against `@jive-sh/server-client`, the server's own published types. The type checks fail `tsc` (and
 * so the audit) when the server can answer something a decoder rejects; the round trips run a value of the server's
 * type through `convex_encoded_json` the way a call does, which is where bytes once came back in a shape jive misread.
 */

/** True when every answer the server declares for `F` is a value `S` decodes to. */
type Decodes<S extends e.Schema.Top, F extends FunctionReference<"query" | "action">> = [FunctionReturnType<F>] extends [S["Type"]] ? true : false;

const contract: {
  readonly open: Decodes<typeof OpenedSignInRequestValue, typeof api.signInRequests.open>;
  readonly claim: Decodes<typeof ClaimValue, typeof api.signInRequests.claim>;
  readonly pipelineSignIn: Decodes<typeof PipelineSignInValue, typeof api.pipelineSessions.signIn>;
  readonly provision: Decodes<typeof ProvisionValue, typeof api.provision.default>;
  readonly account: Decodes<typeof AccountValue, typeof api.accounts.me>;
  readonly publicKey: Decodes<typeof PublicKeyValue, typeof api.ssh.publicKey>;
  readonly sign: Decodes<typeof SignatureValue, typeof api.ssh.sign>;
} = { open: true, claim: true, pipelineSignIn: true, provision: true, account: true, publicKey: true, sign: true };

const roundTrip = (value: Value) => jsonToConvex(JSON.parse(JSON.stringify(convexToJson(value))));

test("every decoder accepts what the server's types say it answers", () => {
  expect(Object.values(contract).every(Boolean)).toBe(true);
});

test("a signature comes back as bytes through convex_encoded_json", () => {
  const signature = new Uint8Array(84).fill(7).buffer;
  const decoded = e.Schema.decodeUnknownSync(SignatureValue)(roundTrip({ signature }));
  expect(new Uint8Array(decoded.signature)).toEqual(new Uint8Array(signature));
});

test("a sign-in request decodes with and without the phone count", () => {
  const opened = { requestId: "r", claimSecret: "s", loginUrl: "https://jive.sh/login?request=r", expiresAt: 1 };
  expect(e.Schema.decodeUnknownSync(OpenedSignInRequestValue)(roundTrip({ ...opened, approvalDevices: 2 })).approvalDevices).toBe(2);
  expect(e.Schema.decodeUnknownSync(OpenedSignInRequestValue)(roundTrip(opened)).approvalDevices).toBeUndefined();
});
