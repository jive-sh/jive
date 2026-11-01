import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { modules } from "@/modules";
import type { IBrowser } from "./interface";

/** Each platform's own opener: `open` on macOS, `xdg-open` on Linux, `start` through `cmd` on Windows. */
const openerFor = (os: string, url: string): { command: string; args: ReadonlyArray<string> } => {
  if (os === "darwin") return { command: "open", args: [url] };
  // `start` takes its first quoted argument as a window title, so an empty title goes first.
  if (os === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
};

export class BrowserImpl extends implementing(modules.browser).uses(OSPlatform) implements IBrowser {
  *open(url: string): EffectGen<void, string> {
    const osPlatform = this.dependencies.OSPlatform;
    const { os } = yield* osPlatform.getCurrentPlatform();
    const { command, args } = openerFor(os, url);
    const { exitCode, stderr } = yield* osPlatform.spawnProcess({ command, args: [...args] });
    if (exitCode !== 0) {
      return yield* e.Effect.fail(`${command} could not open ${url}: ${stderr.trim() || `exit code ${exitCode}`}`);
    }
  }
}
