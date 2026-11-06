import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { modules } from "@/modules";
import type { JiveServerError, Session } from "@/modules/jive-server/interface";
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
    const publicKey = yield* this.withSession({
      failure: "the server could not return your SSH key",
      call: (session) => jiveServer.sshPublicKey(session),
    });
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
    const { jiveServer } = this.dependencies;
    return yield* this.withSession({ failure: "the server could not sign", call: (session) => jiveServer.signWithSshKey(session, data) });
  }

  /**
   * Runs `call` with this machine's session, signing in first when there is none. When `call` fails, the server is
   * asked whether it still honours the session before the session is blamed (a server that cannot be reached fails
   * both); one it has ended is dropped, and `call` runs once more after signing in again.
   */
  private *withSession<A>({ failure, call }: {
    readonly failure: string;
    readonly call: (session: Session) => EffectGen<A, JiveServerError>;
  }): EffectGen<A, AccountKeyError> {
    const { session: sessions } = this.dependencies;
    const session = yield* this.session();
    const first = yield* e.Effect.result(e.Effect.gen(() => call(session)));
    if (e.Result.isSuccess(first)) return first.success;
    const maybeLive = yield* e.pipe(
      e.Effect.gen(() => sessions.checkWithServer(session)),
      e.Effect.mapError(({ reason }) => new AccountKeyError({ reason: `${failure}: ${first.failure.reason}; ${reason}` })),
    );
    if (e.Option.isSome(maybeLive)) return yield* new AccountKeyError({ reason: `${failure}: ${first.failure.reason}` });
    const renewed = yield* this.session();
    return yield* e.pipe(
      e.Effect.gen(() => call(renewed)),
      e.Effect.mapError(({ reason }) => new AccountKeyError({ reason: `${failure}: ${reason}` })),
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
