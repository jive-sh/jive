import * as e from "effect";
import { chmodSync, rmSync } from "node:fs";
import { modules, type Module } from "@/modules";
import { frame, takeMessages } from "./protocol";

/**
 * Serves the signing agent on a unix socket until the scope closes, then removes the socket. Each connection's
 * messages are answered in the order they arrived, as the SSH agent protocol requires. The socket is the owner's
 * only, so only this user's processes can ask it to sign.
 */
export const serveSigningAgent = (socketPath: string): e.Effect.Effect<void, string, Module.signingAgent | e.Scope.Scope> =>
  e.Effect.gen(function* () {
    const agent = yield* modules.signingAgent;
    const context = yield* e.Effect.context<never>();
    const answer = (message: Uint8Array) => e.Effect.runPromiseWith(context)(e.Effect.gen(() => agent.answer(message)));

    yield* e.Effect.acquireRelease(
      e.Effect.try({
        try: () => {
          rmSync(socketPath, { force: true });
          const listener = Bun.listen<{ received: Uint8Array; answered: Promise<void> }>({
            unix: socketPath,
            socket: {
              open(socket) {
                socket.data = { received: new Uint8Array(0), answered: Promise.resolve() };
              },
              data(socket, chunk) {
                const received = new Uint8Array(socket.data.received.length + chunk.length);
                received.set(socket.data.received);
                received.set(chunk, socket.data.received.length);
                const { messages, rest } = takeMessages(received);
                socket.data.received = rest;
                for (const message of messages) {
                  socket.data.answered = socket.data.answered.then(async () => {
                    socket.write(frame(await answer(message)));
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
