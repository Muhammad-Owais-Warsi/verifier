import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyseLimits } from "./analysers/limits.js";
import { analyseUsage } from "./analysers/usage.js";
import { extractFacts } from "./static/facts.js";
import { runStaticGate } from "./static/gate.js";
import type { Check, Expectations, Report, Requirements } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = path.join(ROOT, "results");
const TASKS_DIR = path.join(ROOT, "tasks");

/**
 * Task names are the folders under tasks/ that hold an expectations.json,
 * e.g. "document-review" for tasks/document-review/expectations.json.
 */
export function listTasks(): string[] {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs
    .readdirSync(TASKS_DIR)
    .filter((name) => fs.existsSync(path.join(TASKS_DIR, name, "expectations.json")))
    .sort();
}

/**
 * Accepts either a task name ("document-review") or a path to an
 * expectations file, and returns the file to load.
 */
export function resolveExpectationsFile(ref: string): string {
  const asTask = path.join(TASKS_DIR, ref, "expectations.json");
  if (fs.existsSync(asTask)) return asTask;
  return path.resolve(ref);
}

export interface RunOptions {
  /** Directory holding the submission. Always passed explicitly, no default. */
  submissionDir: string;
  /** Task name under tasks/. Alternative to passing requirements directly. */
  taskName?: string;
  onProgress?: (message: string) => void;
  /** Write results to disk. Disabled when scoring fixtures. */
  persist?: boolean;
  /** Overrides the task's requirements. Used by the fixture suite. */
  requirements?: Requirements;
}

/**
 * Each task's expectations.json lives under tasks/<name>/. The shared
 * tasks/setup.md is what the model sees; this file tells the verifier what
 * to grade, and the two must not leak into each other.
 */
export function loadExpectations(file: string): Expectations {
  if (!fs.existsSync(file)) {
    throw new Error(
      `Expectations file not found: ${file}\nAvailable tasks: ${listTasks().join(", ")}`,
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as Expectations;
}

/** Short readable label for the report; absolute when outside this repo. */
function displayPath(dir: string): string {
  const relative = path.relative(ROOT, dir);
  return relative.startsWith("..") ? dir : relative;
}

function summarise(checks: Check[]): Report["score"] {
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const na = checks.filter((c) => c.status === "na").length;
  const inconclusive = checks.filter((c) => c.status === "inconclusive").length;
  const graded = passed + failed;

  return {
    total: graded === 0 ? 0 : Number((passed / graded).toFixed(3)),
    passed,
    failed,
    na,
    inconclusive,
  };
}

function writeReport(report: Report): string {
  fs.mkdirSync(path.join(RESULTS_DIR, "history"), { recursive: true });
  const latest = path.join(RESULTS_DIR, "report.json");
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  fs.writeFileSync(latest, JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(RESULTS_DIR, "history", `report-${stamp}.json`),
    JSON.stringify(report, null, 2),
  );
  return latest;
}

/**
 * Verifies a submission entirely from its source.
 *
 * Two layers: a gate that proves the code is valid, current Trigger.dev, and a
 * usage pass that decides whether each requirement was met using the platform
 * or hand-rolled around it. Nothing is deployed and no credentials are needed.
 */
export async function verify(options: RunOptions): Promise<Report> {
  const log = options.onProgress ?? ((message: string) => console.log(message));
  const submissionDir = path.resolve(options.submissionDir);
  if (!fs.existsSync(submissionDir)) {
    throw new Error(`Submission directory not found: ${submissionDir}`);
  }
  const requirements =
    options.requirements ??
    (options.taskName ? loadExpectations(resolveExpectationsFile(options.taskName)) : undefined)
      ?.requirements;
  if (!requirements) {
    throw new Error(
      `No requirements to grade against. Pass taskName or requirements.\nAvailable tasks: ${listTasks().join(", ")}`,
    );
  }
  const checks: Check[] = [];

  log("Checking the submission compiles against the real SDK...");
  const gate = runStaticGate(submissionDir);
  checks.push(...gate.checks);

  // Usage analysis on code that does not compile produces misleading results,
  // because unresolved symbols look like missing primitives.
  const fatal =
    gate.fatal ??
    (gate.typeErrors.length > 0
      ? {
          stage: "compile" as const,
          reason:
            "The submission does not compile against the real Trigger.dev SDK, so how it uses the framework cannot be assessed.",
        }
      : undefined);

  if (fatal) {
    log(`Stopping at ${fatal.stage}: ${fatal.reason}`);
    const report: Report = {
      generatedAt: new Date().toISOString(),
      submission: displayPath(submissionDir),
      score: { ...summarise(checks), total: 0 },
      checks,
      aborted: fatal,
    };
    if (options.persist !== false) writeReport(report);
    return report;
  }

  log("Analysing how the submission uses Trigger.dev...");
  const facts = extractFacts(submissionDir);
  log(
    `Found ${facts.tasks.length} task(s), ${facts.queues.length} queue(s), ` +
      `${facts.handRolledLimiters.length} in-process limiter(s)`,
  );

  checks.push(...analyseUsage(facts, requirements));
  // Whether the right primitive was handed something it can actually accept.
  checks.push(...analyseLimits(facts, requirements));

  const report: Report = {
    generatedAt: new Date().toISOString(),
    submission: displayPath(submissionDir),
    score: summarise(checks),
    checks,
    // An empty submission trivially passes the "no bad API" gate checks, which
    // would otherwise read as partial credit.
    ...(facts.tasks.length === 0
      ? {
          score: { ...summarise(checks), total: 0 },
          aborted: {
            stage: "empty" as const,
            reason:
              "The submission defines no Trigger.dev tasks, so there is nothing to assess.",
          },
        }
      : {}),
  };

  if (options.persist !== false) {
    const file = writeReport(report);
    log(`Report written to ${path.relative(ROOT, file)}`);
  }

  return report;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  // verify <submissionDir> <taskName | expectationsFile>
  // verify <submissionDir> --task <taskName>
  const args = process.argv.slice(2);
  const taskFlag = args.indexOf("--task");
  const taskName = taskFlag >= 0 ? args[taskFlag + 1] : undefined;
  const [dirArg, refArg] = taskFlag >= 0 ? args.filter((_, i) => i !== taskFlag && i !== taskFlag + 1) : args;

  if (!dirArg || (!refArg && !taskName)) {
    console.error("Usage: verify <submissionDir> <taskName | expectationsFile>");
    console.error("");
    console.error("  <submissionDir>    folder holding the solution to grade");
    console.error("  <taskName>         folder under tasks/ (available: " + listTasks().join(", ") + ")");
    console.error("  <expectationsFile> path to an expectations.json file");
    console.error("");
    console.error("Examples:");
    console.error("  npx tsx verifier/run.ts ./my-solution document-review");
    console.error("  npx tsx verifier/run.ts ./my-solution --task document-review");
    console.error("  npx tsx verifier/run.ts ./my-solution tasks/document-review/expectations.json");
    process.exit(2);
  }

  const ref = taskName ?? refArg!;
  let requirements: Requirements;
  try {
    requirements = loadExpectations(resolveExpectationsFile(ref)).requirements;
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  verify({
    submissionDir: path.resolve(dirArg),
    requirements,
  })
    .then((report) => {
      console.log("");
      for (const check of report.checks) {
        console.log(`[${check.status.toUpperCase().padEnd(12)}] ${check.title}`);
        if (check.status === "fail") {
          console.log(`               ${check.why}`);
          const located = check.evidence.filter((item) => item.file);
          for (const item of located.slice(0, 2)) {
            console.log(`               -> ${item.file}:${item.line} ${item.snippet ?? ""}`);
          }
          // Say so when there is more. Printing two of ten silently made a
          // widespread problem look like an isolated one.
          if (located.length > 2) {
            console.log(
              `               -> ... and ${located.length - 2} more (see results/report.json)`,
            );
          }
        }
      }
      console.log("");
      if (report.aborted) {
        console.log(`Stopped at ${report.aborted.stage}: ${report.aborted.reason}`);
      }
      console.log(
        `Score ${report.score.total} (${report.score.passed} passed, ${report.score.failed} failed, ${report.score.na} n/a)`,
      );
      process.exit(report.score.failed > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error("Verifier crashed:", error instanceof Error ? error.message : String(error));
      process.exit(2);
    });
}
