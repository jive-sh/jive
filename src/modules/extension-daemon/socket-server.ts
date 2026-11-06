import * as e from "effect";
import { chmodSync, rmSync } from "node:fs";
import { modules, type Module } from "@/modules";
import { ResponseEnvelope } from "./protocol";

const encodeResponseLine = e.Schema.encodeSync(e.Schema.fromJsonString(ResponseEnvelope));

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
    const answer = (line: string) => e.Effect.runPromiseWith(context)(e.Effect.map(e.Effect.gen(() => daemon.answerLine(line)), encodeResponseLine));
    // The kernel's limit on a unix socket path, terminator included (`sun_path`): 104 bytes on macOS, 108 on Linux.
    const limit = process.platform === "darwin" ? 104 : 108;
    if (Buffer.byteLength(socketPath) >= limit) {
      return yield* e.Effect.fail(`cannot listen on ${socketPath}: a unix socket path must be under ${limit} bytes on this system`);
    }

    yield* e.Effect.acquireRelease(
      e.Effect.try({
        try: () => {
          rmSync(socketPath, { force: true });
          const listener = Bun.listen<{ decoder: TextDecoder; received: string; answered: Promise<void> }>({
            unix: socketPath,
            socket: {
              open(socket) {
                socket.data = { decoder: new TextDecoder(), received: "", answered: Promise.resolve() };
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
                    socket.write(`${await answer(line)}\n`);
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
