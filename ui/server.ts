import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verify } from "../verifier/run.js";
import type { Report } from "../verifier/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RESULTS_DIR = path.join(ROOT, "results");
const FIXTURES_DIR = path.join(ROOT, "fixtures");
const SUBMISSION_DIR = path.resolve(ROOT, "..", "trigger-verify-test");
const SUBMISSION_ID = path.relative(ROOT, SUBMISSION_DIR);

const PORT = Number(process.env.PORT ?? 8080);

let running = false;

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json") {
  const payload = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(payload);
}

function readLatestReport(): Report | null {
  const file = path.join(RESULTS_DIR, "report.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Report;
  } catch {
    return null;
  }
}

/**
 * The submission under test, plus every fixture.
 *
 * Exposing the fixtures in the UI makes the verifier self-demonstrating: you
 * can see a known-good submission score 10/10 and a known-bad one fail on
 * exactly one check, which is what makes a real result believable.
 */
function listTargets(): { id: string; label: string }[] {
  const targets = [{ id: SUBMISSION_ID, label: "submission under test" }];

  if (fs.existsSync(FIXTURES_DIR)) {
    for (const name of fs.readdirSync(FIXTURES_DIR).sort()) {
      if (fs.statSync(path.join(FIXTURES_DIR, name)).isDirectory()) {
        targets.push({ id: `fixtures/${name}`, label: `fixture: ${name}` });
      }
    }
  }

  return targets;
}

function resolveTarget(id: string): string | null {
  const resolved = path.resolve(ROOT, id);
  // Confine targets to the verifier's fixtures and the submission directory, so
  // a crafted id cannot point the verifier at arbitrary paths.
  const allowed = resolved === SUBMISSION_DIR || resolved.startsWith(FIXTURES_DIR + path.sep);
  if (!allowed) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/") {
    const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
    return send(res, 200, html, "text/html; charset=utf-8");
  }

  if (url.pathname === "/api/targets") {
    return send(res, 200, { targets: listTargets() });
  }

  if (url.pathname === "/api/report") {
    return send(res, 200, { report: readLatestReport() });
  }

  // Streams progress as newline-delimited JSON so the page can show each stage.
  if (url.pathname === "/api/run" && req.method === "POST") {
    if (running) return send(res, 409, { error: "A verification is already running." });

    const targetId = url.searchParams.get("target") ?? SUBMISSION_ID;
    const submissionDir = resolveTarget(targetId);
    if (!submissionDir) return send(res, 400, { error: `Unknown target: ${targetId}` });

    running = true;
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });

    const emit = (event: Record<string, unknown>) => res.write(`${JSON.stringify(event)}\n`);

    try {
      const report = await verify({
        submissionDir,
        // Only the real submission updates results/; fixtures are diagnostics.
        persist: targetId === SUBMISSION_ID,
        onProgress: (message) => emit({ type: "progress", message }),
      });
      emit({ type: "done", report });
    } catch (error) {
      emit({ type: "error", message: (error as Error).message ?? String(error) });
    } finally {
      running = false;
      res.end();
    }
    return;
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`\n  Trigger.dev usage verifier`);
  console.log(`  http://localhost:${PORT}\n`);
});
