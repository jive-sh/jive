import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { modules } from "@/modules";
import type { JiveServerError, Session } from "@/modules/jive-server/interface";
import type { SignInFailed } from "@/modules/session/interface";
import { AccountKeyNotSaved, NoJiveSession, type AccountKey, type IAccountKey } from "./interface";

const OPENSSH_ED25519_PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+=* \S+$/;

export class AccountKeyImpl extends implementing(modules.accountKey).uses(
  modules.session,
  modules.jiveServer,
  OSPlatform,
  e.FileSystem.FileSystem,
) implements IAccountKey {
  *ensure(): EffectGen<AccountKey, SignInFailed | JiveServerError | AccountKeyNotSaved> {
    const { jiveServer, session: sessions } = this.dependencies;
    const publicKey = yield* this.withSession({
      session: () => sessions.ensureSignedIn(),
      call: (session) => jiveServer.sshPublicKey(session),
    });
    const publicKeyFile = yield* this.publicKeyFile();
    const fs = this.getDependency(e.FileSystem.FileSystem);
    yield* e.pipe(
      e.Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(publicKeyFile), { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(publicKeyFile, `${publicKey}\n`);
      }),
      e.Effect.mapError((error) => new AccountKeyNotSaved({ publicKeyFile, detail: error.message })),
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

  *sign(data: Uint8Array): EffectGen<Uint8Array, NoJiveSession | JiveServerError> {
    const { jiveServer, session: sessions } = this.dependencies;
    return yield* this.withSession({
      *session() {
        const maybeSession = yield* sessions.current();
        return e.Option.isSome(maybeSession) ? maybeSession.value : yield* new NoJiveSession();
      },
      call: (session) => jiveServer.signWithSshKey(session, data),
    });
  }

  /**
   * Runs `call` with the session `session` gives. When `call` is refused, the server is asked whether it still
   * honours the session before the session is blamed; one it has ended is dropped, and `call` runs once more with
   * what `session` gives then. An unreachable server can't answer that question either, so it fails at once.
   */
  private *withSession<A, E>({ session, call }: {
    readonly session: () => EffectGen<Session, E>;
    readonly call: (session: Session) => EffectGen<A, JiveServerError>;
  }): EffectGen<A, E | JiveServerError> {
    const first = yield* session();
    const attempt = yield* e.Effect.result(e.Effect.gen(() => call(first)));
    if (e.Result.isSuccess(attempt)) return attempt.success;
    if (attempt.failure._tag === "JiveServerUnreachable") return yield* e.Effect.fail(attempt.failure);
    const maybeLive = yield* this.dependencies.session.checkWithServer(first);
    if (e.Option.isSome(maybeLive)) return yield* e.Effect.fail(attempt.failure);
    return yield* call(yield* session());
  }

  private *publicKeyFile(): EffectGen<string> {
    return jiveHomePaths(yield* this.dependencies.OSPlatform.getHomeDirectory()).accountPublicKeyFile;
  }
}
