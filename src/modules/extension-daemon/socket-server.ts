import * as e from "effect";
import { chmodSync, rmSync } from "node:fs";
import { modules, type Module } from "@/modules";
import { resolveCallerChainUnix } from "@/modules/caller-chain/peer-process";
import { programNamesOf } from "@/modules/caller-chain/program-names";
import type { SignInCaller } from "@/modules/jive-server/interface";
import { ResponseEnvelope } from "./protocol";

const encodeResponseLine = e.Schema.encodeSync(e.Schema.fromJsonString(ResponseEnvelope));

/**
 * The program on the socket's other end and its ancestors, by name; a chain the kernel won't give is named as such.
 * Bun's socket carries its file descriptor as `fd`, which its type declarations leave out.
 */
function callerOf(socket: object): SignInCaller {
  const fd: unknown = Reflect.get(socket, "fd");
  if (typeof fd !== "number") return { programs: ["an unidentified program"] };
  try {
    return { programs: programNamesOf(resolveCallerChainUnix(fd).map(({ command }) => command)) };
  } catch {
    return { programs: ["an unidentified program"] };
  }
}

/**
 * Serves the extension daemon on a unix socket until the scope closes, then removes the socket: newline-delimited
 * JSON, one response line per request line, answered in the order each connection sent them. Only the native host
 * connects. The socket is the owner's only, so another user on the machine can't reach this user's session; any
 * process of the same user can, which is the trust boundary every jive daemon has.
 */
export const serveExtensionDaemon = (socketPath: string): e.Effect.Effect<void, string, Module.extensionDaemon | e.Scope.Scope> =>
  e.Effect.gen(function* () {
    const daemon = yield* modules.extensionDaemon;
    const context = yield* e.Effect.context<never>();
    const answer = (input: { readonly line: string; readonly caller: SignInCaller }) => e.Effect.runPromiseWith(context)(e.Effect.map(e.Effect.gen(() => daemon.answerLine(input)), encodeResponseLine));
    // The kernel's limit on a unix socket path, terminator included (`sun_path`): 104 bytes on macOS, 108 on Linux.
    const limit = process.platform === "darwin" ? 104 : 108;
    if (Buffer.byteLength(socketPath) >= limit) {
      return yield* e.Effect.fail(`cannot listen on ${socketPath}: a unix socket path must be under ${limit} bytes on this system`);
    }

    yield* e.Effect.acquireRelease(
      e.Effect.try({
        try: () => {
          rmSync(socketPath, { force: true });
          const listener = Bun.listen<{ decoder: TextDecoder; received: string; answered: Promise<void>; caller: SignInCaller }>({
            unix: socketPath,
            socket: {
              open(socket) {
                // Read at connect, while the peer is surely alive, from the kernel's record of who connected.
                socket.data = { decoder: new TextDecoder(), received: "", answered: Promise.resolve(), caller: callerOf(socket) };
              },
              data(socket, chunk) {
                // Streaming, so a character split across chunks decodes whole.
                socket.data.received += socket.data.decoder.decode(chunk, { stream: true });
                let newline: number;
                while ((newline = socket.data.received.indexOf("\n")) >= 0) {
                  const line = socket.data.received.slice(0, newline).trim();
                  socket.data.received = socket.data.received.slice(newline + 1);
                  if (line === "") continue;
                  socket.data.answered = socket.data.answered.then(async () => {
                    socket.write(`${await answer({ line, caller: socket.data.caller })}\n`);
                  });
                }
              },
            },
          });
          chmodSync(socketPath, 0o600);
          return listener;
        },
        catch: (cause) => `could not listen on ${socketPath}: ${String(cause)}`,
      }),
      (listener) => e.Effect.sync(() => {
        listener.stop(true);
        rmSync(socketPath, { force: true });
      }),
    );
    yield* e.Effect.log(`Listening on ${socketPath}`);
  });
