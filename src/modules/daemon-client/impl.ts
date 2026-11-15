import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { createConnection } from "node:net";
import { jiveHomePaths } from "@/jive-home";
import { modules } from "@/modules";
import { PROTOCOL_VERSION, ResponseEnvelope, encodeRequestLine, type DaemonRequest, type DaemonResponse, type SessionStatus } from "@/modules/extension-daemon/protocol";
import { DaemonDidNotAnswer, DaemonNotRunning, DaemonRefused, type IDaemonClient } from "./interface";

/** Longer than the daemon's own 5-second limit on asking the server, so an offline answer arrives first. */
const ANSWER_TIMEOUT = e.Duration.seconds(15);

const decodeResponseLine = e.Schema.decodeUnknownOption(e.Schema.fromJsonString(ResponseEnvelope));

export class DaemonClientImpl extends implementing(modules.daemonClient).uses(OSPlatform) implements IDaemonClient {
  *getSession(): EffectGen<SessionStatus, DaemonNotRunning | DaemonDidNotAnswer | DaemonRefused> {
    const response = yield* this.ask({ _tag: "GetSession" });
    switch (response._tag) {
      case "SignedOut":
      case "SigningIn":
      case "SignedIn":
        return response;
      case "Failed":
        return yield* new DaemonRefused({ message: response.message });
      default:
        return yield* new DaemonDidNotAnswer({ detail: `it answered GetSession with ${response._tag}` });
    }
  }

  /** One request on a connection of its own: one line out, the first line back. */
  private *ask(request: DaemonRequest): EffectGen<DaemonResponse, DaemonNotRunning | DaemonDidNotAnswer> {
    const { daemonSocket } = jiveHomePaths(yield* this.dependencies.OSPlatform.getHomeDirectory());
    const line = yield* e.Effect.timeoutOrElse(
      e.Effect.callback<string, DaemonNotRunning | DaemonDidNotAnswer>((resume) => {
        const socket = createConnection(daemonSocket);
        let connected = false;
        let received = "";
        socket.setEncoding("utf8");
        socket.on("connect", () => {
          connected = true;
          socket.write(`${encodeRequestLine({ protocolVersion: PROTOCOL_VERSION, requestId: "1", request })}\n`);
        });
        socket.on("data", (chunk: string) => {
          received += chunk;
          const newline = received.indexOf("\n");
          if (newline < 0) return;
          socket.destroy();
          resume(e.Effect.succeed(received.slice(0, newline)));
        });
        socket.on("error", (cause: NodeJS.ErrnoException) => {
          resume(e.Effect.fail(!connected && (cause.code === "ENOENT" || cause.code === "ECONNREFUSED")
            ? new DaemonNotRunning({ socketPath: daemonSocket })
            : new DaemonDidNotAnswer({ detail: cause.code !== undefined ? cause.code : cause.message })));
        });
        // After an answer or an error this changes nothing: only the first resume counts.
        socket.on("close", () => resume(e.Effect.fail(new DaemonDidNotAnswer({ detail: "it closed the connection without answering" }))));
        return e.Effect.sync(() => socket.destroy());
      }),
      {
        duration: ANSWER_TIMEOUT,
        orElse: () => e.Effect.fail(new DaemonDidNotAnswer({ detail: `no answer within ${e.Duration.format(ANSWER_TIMEOUT)}` })),
      },
    );
    // A response carries no token or secret, but the line is not quoted either way.
    const maybeEnvelope = decodeResponseLine(line);
    if (e.Option.isNone(maybeEnvelope)) return yield* new DaemonDidNotAnswer({ detail: "its answer was not a response of this jive's protocol" });
    return maybeEnvelope.value.response;
  }
}
