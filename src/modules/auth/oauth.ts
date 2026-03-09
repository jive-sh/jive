import * as e from "effect";
import type { AuthHostShell } from "@/modules/auth/host-shell";
import type { HostShellCommand } from "@/modules/host-shell/interface";

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export interface OAuthCodeResult {
  readonly code: string;
  readonly redirectUri: string;
}

export type OAuthBrowserAction =
  | { readonly _tag: "Display"; readonly title: string; readonly body: string; readonly attemptAutoClose: boolean }
  | { readonly _tag: "Redirect"; readonly url: string };

export interface PendingOAuthCodeRequest {
  readonly authorizeUrl: URL;
  readonly waitForCode: e.Effect.Effect<e.Option.Option<OAuthCodeResult>>;
  readonly continueInBrowser: (action: OAuthBrowserAction) => void;
}

interface BeginOAuthCodeRequestOptions {
  readonly openBrowser: boolean;
}

export function currentBrowserOpenCommand(): string {
  switch (process.platform) {
    case "darwin":
      return "open";
    case "win32":
      return "cmd";
    default:
      return "xdg-open";
  }
}

export function displayOAuthBrowserAction(title: string, body: string): OAuthBrowserAction {
  return { _tag: "Display", title, body, attemptAutoClose: false };
}

export function displayAutoClosingOAuthBrowserAction(title: string, body: string): OAuthBrowserAction {
  return { _tag: "Display", title, body, attemptAutoClose: true };
}

export function redirectOAuthBrowserAction(url: string): OAuthBrowserAction {
  return { _tag: "Redirect", url };
}

export function beginOAuthCodeRequest(
  hostShell: AuthHostShell,
  providerName: string,
  buildAuthorizeUrl: (redirectUri: string, state: string) => URL,
  options: BeginOAuthCodeRequestOptions,
): PendingOAuthCodeRequest {
  const state = crypto.randomUUID();

  let stopped = false;
  let resolveCode!: (result: OAuthCodeResult) => void;
  let rejectCode!: (err: Error) => void;
  let resolveBrowserAction!: (action: OAuthBrowserAction) => void;

  const codePromise = new Promise<OAuthCodeResult>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const browserActionPromise = new Promise<OAuthBrowserAction>((resolve) => {
    resolveBrowserAction = resolve;
  });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });

      const stopServer = (): void => {
        if (!stopped) {
          stopped = true;
          server.stop();
        }
      };

      if (url.searchParams.get("state") !== state) {
        rejectCode(new Error("State mismatch - possible CSRF."));
        queueMicrotask(stopServer);
        return new Response("State mismatch.", { status: 400 });
      }

      const code = url.searchParams.get("code");
      if (code) {
        resolveCode({ code, redirectUri });
        const action = await browserActionPromise;
        queueMicrotask(stopServer);
        return responseForBrowserAction(action);
      }

      const errMsg = url.searchParams.get("error_description")
        ?? url.searchParams.get("error")
        ?? "Unknown error";
      rejectCode(new Error(errMsg));
      queueMicrotask(stopServer);
      return new Response(`${providerName} auth failed: ${errMsg}`, { status: 400 });
    },
  });

  const redirectUri = `http://localhost:${server.port}/callback`;
  const authorizeUrl = buildAuthorizeUrl(redirectUri, state);

  const waitForCode = e.Effect.gen(function*() {
    if (options.openBrowser) {
      yield* e.Effect.log(`Opening ${providerName} in your browser...`);
      yield* openBrowser(hostShell, authorizeUrl.toString());
    }

    yield* e.Effect.sync(() => {
      process.stdout.write(`Waiting for ${providerName} authorization...`);
    });

    const timeoutHandle = setTimeout(
      () => rejectCode(new Error(`${providerName} login timed out. Please try again.`)),
      OAUTH_TIMEOUT_MS,
    );

    try {
      const result = yield* e.Effect.promise(() => codePromise);
      yield* e.Effect.sync(() => {
        process.stdout.write(" done.\n");
      });
      return e.Option.some(result);
    } catch (error) {
      yield* e.Effect.logError((error as Error).message);
      if (!stopped) {
        stopped = true;
        server.stop();
      }
      return e.Option.none<OAuthCodeResult>();
    } finally {
      clearTimeout(timeoutHandle);
    }
  });

  return {
    authorizeUrl,
    waitForCode,
    continueInBrowser: resolveBrowserAction,
  };
}

export const requestOAuthCode = (
  hostShell: AuthHostShell,
  providerName: string,
  buildAuthorizeUrl: (redirectUri: string, state: string) => URL,
): e.Effect.Effect<e.Option.Option<OAuthCodeResult>> =>
  e.Effect.gen(function*() {
    const request = beginOAuthCodeRequest(hostShell, providerName, buildAuthorizeUrl, { openBrowser: true });
    const result = yield* request.waitForCode;
    if (e.Option.isSome(result)) {
      request.continueInBrowser(
        displayOAuthBrowserAction(
          `${providerName} authorization complete`,
          "You may close this tab.",
        ),
      );
    }
    return result;
  });

const openBrowser = (hostShell: AuthHostShell, url: string): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const command = currentBrowserOpenCommand();
    const args = command === "open"
      ? [url]
      : command === "cmd"
        ? ["/c", "start", "", url]
        : [url];

    const spec: HostShellCommand = {
      command,
      args,
      cwd: e.Option.none(),
      env: {},
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      shell: e.Option.none(),
    };

    const result = yield* hostShell.run(spec);
    if (e.Option.isNone(result) || result.value.exitCode !== 0) {
      yield* e.Effect.log(`Could not open browser automatically. Visit this URL to authorize:\n  ${url}`);
    }
  });

function responseForBrowserAction(action: OAuthBrowserAction): Response {
  switch (action._tag) {
    case "Display":
      return new Response(renderHtml(action.title, action.body, action.attemptAutoClose), {
        headers: { "Content-Type": "text/html" },
      });
    case "Redirect":
      return Response.redirect(action.url, 302);
  }
}

function renderHtml(title: string, body: string, attemptAutoClose: boolean): string {
  const escapedTitle = escapeHtml(title);
  const escapedBody = escapeHtml(body);
  const autoCloseMarkup = attemptAutoClose
    ? [
      "<p>This tab will try to close automatically. If it stays open, you may close it manually.</p>",
      "<script>",
      "function tryCloseWindow() {",
      "  window.open('', '_self');",
      "  window.close();",
      "}",
      "window.addEventListener('load', function() {",
      "  window.setTimeout(tryCloseWindow, 1500);",
      "});",
      "</script>",
    ].join("")
    : "";

  return [
    "<html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /></head><body>",
    `<h2>${escapedTitle}</h2>`,
    `<p style="white-space: pre-wrap;">${escapedBody}</p>`,
    autoCloseMarkup,
    "</body></html>",
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
