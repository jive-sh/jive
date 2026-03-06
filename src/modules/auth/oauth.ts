import * as e from "effect";

export interface OAuthCodeResult {
  code: string;
  redirectUri: string;
}

const logInfoSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.log(...message));
};
const logErrorSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.logError(...message));
};

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";

  const result = Bun.spawnSync([cmd, url]);
  if (result.exitCode !== 0) {
    logInfoSync(`Could not open browser automatically. Visit this URL to authorize:\n  ${url}`);
  }
}

export async function requestOAuthCode(
  providerName: string,
  buildAuthorizeUrl: (redirectUri: string, state: string) => URL,
): Promise<e.Option.Option<OAuthCodeResult>> {
  const state = crypto.randomUUID();

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });

      if (url.searchParams.get("state") !== state) {
        rejectCode(new Error("State mismatch - possible CSRF."));
        return new Response("State mismatch.", { status: 400 });
      }

      const code = url.searchParams.get("code");
      if (code) {
        resolveCode(code);
        return new Response(
          `<html><body><h2>${providerName} authorization complete. You can close this tab.</h2></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }

      const errMsg = url.searchParams.get("error_description")
        ?? url.searchParams.get("error")
        ?? "Unknown error";
      rejectCode(new Error(errMsg));
      return new Response(`${providerName} auth failed: ${errMsg}`, { status: 400 });
    },
  });

  const redirectUri = `http://localhost:${server.port}/callback`;
  const authUrl = buildAuthorizeUrl(redirectUri, state);

  logInfoSync(`\nOpening ${providerName} in your browser...`);
  openBrowser(authUrl.toString());
  process.stdout.write(`Waiting for ${providerName} authorization...`);

  const timeoutHandle = setTimeout(
    () => rejectCode(new Error(`${providerName} login timed out. Please try again.`)),
    5 * 60 * 1000,
  );

  try {
    const code = await codePromise;
    logInfoSync(" done.\n");
    return e.Option.some({ code, redirectUri });
  } catch (error) {
    logErrorSync(`\n${(error as Error).message}`);
    return e.Option.none();
  } finally {
    clearTimeout(timeoutHandle);
    server.stop();
  }
}
