#!/usr/bin/env node
/**
 * One-command launcher: `npm run bot:start`.
 *
 * Brings up the Python intelligence layer if it is not already running, waits
 * for it to answer, then hands over to the bot. Ctrl-C stops both.
 *
 * If you would rather run the two halves in separate terminals:
 *   npm run api          # uvicorn agents.server:app
 *   npm run bot:only     # the trading loop alone
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import process from "node:process";

// Load .env before reading any of it. Both children get it too: the Python side
// reads .env itself, and ec-core's loadEnv() walks up to find it - but the
// launcher's own port/host decisions happen here, before either starts.
loadDotEnv();

function loadDotEnv(file = ".env") {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    // A real environment variable always wins over the file.
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const PORT = Number(process.env.VATICR_API_PORT ?? 8787);
const HOST = process.env.VATICR_API_HOST ?? "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;

const log = (m) => console.log(`\x1b[36m[vaticr]\x1b[0m ${m}`);
const err = (m) => console.error(`\x1b[31m[vaticr]\x1b[0m ${m}`);

/** Is anything listening on the port? */
const portBusy = () =>
  new Promise((resolve) => {
    const sock = createConnection({ port: PORT, host: HOST })
      .on("connect", () => { sock.destroy(); resolve(true); })
      .on("error", () => resolve(false));
    setTimeout(() => { sock.destroy(); resolve(false); }, 1500);
  });

/** Is the thing on the port actually Vaticr? */
async function vaticrHealthy() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body?.ok && body?.price_feed);
  } catch {
    return false;
  }
}

function pythonBin() {
  for (const p of [".venv/bin/python", ".venv/Scripts/python.exe"]) {
    if (existsSync(p)) return p;
  }
  return process.env.PYTHON ?? "python3";
}

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGINT");
  }
  setTimeout(() => process.exit(code), 1200);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  if (await vaticrHealthy()) {
    log(`intelligence layer already running at ${BASE}`);
  } else if (await portBusy()) {
    err(
      `port ${PORT} is in use by something that is not Vaticr.\n` +
        `  Set a free port and retry, e.g.:  VATICR_API_PORT=8799 npm run bot:start`,
    );
    process.exit(1);
  } else {
    const bin = pythonBin();
    log(`starting intelligence layer (${bin} -m uvicorn) on ${BASE}`);
    const api = spawn(
      bin,
      ["-m", "uvicorn", "agents.server:app", "--host", HOST, "--port", String(PORT),
       "--log-level", "warning"],
      { stdio: ["ignore", "inherit", "inherit"], env: process.env },
    );
    children.push(api);
    api.on("exit", (code) => {
      if (!shuttingDown) {
        err(
          `intelligence layer exited (code ${code}). ` +
            `Install its deps with:  pip install -r requirements.txt`,
        );
        shutdown(1);
      }
    });

    // Wait for the first scan to land; the scout needs a moment on cold start.
    const deadline = Date.now() + 60_000;
    process.stdout.write("\x1b[36m[vaticr]\x1b[0m waiting for the scout");
    while (Date.now() < deadline) {
      if (await vaticrHealthy()) break;
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 1000));
    }
    process.stdout.write("\n");
    if (!(await vaticrHealthy())) {
      err(`intelligence layer did not come up at ${BASE} within 60s`);
      shutdown(1);
      return;
    }
    log("intelligence layer ready");
  }

  const bot = spawn("npx", ["tsx", "bot/src/runner.ts"], {
    stdio: "inherit",
    env: { ...process.env, VATICR_API_URL: process.env.VATICR_API_URL ?? BASE },
  });
  children.push(bot);
  bot.on("exit", (code) => shutdown(code ?? 0));
}

main().catch((e) => { err(e.message); shutdown(1); });
