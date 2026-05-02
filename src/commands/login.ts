import http from "node:http";
import { randomBytes } from "node:crypto";
import { AddressInfo } from "node:net";
import chalk from "chalk";
import open from "open";
import { loadConfig, saveConfig } from "../config.js";
import { ApiClient } from "../api.js";

interface LoginOptions {
  provider?: "github" | "google" | "yandex";
  port?: number;
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Browser-based OAuth login. Runs a one-shot loopback HTTP server on
 * 127.0.0.1, opens the browser at /auth/cli/start, waits for the
 * frontend's CliBridge page to POST the JWT back. Server stops as soon
 * as a valid token arrives or LOGIN_TIMEOUT_MS elapses.
 *
 * NOTE: this command depends on backend endpoints that may not be live yet
 * (`/auth/cli/start`, frontend `/oauth/cli-bridge`). If you can already
 * obtain a JWT through the web UI, use `layero token set <jwt>` as a
 * temporary alternative.
 */
export async function loginCmd(opts: LoginOptions): Promise<void> {
  const cfg = await loadConfig();
  const state = randomBytes(16).toString("hex");
  const provider = opts.provider ?? "github";
  const desiredPort = opts.port ?? Number(process.env.LAYERO_LOGIN_PORT ?? 0);

  const tokenPromise = new Promise<string>((resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      // Accept token via POST body (preferred) or GET query (fallback).
      let body = "";
      if (req.method === "POST") {
        for await (const chunk of req) body += chunk;
      }
      let token: string | undefined;
      let receivedState: string | undefined;
      if (body) {
        try {
          const parsed = JSON.parse(body) as {
            token?: string;
            state?: string;
          };
          token = parsed.token;
          receivedState = parsed.state;
        } catch {
          // ignore; fall through to query
        }
      }
      token ??= url.searchParams.get("token") ?? undefined;
      receivedState ??= url.searchParams.get("state") ?? undefined;

      if (!token || receivedState !== state) {
        res.writeHead(400, { "Access-Control-Allow-Origin": "*" }).end("bad state");
        return;
      }
      res
        .writeHead(200, {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
        })
        .end("ok — you can close this tab");
      if (timeoutHandle) clearTimeout(timeoutHandle);
      server.close();
      resolve(token);
    });
    server.on("error", reject);
    server.listen(desiredPort, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      // Defence-in-depth: confirm we actually bound to loopback before
      // emitting `callback=…` to the browser. If listen() somehow returned
      // a non-loopback address (Node bug, weird /etc/hosts) we'd otherwise
      // hand the JWT redirect target out to whoever owns that interface.
      if (!addr || addr.address !== "127.0.0.1") {
        server.close();
        reject(
          new Error(
            `expected to bind 127.0.0.1, got ${addr?.address ?? "null"}`,
          ),
        );
        return;
      }
      const port = addr.port;
      const callback = `http://127.0.0.1:${port}/callback`;
      const startUrl =
        `${cfg.apiUrl.replace(/\/+$/, "")}/auth/cli/start` +
        `?provider=${provider}` +
        `&callback=${encodeURIComponent(callback)}` +
        `&state=${state}`;
      console.log(chalk.cyan(`opening browser for ${provider} login...`));
      console.log(chalk.dim(`if it doesn't open, paste this URL: ${startUrl}`));
      open(startUrl).catch(() => {
        // open failure is non-fatal — user can paste the URL manually.
      });
    });
    timeoutHandle = setTimeout(() => {
      server.close();
      reject(new Error(`login timed out after ${LOGIN_TIMEOUT_MS / 1000}s`));
    }, LOGIN_TIMEOUT_MS);
  });

  const token = await tokenPromise;
  cfg.token = token;
  const probe = new ApiClient(cfg);
  const me = await probe.me();
  cfg.user = { id: me.id, handle: me.handle, email: me.email };
  await saveConfig(cfg);
  console.log(
    chalk.green(
      `logged in as ${me.handle ?? me.email ?? me.id}`,
    ),
  );
  if (!me.handle) {
    console.log(
      chalk.yellow(
        "no handle set — open https://app.layero.ru/onboarding to pick one.",
      ),
    );
  }
}
