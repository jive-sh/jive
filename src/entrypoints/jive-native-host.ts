import { createConnection } from "node:net";
import { homedir } from "node:os";
import { jiveHomePaths } from "@/jive-home";
import { encodeFrame, FrameReader } from "@/modules/extension-daemon/native-messaging/framing";
import type { DaemonUnreachable } from "@/modules/extension-daemon/protocol";

/**
 * The native messaging host Chrome starts when the Jive extension calls `connectNative`, one process per port.
 * Chrome can only start a host, never attach to a running process, so this relays to `jive-extension-daemon`: each
 * framed message from Chrome becomes one line on the daemon's socket, and each line back becomes a frame to Chrome.
 * It reads no message's contents, so a token passing through is never parsed, logged or kept. It exits when either
 * side closes. Chrome passes the calling extension's origin as an argument; the host manifest already allows only the
 * Jive extension.
 */

const socketPath = jiveHomePaths(homedir()).extensionDaemonSocket;

function sendToChrome(json: string): void {
  process.stdout.write(encodeFrame(json));
}

const daemon = createConnection(socketPath);
let connected = false;

daemon.on("connect", () => {
  connected = true;
  const frames = new FrameReader();
  process.stdin.on("data", (chunk: Buffer) => {
    for (const json of frames.push(chunk)) daemon.write(`${json.replaceAll("\n", " ")}\n`);
  });
  process.stdin.on("end", () => daemon.end());
});

let buffered = "";
daemon.setEncoding("utf8");
daemon.on("data", (chunk: string) => {
  buffered += chunk;
  let newline: number;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim() !== "") sendToChrome(line);
  }
});

daemon.on("error", (cause: NodeJS.ErrnoException) => {
  if (!connected) {
    const message: DaemonUnreachable = {
      _tag: "DaemonUnreachable",
      message: cause.code === "ENOENT" || cause.code === "ECONNREFUSED"
        ? "jive-extension-daemon is not running"
        : `jive-extension-daemon could not be reached (${cause.code !== undefined ? cause.code : cause.message})`,
    };
    sendToChrome(JSON.stringify(message));
  }
  process.exit(0);
});
daemon.on("close", () => process.exit(0));
