import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { modules } from "@/modules";
import type { Session } from "@/modules/jive-server/interface";
import { AccountKeyError, type AccountKey, type IAccountKey } from "./interface";

const OPENSSH_ED25519_PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+=* \S+$/;

export class AccountKeyImpl extends implementing(modules.accountKey).uses(
  modules.session,
  modules.jiveServer,
  OSPlatform,
  e.FileSystem.FileSystem,
) implements IAccountKey {
  *ensure(): EffectGen<AccountKey, AccountKeyError> {
    const { jiveServer } = this.dependencies;
    const session = yield* this.session();
    const { publicKey } = yield* e.pipe(
      e.Effect.gen(() => jiveServer.createSshKey(session)),
      e.Effect.mapError(({ reason }) => new AccountKeyError({ reason: `the server could not create or return your SSH key: ${reason}` })),
    );
    const publicKeyFile = yield* this.publicKeyFile();
    const fs = this.getDependency(e.FileSystem.FileSystem);
    yield* e.pipe(
      e.Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(publicKeyFile), { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(publicKeyFile, `${publicKey}\n`);
      }),
      e.Effect.mapError((error) => new AccountKeyError({ reason: `could not write ${publicKeyFile}: ${error.message}` })),
    );
    return { publicKey, publicKeyFile };
  }

  *cached(): EffectGen<e.Option.Option<AccountKey>> {
    const fs = this.getDependency(e.FileSystem.FileSystem);
    const publicKeyFile = yield* this.publicKeyFile();
    const maybeContents = yield* e.Effect.option(fs.readFileString(publicKeyFile));
    return e.pipe(
      maybeContents,
      e.Option.map((contents) => contents.trim()),
      e.Option.filter((publicKey) => OPENSSH_ED25519_PUBLIC_KEY.test(publicKey)),
      e.Option.map((publicKey) => ({ publicKey, publicKeyFile })),
    );
  }

  *sign(data: Uint8Array): EffectGen<Uint8Array, AccountKeyError> {
    const { jiveServer, session: sessions } = this.dependencies;
    const session = yield* this.session();
    const signed = yield* e.Effect.result(e.Effect.gen(() => jiveServer.signWithSshKey(session, data)));
    if (e.Result.isSuccess(signed)) return signed.success;
    // Ask whether the session is still honoured before blaming it: a server that cannot be reached fails both calls.
    const maybeAccount = yield* e.pipe(
      e.Effect.gen(() => jiveServer.accountOf(session)),
      e.Effect.mapError(({ reason }) => new AccountKeyError({ reason: `the server could not sign: ${signed.failure.reason}; ${reason}` })),
    );
    if (e.Option.isSome(maybeAccount)) {
      return yield* new AccountKeyError({ reason: `the server could not sign: ${signed.failure.reason}` });
    }
    yield* sessions.forget();
    const renewed = yield* this.session();
    return yield* e.pipe(
      e.Effect.gen(() => jiveServer.signWithSshKey(renewed, data)),
      e.Effect.mapError(({ reason }) => new AccountKeyError({ reason: `the server could not sign: ${reason}` })),
    );
  }

  private *session(): EffectGen<Session, AccountKeyError> {
    return yield* e.pipe(
      e.Effect.gen(() => this.dependencies.session.ensureSignedIn()),
      e.Effect.mapError(({ reason }) => new AccountKeyError({ reason: `not signed in to Jive: ${reason}` })),
    );
  }

  private *publicKeyFile(): EffectGen<string> {
    return jiveHomePaths(yield* this.dependencies.OSPlatform.getHomeDirectory()).accountPublicKeyFile;
  }
}
