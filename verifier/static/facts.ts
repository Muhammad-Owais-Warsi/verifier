import { Node, Project, SyntaxKind, ts } from "ts-morph";
import fs from "node:fs";
import path from "node:path";
import type { Evidence } from "../types.js";
import { createTriggerResolver, type TriggerResolver } from "./symbols.js";

/**
 * Extracts structured facts about how a submission uses Trigger.dev.
 *
 * Deliberately separated from the checks themselves: this file answers "what
 * does the code do", and the analysers answer "is that the right way to do it".
 */

export const DISPATCH_METHODS = new Set([
  "trigger",
  "triggerAndWait",
  "batchTrigger",
  "batchTriggerAndWait",
  "triggerAndSubscribe",
  // The standalone `batch` namespace, which fans out to several *different*
  // tasks in one call. Only the task-bound `task.batchTrigger*` forms were
  // recognised, so a pipeline dispatching mixed work through `batch` looked
  // like it never fanned out at all, and the task doing the real orchestration
  // was passed over in favour of a shallower caller.
  "triggerByTask",
  "triggerByTaskAndWait",
]);

/** Batch by name alone, whatever they are called on. */
export const BATCH_METHODS = new Set([
  "batchTrigger",
  "batchTriggerAndWait",
  "triggerByTask",
  "triggerByTaskAndWait",
]);

/**
 * Batch only when called on the SDK's `batch` export: `batch.trigger([...])`
 * fans out, while `myTask.trigger(...)` dispatches a single run.
 */
const BATCH_NAMESPACE_METHODS = new Set(["trigger", "triggerAndWait"]);

/** SDK exports that define a task. */
export const TASK_FACTORIES = new Set(["task", "schemaTask"]);

const METADATA_METHODS = /^(set|increment|decrement|append|remove|del|stream|flush|replace|save)$/;
const REALTIME_METHODS = /^(subscribeToRun|subscribeToRunsWithTag|subscribeToBatch|fetchStream|poll)$/;
const WAIT_METHODS = /^(for|until|forToken|createToken|completeToken)$/;
/** Waiting on something outside the run, rather than on a duration. */
const WAIT_TOKEN_METHODS = /^(createToken|forToken|completeToken)$/;
const STREAM_METHODS = /^(pipe|read|append|writer|define|input)$/;
const SCHEDULE_MUTATION_METHODS = /^(create|update|deactivate|activate)$/;
const UNWRAP_METHOD = /^unwrap$/;
/** Reads that check on something running elsewhere, i.e. real polling. */
const REMOTE_STATUS_METHODS = /^(retrieve|poll|list|subscribeToRun|fetchStream)$/;
const SIGNAL_PROPERTY = /^signal$/;
const OK_PROPERTY = /^ok$/;
const OUTPUT_PROPERTY = /^output$/;
const QUEUE_FACTORY = new Set(["queue"]);

/**
 * Names suggesting the items were split before dispatch, which is how a
 * fan-out larger than one batch is meant to be handled.
 */
const CHUNK_PATTERN = /chunk|slice|splice|partition|page|window|group|segment/i;

/** Calls that pull a whole file or response body into memory. */
const BLOB_CALL_PATTERN = /^(readFile|readFileSync|arrayBuffer|blob|bytes)$/;

/**
 * True when the receiver of this access is itself a batch dispatch, e.g.
 * `myTask.batchTriggerAndWait(...).unwrap()`. Replaces guessing from the
 * variable name.
 */
function dispatchesBatch(access: Node, resolver: TriggerResolver): boolean {
  if (!Node.isPropertyAccessExpression(access)) return false;

  const receiver = access.getExpression();
  if (!Node.isCallExpression(receiver)) return false;

  return resolver.isTriggerMember(receiver.getExpression(), BATCH_METHODS);
}

/** Packages whose entire purpose is limiting concurrency in-process. */
const LIMITER_PACKAGES = [
  "p-limit",
  "p-queue",
  "p-map",
  "async-sema",
  "bottleneck",
  "semaphore",
  "await-semaphore",
  "promise-pool",
  "@supercharge/promise-pool",
];

/**
 * Job queues and workflow engines that duplicate what the platform already is.
 *
 * Kept separate from the in-process limiters because the failure is different:
 * these do work across processes, so the cap is real, but it is enforced by a
 * second piece of infrastructure the submission now has to deploy, monitor and
 * keep consistent with the run records.
 */
const EXTERNAL_ORCHESTRATOR_PACKAGES = [
  "bullmq",
  "bull",
  "bee-queue",
  "agenda",
  "agendash",
  "kue",
  "node-resque",
  "pg-boss",
  "graphile-worker",
  "faktory-worker",
  "rsmq",
  "celery-node",
  "temporal",
  "@temporalio/client",
  "@temporalio/worker",
  "inngest",
  "@aws-sdk/client-sqs",
  "@aws-sdk/client-sfn",
  "node-cron",
  "cron",
  "croner",
  "node-schedule",
  "toad-scheduler",
  "bree",
];

const LIMITER_NAME_PATTERN = /^(limit|limiter|semaphore|sema|pool|throttle|concurrency|maxConcurrent|inFlight)$/i;

export interface DispatchFact {
  /** Variable name of the task being dispatched. */
  target: string;
  method: string;
  /** Awaited inside a for/while loop, which serialises the fan-out. */
  inSequentialLoop: boolean;
  /** A batch dispatch, so subject to the per-call item cap. */
  isBatch: boolean;
  /** Items were split before dispatch, so a wide fan-out still fits. */
  chunked: boolean;
  evidence: Evidence;
}

export interface TaskFact {
  name: string;
  taskId?: string;
  exported: boolean;
  retryMaxAttempts?: number;
  hasRetryConfig: boolean;
  /** Queue attached to this task, either inline or by reference. */
  /**
   * Queue attached to this task, either inline or by reference. limitDeclared
   * separates "no limit" from "a limit whose value is set at runtime".
   */
  queue?: {
    kind: "inline" | "reference";
    concurrencyLimit?: number;
    limitDeclared?: boolean;
    ref?: string;
  };
  dispatches: DispatchFact[];
  manualRetryLoops: Evidence[];
  /** Promise.all / allSettled over work that is not a task dispatch. */
  inlineParallelism: Evidence[];
  /** Reads `.ok` off batch/trigger results, i.e. handles per-item failure. */
  readsRunOk: boolean;
  evidence: Evidence;
}

export interface QueueFact {
  varName: string;
  queueName?: string;
  concurrencyLimit?: number;
  /** The property is present, even if its value is only known at runtime. */
  limitDeclared: boolean;
  evidence: Evidence;
}

export interface UsageFacts {
  tasks: TaskFact[];
  queues: QueueFact[];
  /** In-process concurrency limiters, which stand in for a Trigger.dev queue. */
  handRolledLimiters: Evidence[];
  /** Second job queues or schedulers bolted on beside the platform. */
  externalOrchestrators: Evidence[];
  /** Every task that dispatches another, in pipeline order. */
  dispatchers: TaskFact[];
  /**
   * The task that actually fans work out across items.
   *
   * Distinct from the entry point: a pipeline often has a thin router that
   * forwards one run, with the real fan-out a level deeper. Picking the
   * top-level task instead made every fan-out check inspect the router.
   */
  orchestrator?: TaskFact;
  workers: TaskFact[];

  /** metadata.set/increment/append, i.e. platform-visible progress. */
  metadataUsage: Evidence[];
  /** Realtime subscription / stream APIs used to surface progress. */
  realtimeUsage: Evidence[];
  /** onCancel hooks or AbortSignal plumbing. */
  cancellationUsage: Evidence[];
  /** idempotencyKey supplied when triggering. */
  idempotencyKeyUsage: Evidence[];
  /** concurrencyKey supplied when triggering, i.e. per-tenant queueing. */
  concurrencyKeyUsage: Evidence[];
  /** wait.for / wait.until, which checkpoint instead of holding the process. */
  waitUsage: Evidence[];
  /** Module-scope state that a task body writes to during a run. */
  moduleLevelState: Evidence[];
  /**
   * .unwrap() calls where a sibling run is in flight, so the rethrow takes the
   * siblings down with it. A sequential unwrap has nothing to abort.
   */
  unsafeUnwraps: Evidence[];
  /** setTimeout used as a long sleep or poll rather than to simulate work. */
  pollingSleeps: Evidence[];

  /** Waitpoint tokens: a run parked until something outside completes it. */
  waitTokenUsage: Evidence[];
  /** streams.pipe / streams.read, i.e. output streamed as it is produced. */
  streamUsage: Evidence[];
  /** A machine preset declared on a task, i.e. provisioned resources. */
  machineUsage: Evidence[];
  /** retry.outOfMemory, i.e. recovery onto a larger machine. */
  outOfMemoryUsage: Evidence[];
  /** schedules.create, i.e. schedules registered at runtime per tenant. */
  runtimeScheduleUsage: Evidence[];
  /** A cron declared statically in code, which cannot vary per tenant. */
  staticCronUsage: Evidence[];
  /** priority on a trigger, i.e. queue ordering between classes of work. */
  priorityUsage: Evidence[];

  /** The documented caps this submission has to fit inside. */
  limits: PlatformLimits;
  /** Metadata writes that grow with every item rather than being replaced. */
  metadataUnboundedWrites: Evidence[];
  /** Child outputs carried whole into the parent's return value. */
  aggregatedOutputs: Evidence[];
  /** File or response bytes passed inline as a trigger payload. */
  inlinePayloadBlobs: Evidence[];
  /**
   * Idempotency keys classified by the scope they carry, which decides what
   * they actually protect: a raw string is run-scoped.
   */
  idempotencyScopes: {
    scope: "global" | "run" | "attempt";
    /** Scope only matters inside a task; from backend code all behave global. */
    insideTask: boolean;
    evidence: Evidence;
  }[];
}

function evidenceFor(node: Node, rootDir: string): Evidence {
  const sourceFile = node.getSourceFile();
  return {
    file: path.relative(rootDir, sourceFile.getFilePath()),
    line: sourceFile.getLineAndColumnAtPos(node.getStart()).line,
    snippet: node.getText().split("\n")[0].trim().slice(0, 160),
  };
}

function numericValue(node: Node | undefined): number | undefined {
  if (!node) return undefined;
  if (Node.isNumericLiteral(node)) return node.getLiteralValue();

  if (Node.isPrefixUnaryExpression(node)) {
    const operand = numericValue(node.getOperand());
    if (operand === undefined) return undefined;
    return node.getOperatorToken() === SyntaxKind.MinusToken ? -operand : operand;
  }

  // `const LIMIT = 3` used as `concurrencyLimit: LIMIT` is the same number,
  // just named. Follow the binding rather than giving up on it.
  if (Node.isIdentifier(node)) {
    const declaration = node
      .getDefinitionNodes()
      .find((definition) => Node.isVariableDeclaration(definition));
    const initializer = declaration?.getInitializer();
    if (initializer && !Node.isIdentifier(initializer)) return numericValue(initializer);
  }

  return undefined;
}

/**
 * Whether a value is produced by mapping over a collection, so its width is
 * the item count rather than a handful of named operations.
 */
function iteratesCollection(node: Node, depth = 0): boolean {
  if (depth > 3) return false;

  const mapped = [node, ...node.getDescendantsOfKind(SyntaxKind.CallExpression)].some(
    (candidate) => {
      if (!Node.isCallExpression(candidate)) return false;
      const callee = candidate.getExpression();
      return Node.isPropertyAccessExpression(callee) && /^(map|flatMap)$/.test(callee.getName());
    },
  );
  if (mapped) return true;

  if (Node.isIdentifier(node)) {
    const declaration = node
      .getDefinitionNodes()
      .find((definition) => Node.isVariableDeclaration(definition));
    const initializer: Node | undefined = Node.isVariableDeclaration(declaration)
      ? declaration.getInitializer()
      : undefined;
    if (initializer) return iteratesCollection(initializer, depth + 1);
  }

  return false;
}

/**
 * Reads the task variables a `batch` call fans out to.
 *
 * The items are usually assembled elsewhere -- `batch.triggerByTaskAndWait([
 * ...renditionItems, thumbnailItem])` -- so follow identifier arguments and
 * spreads back to their declarations before looking for the `task` field.
 */
function collectBatchTargets(call: Node, taskNames: ReadonlySet<string>): string[] {
  if (!Node.isCallExpression(call)) return [];

  const roots: Node[] = [];

  const expand = (node: Node | undefined, depth: number) => {
    if (!node || depth > 3) return;
    roots.push(node);

    if (Node.isSpreadElement(node)) return expand(node.getExpression(), depth + 1);

    if (Node.isArrayLiteralExpression(node)) {
      for (const element of node.getElements()) expand(element, depth + 1);
      return;
    }

    if (Node.isIdentifier(node)) {
      const declaration = node
        .getDefinitionNodes()
        .find((definition) => Node.isVariableDeclaration(definition));
      const initializer = declaration?.getInitializer();
      if (initializer) expand(initializer, depth + 1);
    }
  };

  for (const argument of call.getArguments()) expand(argument, 0);

  const targets = new Set<string>();
  for (const root of roots) {
    for (const property of root.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (property.getName() !== "task") continue;
      const value = property.getInitializer();
      if (value && Node.isIdentifier(value) && taskNames.has(value.getText())) {
        targets.add(value.getText());
      }
    }
  }

  return [...targets];
}

/**
 * Whether a config property is present at all, regardless of whether its value
 * can be read at build time.
 *
 * `concurrencyLimit: Number(process.env.ENCODE_CONCURRENCY ?? 3)` declares a
 * real, platform-enforced limit; the number simply is not knowable from the
 * source. Treating unreadable as absent reported a submission that configures
 * its queues from the environment -- the better practice -- as having declared
 * no limit at all.
 */
function hasProperty(object: Node | undefined, name: string): boolean {
  return objectProperty(object, name) !== undefined;
}

/**
 * Reads a config value, following shorthand to its declaration.
 *
 * `{ retry }` and `{ retry: { maxAttempts: 8 } }` are the same configuration
 * written two ways, and hoisting a shared policy into a const to reuse across
 * tasks is better practice than inlining it. Handling only the long form made
 * the shorthand read as absent, so a submission with one correct retry policy
 * applied to every task was reported as having none. The same helper reads
 * `id`, `queue`, `concurrencyLimit` and `maxAttempts`, so all of them were
 * affected.
 */
function objectProperty(object: Node | undefined, name: string): Node | undefined {
  if (!object || !Node.isObjectLiteralExpression(object)) return undefined;

  const property = object.getProperty(name);
  if (!property) return undefined;

  if (Node.isPropertyAssignment(property)) return property.getInitializer();

  if (Node.isShorthandPropertyAssignment(property)) {
    // Resolve the binding, then keep following aliases so a const pointing at
    // another const still lands on the literal.
    let current: Node | undefined = property.getNameNode();

    for (let hop = 0; hop < 5 && current; hop++) {
      if (!Node.isIdentifier(current)) return current;

      const definitions: Node[] = current.getDefinitionNodes();
      const declaration = definitions.find((node) => Node.isVariableDeclaration(node));
      if (!declaration || !Node.isVariableDeclaration(declaration)) return undefined;

      const initializer: Node | undefined = declaration.getInitializer();
      if (!initializer) return undefined;

      current = initializer;
    }
  }

  return undefined;
}

/**
 * Walks up from the submission looking for an installed package, the same way
 * module resolution does. The submission installs its own dependencies, so
 * nothing about their location can be assumed.
 */
export function resolveInstalledPackage(
  fromDir: string,
  packageName: string,
): string | undefined {
  let current = path.resolve(fromDir);

  while (true) {
    const candidate = path.join(current, "node_modules", packageName);
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The documented caps a submission has to design around.
 *
 * These are not style preferences: exceeding one is a runtime error or silent
 * truncation, so a submission that reaches for the right primitive and then
 * feeds it more than it accepts is still broken. The batch and payload caps
 * were raised in SDK 4.3.1, so they are read from the installed version rather
 * than hard-coded.
 */
export interface PlatformLimits {
  sdkVersion?: string;
  /** Items accepted by a single batch trigger call. */
  maxBatchItems: number;
  /** Bytes accepted as a single trigger payload. */
  maxPayloadBytes: number;
  /** Bytes accepted as a task's return value. */
  maxOutputBytes: number;
  /** Bytes accepted in a run's metadata object. */
  maxMetadataBytes: number;
}

/** Numeric comparison of dotted version strings, ignoring prerelease tags. */
function atLeastVersion(version: string, target: string): boolean {
  const parse = (value: string) =>
    value
      .replace(/^[^\d]*/, "")
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10) || 0);

  const [a, b] = [parse(version), parse(target)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export function resolvePlatformLimits(outputDir: string): PlatformLimits {
  const sdkDir = resolveInstalledPackage(outputDir, "@trigger.dev/sdk");

  let sdkVersion: string | undefined;
  if (sdkDir) {
    try {
      sdkVersion = JSON.parse(
        fs.readFileSync(path.join(sdkDir, "package.json"), "utf8"),
      ).version as string;
    } catch {
      // Fall through to the conservative caps below.
    }
  }

  const raised = sdkVersion ? atLeastVersion(sdkVersion, "4.3.1") : false;

  return {
    sdkVersion,
    maxBatchItems: raised ? 1000 : 500,
    maxPayloadBytes: raised ? 3 * 1024 * 1024 : 1024 * 1024,
    maxOutputBytes: 10 * 1024 * 1024,
    maxMetadataBytes: 256 * 1024,
  };
}

export function createProject(outputDir: string): Project {
  // The submission owns its tsconfig, so "does it compile" has to mean "does it
  // compile as configured". Inventing our own options here produced false
  // failures on submissions whose own `tsc --noEmit` was clean.
  const tsConfigFilePath = path.join(outputDir, "tsconfig.json");

  const project = fs.existsSync(tsConfigFilePath)
    ? new Project({ tsConfigFilePath })
    : new Project({
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          strict: false,
          noEmit: true,
          skipLibCheck: true,
          allowJs: false,
          // Requesting "node" when @types/node is absent is itself a type
          // error, but without it every `process.env` reference fails.
          types: resolveInstalledPackage(outputDir, "@types/node") ? ["node"] : [],
        },
      });

  // Picks up any task files the tsconfig's include patterns miss.
  project.addSourceFilesAtPaths([
    path.join(outputDir, "**/*.ts"),
    `!${path.join(outputDir, "**/node_modules/**")}`,
  ]);
  return project;
}

/** True when the call is awaited inside a plain for/while loop. */
function isInSequentialLoop(call: Node): boolean {
  const loop = call.getFirstAncestor(
    (ancestor) =>
      Node.isForStatement(ancestor) ||
      Node.isForOfStatement(ancestor) ||
      Node.isForInStatement(ancestor) ||
      Node.isWhileStatement(ancestor) ||
      Node.isDoStatement(ancestor),
  );
  if (!loop) return false;

  // A dispatch inside a loop is only serialising if it is awaited there. A loop
  // that collects promises and awaits them together is still concurrent.
  return Boolean(call.getFirstAncestorByKind(SyntaxKind.AwaitExpression));
}

/**
 * A loop wrapping a try/catch that re-runs the same work is a hand-written
 * retry. The platform's retry engine makes this unnecessary and, unlike the
 * engine, a manual loop produces no attempt history.
 */
function findManualRetryLoops(scope: Node, rootDir: string): Evidence[] {
  const found: Evidence[] = [];

  const loopKinds = [
    SyntaxKind.ForStatement,
    SyntaxKind.WhileStatement,
    SyntaxKind.DoStatement,
  ];

  for (const kind of loopKinds) {
    for (const loop of scope.getDescendantsOfKind(kind)) {
      const tryStatements = loop.getDescendantsOfKind(SyntaxKind.TryStatement);
      const retryish = tryStatements.some((tryStatement) => {
        const catchClause = tryStatement.getCatchClause();
        if (!catchClause) return false;
        // A catch that simply rethrows is error translation, not a retry.
        const rethrowsOnly =
          catchClause.getBlock().getStatements().length === 1 &&
          catchClause.getBlock().getStatements()[0].getKind() === SyntaxKind.ThrowStatement;
        return !rethrowsOnly;
      });

      if (retryish) found.push(evidenceFor(loop, rootDir));
    }
  }

  return found;
}

/** Promise.all / allSettled whose callbacks never dispatch a task. */
function findInlineParallelism(
  scope: Node,
  resolver: TriggerResolver,
  rootDir: string,
): Evidence[] {
  const found: Evidence[] = [];

  for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;
    if (expression.getExpression().getText() !== "Promise") continue;
    if (!/^(all|allSettled|race|any)$/.test(expression.getName())) continue;

    const dispatchesInside = call
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .some((inner) => resolver.isTriggerMember(inner.getExpression(), DISPATCH_METHODS));

    if (dispatchesInside) continue;

    // The anti-pattern is running a *collection* in-process instead of
    // dispatching it, so there has to be a collection. An array literal of
    // distinct operations -- feeding a subprocess, uploading its output,
    // awaiting its exit -- is ordinary concurrent I/O within one step, and
    // reading it as fan-out reported correct stream plumbing as a defect.
    const argument = call.getArguments()[0];
    if (!argument || !iteratesCollection(argument)) continue;

    // Assembling the items for a batch call is not parallel work. Building an
    // idempotency key per item is asynchronous, so the array gets built with
    // Promise.all, and flagging that reported a correct batch fan-out as
    // in-process parallelism -- the opposite of what the code does.
    const awaited = call.getDescendantsOfKind(SyntaxKind.AwaitExpression);
    const onlyAwaitsSdk =
      awaited.length > 0 &&
      awaited.every((expression) => {
        const inner = expression.getExpression();
        return Node.isCallExpression(inner) && resolver.isTriggerMember(inner.getExpression());
      });

    if (onlyAwaitsSdk) continue;

    // Same intent, for items whose keys are plain strings: the callback
    // returns dispatch descriptors rather than doing anything.
    const buildsDispatchItems = call
      .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)
      .some((literal) => {
        const names = literal.getProperties().flatMap((property) => {
          if (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property)) {
            return [property.getName()];
          }
          return [];
        });
        return names.includes("payload") && (names.includes("task") || names.includes("options"));
      });

    if (buildsDispatchItems) continue;

    found.push(evidenceFor(call, rootDir));
  }

  return found;
}

/**
 * True when the items handed to a batch call were split first.
 *
 * A fan-out wider than one batch has to be chunked, either by slicing the
 * array or by looping over pre-made chunks. Without that the call is rejected
 * outright, so this distinguishes "dispatched together" from "dispatched in
 * one call that cannot be accepted".
 */
function isChunkedBatch(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false;

  const items = call.getArguments()[0];
  if (items) {
    // `.slice(...)` or a helper whose name says it chunks.
    const candidates = [items, ...items.getDescendantsOfKind(SyntaxKind.CallExpression)];
    for (const candidate of candidates) {
      const text = Node.isCallExpression(candidate)
        ? candidate.getExpression().getText()
        : candidate.getText();
      if (CHUNK_PATTERN.test(text)) return true;
    }
  }

  // Or the batch call is itself inside a loop walking the chunks.
  const loop = call.getFirstAncestor(
    (ancestor) =>
      Node.isForOfStatement(ancestor) ||
      Node.isForStatement(ancestor) ||
      Node.isWhileStatement(ancestor),
  );
  if (loop && CHUNK_PATTERN.test(loop.getText().slice(0, 200))) return true;

  return false;
}

/**
 * A value small enough that repeating it cannot fill a size budget.
 *
 * Resolves the type rather than only matching literals, because the value
 * being appended is almost always a variable: treating `append(key, token)` as
 * a structured record purely because `token` is an identifier flagged a
 * perfectly bounded per-item counter or string. Objects and arrays are the
 * shapes that actually accumulate, so those are what this excludes.
 */
function isScalarish(node: Node | undefined): boolean {
  if (!node) return true;

  if (
    Node.isNumericLiteral(node) ||
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isTemplateExpression(node) ||
    node.getKind() === SyntaxKind.TrueKeyword ||
    node.getKind() === SyntaxKind.FalseKeyword
  ) {
    return true;
  }

  try {
    const type = node.getType();
    return (
      type.isString() ||
      type.isNumber() ||
      type.isBoolean() ||
      type.isStringLiteral() ||
      type.isNumberLiteral() ||
      type.isBooleanLiteral()
    );
  } catch {
    return false;
  }
}

/**
 * True when this identifier names an array that is pushed to in the same
 * function, i.e. a collection that grows with the item count.
 */
function isAccumulatingBinding(node: Node | undefined): boolean {
  if (!node || !Node.isIdentifier(node)) return false;

  const name = node.getText();
  const scope = node.getFirstAncestor(
    (ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor),
  );
  if (!scope) return false;

  return scope
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((call) => {
      const expression = call.getExpression();
      return (
        Node.isPropertyAccessExpression(expression) &&
        expression.getExpression().getText() === name &&
        MUTATING_METHODS.has(expression.getName())
      );
    });
}

/**
 * Child outputs placed whole into the parent's return value.
 *
 * Reading a field off each output is bounded by that field; carrying the whole
 * output up means the parent's return value is the sum of every child's, which
 * is what runs into the output cap.
 */
function findAggregatedOutputs(
  scope: Node,
  resolver: TriggerResolver,
  rootDir: string,
): Evidence[] {
  const found: Evidence[] = [];

  for (const returnStatement of scope.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    const expression = returnStatement.getExpression();
    if (!expression) continue;

    const carriesWholeOutput = expression
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .some((access) => {
        if (!resolver.isTriggerMember(access, OUTPUT_PROPERTY)) return false;
        // `result.output.summary` is bounded by that field, so only the whole
        // object counts.
        const parent = access.getParent();
        return !(
          (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) &&
          parent.getExpression() === access
        );
      });

    if (carriesWholeOutput) found.push(evidenceFor(returnStatement, rootDir));
  }

  return found;
}

/**
 * File or response bodies passed inline as a trigger payload.
 *
 * The payload cap is on the trigger itself, so the content has to travel as a
 * reference the child resolves rather than as bytes in the payload.
 */
function findInlinePayloadBlobs(
  scope: Node,
  resolver: TriggerResolver,
  rootDir: string,
): Evidence[] {
  const found: Evidence[] = [];

  const producesBlob = (node: Node): boolean =>
    [node, ...node.getDescendantsOfKind(SyntaxKind.CallExpression)].some((candidate) => {
      if (!Node.isCallExpression(candidate)) return false;
      const expression = candidate.getExpression();

      if (Node.isIdentifier(expression)) return BLOB_CALL_PATTERN.test(expression.getText());
      if (!Node.isPropertyAccessExpression(expression)) return false;

      const name = expression.getName();
      if (BLOB_CALL_PATTERN.test(name)) return true;
      // Buffer.from(...) and .toString("base64") both realise bytes inline.
      if (name === "from" && expression.getExpression().getText() === "Buffer") return true;
      return (
        name === "toString" &&
        /base64|hex|binary/.test(candidate.getArguments()[0]?.getText() ?? "")
      );
    });

  /** True when a local of this name is initialised from a blob source. */
  const bindingHoldsBlob = (from: Node, name: string): boolean => {
    const fn = from.getFirstAncestor(
      (ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor),
    );

    const initializer = fn
      ?.getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .find((declaration) => declaration.getName() === name)
      ?.getInitializer();

    return initializer ? producesBlob(initializer) : false;
  };

  // Payloads are routinely assembled away from the dispatch call — built in a
  // loop and pushed into an array a batch trigger is handed later — so the
  // `payload` key is the anchor rather than the call's argument list.
  const payloadObjects: Node[] = [];

  for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!resolver.isTriggerMember(call.getExpression(), DISPATCH_METHODS)) continue;
    const first = call.getArguments()[0];
    if (first && Node.isObjectLiteralExpression(first)) payloadObjects.push(first);
  }

  for (const property of scope.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (property.getName() !== "payload") continue;
    const value = property.getInitializer();
    if (value && Node.isObjectLiteralExpression(value)) payloadObjects.push(value);
  }

  for (const object of payloadObjects) {
    if (!Node.isObjectLiteralExpression(object)) continue;

    for (const property of object.getProperties()) {
      // Shorthand (`{ content }`) is the usual form when the value was awaited
      // into a local first, and it is a different node kind from `key: value`.
      const holdsBlob = Node.isShorthandPropertyAssignment(property)
        ? bindingHoldsBlob(property, property.getName())
        : Node.isPropertyAssignment(property) &&
          (() => {
            const value = property.getInitializer();
            if (!value) return false;
            if (producesBlob(value)) return true;
            return Node.isIdentifier(value) && bindingHoldsBlob(value, value.getText());
          })();

      if (holdsBlob && (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property))) {
        found.push({
          ...evidenceFor(property, rootDir),
          snippet: `"${property.getName()}" carries file or response bytes inline`,
        });
      }
    }
  }

  const seen = new Set<string>();
  return found.filter((item) => {
    const key = `${item.file}:${item.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Imports of a second queue, scheduler or workflow engine. */
function findExternalOrchestrators(project: Project, rootDir: string): Evidence[] {
  const found: Evidence[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    for (const importDeclaration of sourceFile.getImportDeclarations()) {
      const specifier = importDeclaration.getModuleSpecifierValue();
      // Match the package root so subpath imports count too.
      const match = EXTERNAL_ORCHESTRATOR_PACKAGES.find(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );
      if (!match) continue;

      found.push({
        ...evidenceFor(importDeclaration, rootDir),
        snippet: `imports "${specifier}"`,
      });
    }
  }

  return found;
}

function findHandRolledLimiters(project: Project, rootDir: string): Evidence[] {
  const found: Evidence[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    // A dependency whose only job is in-process concurrency limiting.
    for (const importDeclaration of sourceFile.getImportDeclarations()) {
      const specifier = importDeclaration.getModuleSpecifierValue();
      if (LIMITER_PACKAGES.includes(specifier)) {
        found.push({
          ...evidenceFor(importDeclaration, rootDir),
          snippet: `imports concurrency limiter "${specifier}"`,
        });
      }
    }

    // A fixed-size worker pool: Promise.all over Array.from({ length: N }, worker).
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) continue;
      if (expression.getExpression().getText() !== "Array") continue;
      if (expression.getName() !== "from") continue;

      const lengthValue = objectProperty(call.getArguments()[0], "length");
      if (!lengthValue) continue;

      const mapper = call.getArguments()[1];
      const insidePromiseAll = call.getFirstAncestor((ancestor) => {
        if (!Node.isCallExpression(ancestor)) return false;
        const target = ancestor.getExpression();
        return (
          Node.isPropertyAccessExpression(target) &&
          target.getExpression().getText() === "Promise"
        );
      });

      if (mapper && insidePromiseAll) {
        found.push({
          ...evidenceFor(call, rootDir),
          snippet: `spawns a fixed pool of ${lengthValue.getText()} in-process workers`,
        });
      }
    }

    // A parameter or variable literally named like a concurrency limiter.
    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)) {
      if (!LIMITER_NAME_PATTERN.test(declaration.getName())) continue;
      const fn = declaration.getFirstAncestor(
        (ancestor) => Node.isFunctionDeclaration(ancestor) || Node.isArrowFunction(ancestor),
      );
      if (!fn) continue;
      const usesPool = fn
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .some((c) => /Array\.from|Promise\.all/.test(c.getExpression().getText()));
      if (usesPool) {
        found.push({
          ...evidenceFor(declaration, rootDir),
          snippet: `"${declaration.getName()}" parameter drives an in-process worker pool`,
        });
      }
    }
  }

  // The same construct can match more than one heuristic.
  const seen = new Set<string>();
  return found.filter((item) => {
    const key = `${item.file}:${item.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Threshold above which a setTimeout is a sleep rather than simulated work. */
const LONG_SLEEP_MS = 5000;

/** Array, Set and Map methods that write to the receiver. */
const MUTATING_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "set",
  "delete",
  "clear",
  "add",
  "sort",
  "reverse",
  "fill",
]);

const ASSIGNMENT_TOKENS = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** True when the node sits inside a resolved `task(...)` definition. */
function isInsideTaskBody(node: Node, resolver: TriggerResolver): boolean {
  return Boolean(
    node.getFirstAncestor((ancestor) => resolver.isTriggerFactoryCall(ancestor, TASK_FACTORIES)),
  );
}

/** True when the node sits inside Promise.all and friends. */
function isInParallelCombinator(node: Node): boolean {
  return Boolean(
    node.getFirstAncestor(
      (ancestor) =>
        Node.isCallExpression(ancestor) &&
        /^Promise\.(all|allSettled|race|any)$/.test(ancestor.getExpression().getText()),
    ),
  );
}

/**
 * True when this reference writes to the binding rather than reading it.
 *
 * Walks out through property and element access first, so `state.map.set(x)`
 * and `state[key] = x` both count as writes to `state`.
 */
function isMutatingReference(identifier: Node): boolean {
  let expression: Node = identifier;

  for (;;) {
    const parent = expression.getParent();
    const isAccess =
      parent &&
      (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) &&
      parent.getExpression() === expression;

    if (!isAccess) break;
    expression = parent;
  }

  const parent = expression.getParent();
  if (!parent) return false;

  if (Node.isBinaryExpression(parent)) {
    return (
      parent.getLeft() === expression &&
      ASSIGNMENT_TOKENS.has(parent.getOperatorToken().getKind())
    );
  }

  if (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) {
    const operator = parent.getOperatorToken();
    return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken;
  }

  return (
    Node.isCallExpression(parent) &&
    Node.isPropertyAccessExpression(expression) &&
    MUTATING_METHODS.has(expression.getName())
  );
}

/**
 * Scans the whole project for the secondary primitives: observability,
 * cancellation, idempotency, per-tenant keys, and the in-process habits that
 * replace them.
 */
function collectAncillaryFacts(project: Project, rootDir: string, resolver: TriggerResolver) {
  const metadataUsage: Evidence[] = [];
  const realtimeUsage: Evidence[] = [];
  const cancellationUsage: Evidence[] = [];
  const idempotencyKeyUsage: Evidence[] = [];
  const concurrencyKeyUsage: Evidence[] = [];
  const waitUsage: Evidence[] = [];
  const unsafeUnwraps: Evidence[] = [];
  const pollingSleeps: Evidence[] = [];
  const waitTokenUsage: Evidence[] = [];
  const streamUsage: Evidence[] = [];
  const machineUsage: Evidence[] = [];
  const outOfMemoryUsage: Evidence[] = [];
  const runtimeScheduleUsage: Evidence[] = [];
  const staticCronUsage: Evidence[] = [];
  const priorityUsage: Evidence[] = [];
  const metadataUnboundedWrites: Evidence[] = [];
  const idempotencyScopes: UsageFacts["idempotencyScopes"] = [];

  /** Module-scope bindings that could hold state, pending a write. */
  const stateCandidates = new Map<string, Node>();

  for (const sourceFile of project.getSourceFiles()) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      const text = expression.getText();

      if (Node.isPropertyAccessExpression(expression)) {
        // `append` exists on both the metadata and the streams APIs, so the
        // name alone cannot tell them apart. Resolving the declaring module
        // can: without this, `streams.append` was counted as an unbounded
        // metadata write and reported against the 256KB metadata cap, which
        // streams are not subject to at all.
        const declaringPaths = resolver.triggerDeclarationPaths(expression.getNameNode());
        const isStreamsApi = declaringPaths.some((filePath) =>
          /[\\/]streams(\.d\.ts|[\\/])/.test(filePath),
        );

        if (!isStreamsApi && resolver.isTriggerMember(expression, METADATA_METHODS)) {
          metadataUsage.push(evidenceFor(call, rootDir));

          // Metadata has a size cap, and only some writes approach it.
          // `set` replaces, so its cost is whatever it writes; `append` adds to
          // what is already there, so the cost is per item. A growing array
          // handed to `set` is the same thing spelled differently.
          const method = expression.getName();
          const value = call.getArguments()[1];

          if (method === "append" && !isScalarish(value)) {
            metadataUnboundedWrites.push({
              ...evidenceFor(call, rootDir),
              snippet: `appends a record per item to "${
                call.getArguments()[0]?.getText() ?? "?"
              }"`,
            });
          } else if (method === "set" && isAccumulatingBinding(value)) {
            metadataUnboundedWrites.push({
              ...evidenceFor(call, rootDir),
              snippet: `writes the growing collection "${value?.getText()}" to metadata`,
            });
          }
        }

        if (resolver.isTriggerMember(expression, REALTIME_METHODS)) {
          realtimeUsage.push(evidenceFor(call, rootDir));
        }

        if (resolver.isTriggerMember(expression, WAIT_METHODS)) {
          waitUsage.push(evidenceFor(call, rootDir));
        }

        if (resolver.isTriggerMember(expression, WAIT_TOKEN_METHODS)) {
          waitTokenUsage.push(evidenceFor(call, rootDir));
        }

        // Matched by declaring module rather than receiver name, because
        // `streams` is a namespace re-export and `append` is also a metadata
        // method. A handle from streams.define(...) resolves here too.
        if (isStreamsApi && resolver.isTriggerMember(expression, STREAM_METHODS)) {
          streamUsage.push(evidenceFor(call, rootDir));
        }

        // Unwrapping a lone sequential run has no siblings to abort, so it is
        // only a failure-isolation problem when runs are in flight alongside it.
        if (
          resolver.isTriggerMember(expression, UNWRAP_METHOD) &&
          (isInParallelCombinator(call) || dispatchesBatch(expression, resolver))
        ) {
          unsafeUnwraps.push(evidenceFor(call, rootDir));
        }
      }

      if (text === "setTimeout") {
        const delay = numericValue(call.getArguments()[1]);
        const loop = call.getFirstAncestor(
          (a) => Node.isWhileStatement(a) || Node.isForStatement(a) || Node.isDoStatement(a),
        );

        // Inside a loop this is polling, and polling is only a defect when it
        // waits on something durable that a waitpoint could park on -- another
        // run, an external job. A loop touching nothing but local state is
        // work the step is doing, such as draining an encoder's output files
        // while it runs in this process, and no checkpoint can replace it:
        // the run has to stay executing for the subprocess to keep going.
        //
        // The interval being long does not change that, so the locality test
        // governs the whole loop case. Judging a loop by its delay reported
        // that same drain as a blocking sleep.
        const pollsSomethingRemote = (scope: Node) =>
          scope.getDescendantsOfKind(SyntaxKind.CallExpression).some((inner) => {
            const callee = inner.getExpression();
            return (
              callee.getText() === "fetch" ||
              resolver.isTriggerMember(callee, REMOTE_STATUS_METHODS)
            );
          });

        const insideLoop = Boolean(loop) && pollsSomethingRemote(loop!);
        const longBareSleep = !loop && delay !== undefined && delay >= LONG_SLEEP_MS;

        if (longBareSleep || insideLoop) {
          pollingSleeps.push({
            ...evidenceFor(call, rootDir),
            snippet: insideLoop
              ? "setTimeout inside a loop (polling)"
              : `setTimeout sleeping ${delay}ms`,
          });
        }
      }
    }

    // Resolved against the type the SDK declares in that position, so an
    // `onCancel` on some unrelated options bag does not count.
    //
    // Trigger options are also routinely assembled in a loop and pushed into an
    // array before being handed to a batch trigger. That puts them outside the
    // dispatch call and out of reach of contextual typing, so being inside a
    // resolved task body counts too: these key names are SDK vocabulary and a
    // task body is a tight enough scope.
    for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      const inTaskBody = isInsideTaskBody(property, resolver);

      const optionKey = (name: string) =>
        resolver.isTriggerProperty(property, name) ||
        (inTaskBody && property.getName() === name);

      if (optionKey("idempotencyKey")) {
        idempotencyKeyUsage.push(evidenceFor(property, rootDir));

        // A raw string is hashed with the parent run id, so it dedupes across
        // attempts of one run and nothing wider. Keys built through
        // idempotencyKeys.create carry an explicit scope and are classified at
        // that call site instead.
        //
        // Decided on the type rather than the syntax. Matching only literals
        // meant a key returned by a helper -- `idempotencyKey: syncKey(sync)`,
        // the natural way to keep key construction in one place -- was
        // classified as neither, so the scope check reported n/a and the
        // submission's replay safety was never actually verified. The SDK's
        // IdempotencyKey is a branded type, so anything still resolving to a
        // plain string is a raw key however it was produced.
        const value = property.getInitializer();
        const isRawString = Boolean(value) && !resolver.isTriggerTyped(value) && (() => {
          try {
            const type = value!.getType();
            const parts = type.isUnion() ? type.getUnionTypes() : [type];
            return parts.every((part) => part.isString() || part.isStringLiteral());
          } catch {
            return false;
          }
        })();

        if (isRawString) {
          idempotencyScopes.push({
            scope: "run",
            insideTask: inTaskBody,
            evidence: {
              ...evidenceFor(property, rootDir),
              snippet: `raw string key (run scope by default)`,
            },
          });
        }
      }
      if (optionKey("concurrencyKey")) {
        concurrencyKeyUsage.push(evidenceFor(property, rootDir));
      }
      if (optionKey("priority")) {
        priorityUsage.push(evidenceFor(property, rootDir));
      }
      if (resolver.isTriggerProperty(property, "onCancel")) {
        cancellationUsage.push(evidenceFor(property, rootDir));
      }
      if (resolver.isTriggerProperty(property, "machine")) {
        machineUsage.push(evidenceFor(property, rootDir));
      }
      if (resolver.isTriggerProperty(property, "outOfMemory")) {
        outOfMemoryUsage.push(evidenceFor(property, rootDir));
      }
      // A cron written into the source is the same time for every tenant.
      if (resolver.isTriggerProperty(property, "cron")) {
        staticCronUsage.push(evidenceFor(property, rootDir));
      }
    }

    // schedules.create registers a schedule at runtime, so each tenant can
    // have its own time and timezone without a redeploy. Matched by declaring
    // module because `schedules` is a namespace re-export.
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) continue;
      if (!SCHEDULE_MUTATION_METHODS.test(expression.getName())) continue;

      const declaredIn = resolver.triggerDeclarationPaths(expression.getNameNode());
      if (!declaredIn.some((filePath) => /[\\/]schedules[\\/]/.test(filePath))) continue;

      runtimeScheduleUsage.push(evidenceFor(call, rootDir));
    }

    // `idempotencyKeys.create(...)` exists for exactly one purpose, so a
    // resolved call to it is evidence on its own. Scoped by the receiver's
    // resolved export name so `schedules.create(...)` does not qualify.
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) continue;
      if (expression.getName() !== "create") continue;
      if (resolver.triggerExportName(expression.getExpression()) !== "idempotencyKeys") continue;

      idempotencyKeyUsage.push(evidenceFor(call, rootDir));

      const declaredScope = objectProperty(call.getArguments()[1], "scope")
        ?.getText()
        .replace(/['"`]/g, "");

      idempotencyScopes.push({
        scope:
          declaredScope === "global" ? "global" : declaredScope === "attempt" ? "attempt" : "run",
        insideTask: isInsideTaskBody(call, resolver),
        evidence: {
          ...evidenceFor(call, rootDir),
          snippet: `${declaredScope ?? "run"}-scoped key`,
        },
      });
    }

    // AbortSignal plumbed from the run context is the other cancellation path.
    // The `signal` property is declared on the SDK's run-context types, so
    // resolution replaces guessing at the receiver's name.
    for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (resolver.isTriggerMember(access, SIGNAL_PROPERTY)) {
        cancellationUsage.push(evidenceFor(access, rootDir));
      }
    }

    // `run: async (payload, { signal }) => ...` is the idiomatic form, and it
    // is a binding rather than a property access, so it needs its own pass.
    for (const binding of sourceFile.getDescendantsOfKind(SyntaxKind.BindingElement)) {
      if (binding.getName() !== "signal") continue;
      if (!isInsideTaskBody(binding, resolver)) continue;
      cancellationUsage.push({
        ...evidenceFor(binding, rootDir),
        snippet: "signal destructured from the run context",
      });
    }

    // Collect module-scope bindings that could hold state. Whether they
    // actually do is decided below, by looking for writes from a task body.
    for (const statement of sourceFile.getVariableStatements()) {
      const declarationKind = statement.getDeclarationKind();
      for (const declaration of statement.getDeclarations()) {
        const initializer = declaration.getInitializer();
        const initializerText = initializer?.getText() ?? "";

        // Task, queue and config definitions are SDK handles, not state.
        if (initializer && resolver.isTriggerCall(initializer, undefined)) continue;

        const isReassignable = declarationKind !== "const";
        const isContainer = /^new (Map|Set|WeakMap|WeakSet)\(|^\[|^\{/.test(initializerText);

        if (isReassignable || isContainer) {
          stateCandidates.set(declaration.getName(), declaration);
        }
      }
    }
  }

  // A module-scope binding is only shared run state if a task body writes to
  // it. A frozen config array or a lazily-built client singleton is neither
  // per-run data nor something a restart can lose.
  const moduleLevelState: Evidence[] = [];
  const flagged = new Set<string>();

  for (const sourceFile of project.getSourceFiles()) {
    for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const name = identifier.getText();
      const declaration = stateCandidates.get(name);
      if (!declaration || flagged.has(name)) continue;
      if (!isInsideTaskBody(identifier, resolver) || !isMutatingReference(identifier)) continue;

      flagged.add(name);
      moduleLevelState.push({
        ...evidenceFor(declaration, rootDir),
        snippet: `module-scope "${name}", written to by a task body at ${
          evidenceFor(identifier, rootDir).file
        }:${evidenceFor(identifier, rootDir).line}`,
      });
    }
  }

  return {
    metadataUsage,
    realtimeUsage,
    cancellationUsage,
    idempotencyKeyUsage,
    concurrencyKeyUsage,
    waitUsage,
    moduleLevelState,
    unsafeUnwraps,
    pollingSleeps,
    waitTokenUsage,
    streamUsage,
    machineUsage,
    outOfMemoryUsage,
    runtimeScheduleUsage,
    staticCronUsage,
    priorityUsage,
    metadataUnboundedWrites,
    idempotencyScopes,
  };
}

export function extractFacts(outputDir: string, project = createProject(outputDir)): UsageFacts {
  const rootDir = outputDir;
  const resolver = createTriggerResolver(project);
  const rawTasks: { fact: TaskFact; node: Node }[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    for (const declaration of sourceFile.getVariableDeclarations()) {
      const initializer = declaration.getInitializer();
      if (!initializer || !Node.isCallExpression(initializer)) continue;
      if (!resolver.isTriggerFactoryCall(initializer, TASK_FACTORIES)) continue;

      const config = initializer.getArguments()[0];
      const idValue = objectProperty(config, "id");
      const retryValue = objectProperty(config, "retry");
      const queueValue = objectProperty(config, "queue");

      let queue: TaskFact["queue"];
      if (queueValue) {
        if (Node.isObjectLiteralExpression(queueValue)) {
          queue = {
            kind: "inline",
            concurrencyLimit: numericValue(objectProperty(queueValue, "concurrencyLimit")),
            limitDeclared: hasProperty(queueValue, "concurrencyLimit"),
          };
        } else {
          queue = { kind: "reference", ref: queueValue.getText() };
        }
      }

      rawTasks.push({
        node: declaration,
        fact: {
          name: declaration.getName(),
          taskId: idValue?.getText().replace(/['"`]/g, ""),
          exported: declaration.getVariableStatement()?.isExported() ?? false,
          hasRetryConfig: Boolean(retryValue),
          retryMaxAttempts: numericValue(objectProperty(retryValue, "maxAttempts")),
          queue,
          dispatches: [],
          manualRetryLoops: [],
          inlineParallelism: [],
          readsRunOk: false,
          evidence: evidenceFor(declaration, rootDir),
        },
      });
    }
  }

  const taskNames = new Set(rawTasks.map((t) => t.fact.name));

  for (const { fact, node } of rawTasks) {
    for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (!resolver.isTriggerMember(expression, DISPATCH_METHODS)) continue;
      if (!Node.isPropertyAccessExpression(expression)) continue;

      const method = expression.getName();
      const onBatchNamespace =
        BATCH_NAMESPACE_METHODS.has(method) &&
        resolver.triggerExportName(expression.getExpression()) === "batch";
      const isBatch = BATCH_METHODS.has(method) || onBatchNamespace;

      // A `batch` call names its targets inside the items rather than as the
      // receiver, so read them out. Without this the dispatch points at the
      // namespace, no task is recorded as a worker, and the checks that look
      // at what the orchestrator handed off see nothing.
      const usesNamespace = onBatchNamespace || method.startsWith("triggerByTask");
      const targets = usesNamespace
        ? collectBatchTargets(call, taskNames)
        : [expression.getExpression().getText()];

      for (const target of targets.length > 0 ? targets : [expression.getExpression().getText()]) {
        fact.dispatches.push({
          target,
          method,
          inSequentialLoop: isInSequentialLoop(call),
          isBatch,
          chunked: isBatch && isChunkedBatch(call),
          evidence: evidenceFor(call, rootDir),
        });
      }
    }

    fact.manualRetryLoops = findManualRetryLoops(node, rootDir);
    fact.inlineParallelism = findInlineParallelism(node, resolver, rootDir);

    // Prefer resolving `ok` to the SDK's run-result union, so an unrelated
    // `ok` field on the model's own objects does not count. But defensive code
    // like `Array.isArray(batch) ? batch : batch.runs` widens the type and
    // loses that declaration, so fall back to any `.ok` read inside a task that
    // actually dispatches: still far tighter than matching `.ok` anywhere.
    const okAccesses = node
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .filter((access) => access.getName() === "ok");

    fact.readsRunOk =
      okAccesses.some((access) => resolver.isTriggerMember(access, OK_PROPERTY)) ||
      (fact.dispatches.length > 0 && okAccesses.length > 0);
  }

  // --- Queue declarations --------------------------------------------------
  const queues: QueueFact[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    for (const declaration of sourceFile.getVariableDeclarations()) {
      const initializer = declaration.getInitializer();
      if (!initializer || !Node.isCallExpression(initializer)) continue;
      if (!resolver.isTriggerCall(initializer, QUEUE_FACTORY)) continue;

      const config = initializer.getArguments()[0];
      queues.push({
        varName: declaration.getName(),
        queueName: objectProperty(config, "name")?.getText().replace(/['"`]/g, ""),
        concurrencyLimit: numericValue(objectProperty(config, "concurrencyLimit")),
        limitDeclared: hasProperty(config, "concurrencyLimit"),
        evidence: evidenceFor(declaration, rootDir),
      });
    }
  }

  // --- Orchestrator vs workers --------------------------------------------
  const dispatched = new Set(
    rawTasks.flatMap(({ fact }) => fact.dispatches.map((d) => d.target)),
  );
  const allFacts = rawTasks.map(({ fact }) => fact);
  const dispatchers = allFacts.filter((fact) => fact.dispatches.length > 0);

  // Preference order: wherever the batch dispatch is, then whichever
  // dispatcher waits on children, then the one handing off the most work.
  const orchestrator =
    dispatchers.find((fact) => fact.dispatches.some((dispatch) => dispatch.isBatch)) ??
    dispatchers.find((fact) =>
      fact.dispatches.some((dispatch) => /AndWait$/.test(dispatch.method)),
    ) ??
    [...dispatchers].sort((a, b) => b.dispatches.length - a.dispatches.length)[0];

  return {
    tasks: allFacts,
    queues,
    handRolledLimiters: findHandRolledLimiters(project, rootDir),
    externalOrchestrators: findExternalOrchestrators(project, rootDir),
    dispatchers,
    orchestrator,
    workers: allFacts.filter((fact) => dispatched.has(fact.name)),
    limits: resolvePlatformLimits(outputDir),
    aggregatedOutputs: rawTasks.flatMap(({ node }) =>
      findAggregatedOutputs(node, resolver, rootDir),
    ),
    inlinePayloadBlobs: rawTasks.flatMap(({ node }) =>
      findInlinePayloadBlobs(node, resolver, rootDir),
    ),
    ...collectAncillaryFacts(project, rootDir, resolver),
  };
}

/** Resolves the effective concurrency limit a task runs under, if any. */
export function effectiveConcurrencyLimit(
  task: TaskFact,
  queues: QueueFact[],
): { limit?: number; declared: boolean; source?: string } {
  if (!task.queue) return { declared: false };

  if (task.queue.kind === "inline") {
    return {
      limit: task.queue.concurrencyLimit,
      declared: Boolean(task.queue.limitDeclared),
      source: "inline queue config",
    };
  }

  const referenced = queues.find((q) => q.varName === task.queue?.ref);
  if (!referenced) {
    return { declared: false, source: `queue reference "${task.queue.ref}" (not resolved)` };
  }

  return {
    limit: referenced.concurrencyLimit,
    declared: referenced.limitDeclared,
    source: `queue "${referenced.queueName ?? referenced.varName}"`,
  };
}
