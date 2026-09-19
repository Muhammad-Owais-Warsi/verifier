import {
  type DiagnosticMessageChain,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  ts,
} from "ts-morph";
import path from "node:path";
import { createProject, resolveInstalledPackage, TASK_FACTORIES } from "./facts.js";
import { createTriggerResolver, type TriggerResolver } from "./symbols.js";
import type { Check, Evidence } from "../types.js";

/** TypeScript suggestion diagnostics that mean "you used something deprecated". */
const DEPRECATED_DIAGNOSTIC_CODES = new Set([6385, 6387]);

/**
 * v3-era APIs that the v4 SDK does not mark @deprecated because they were
 * removed outright rather than soft-deprecated.
 */
const LEGACY_APIS: { pattern: RegExp; label: string }[] = [
  { pattern: /^@trigger\.dev\/sdk\/v3$/, label: "@trigger.dev/sdk/v3 import path" },
  { pattern: /^@trigger\.dev\/sdk\/v2$/, label: "@trigger.dev/sdk/v2 import path" },
];

const LEGACY_CALLS: { object: string; method: string; label: string }[] = [
  { object: "client", method: "defineJob", label: "client.defineJob()" },
  { object: "io", method: "runTask", label: "io.runTask()" },
  { object: "io", method: "wait", label: "io.wait()" },
  { object: "io", method: "logger", label: "io.logger" },
];

export interface StaticResult {
  checks: Check[];
  /** Task variable names discovered in the submission, exported or not. */
  taskVariables: { name: string; exported: boolean; taskId?: string }[];
  typeErrors: string[];
  /**
   * Set when the submission cannot be analysed at all. Usage analysis on such a
   * submission reports every primitive as missing, which reads as a verdict on
   * the implementation rather than on the state of the directory.
   */
  fatal?: { stage: "empty" | "dependencies" | "compile"; reason: string };
}

/**
 * ts-morph wraps message chains in its own class, which
 * ts.flattenDiagnosticMessageText does not understand and silently renders as
 * "undefined". Unwrap the chain ourselves.
 */
function flattenMessage(message: string | DiagnosticMessageChain): string {
  if (typeof message === "string") return message;

  const parts = [message.getMessageText()];
  for (const next of message.getNext() ?? []) {
    parts.push(flattenMessage(next));
  }
  return parts.join(" ");
}

/**
 * Whether the symbol referenced at `pos` is declared by a Trigger.dev package.
 *
 * Used to scope the deprecation check to the SDK. Resolves through import
 * aliases so `import { task } from "@trigger.dev/sdk"` lands on the real
 * declaration rather than the local binding.
 */
function isTriggerDevSymbol(project: Project, sourceFile: SourceFile, pos: number): boolean {
  const node = sourceFile.getDescendantAtPos(pos);
  if (!node) return false;

  const checker = project.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return false;

  const declarations = [...symbol.getDeclarations()];
  try {
    declarations.push(...symbol.getAliasedSymbol()!.getDeclarations());
  } catch {
    // Not an alias; the direct declarations are all there is.
  }

  return declarations.some((declaration) =>
    declaration.getSourceFile().getFilePath().includes("/@trigger.dev/"),
  );
}

/**
 * Deprecated properties in a task or options config.
 *
 * TypeScript's suggestion diagnostics only flag deprecated *references*, so
 * `metadata.stream(...)` is reported but `handleError:` in a task config is
 * not: an object-literal key is not a reference to the property it satisfies.
 * That silently exempted the hooks the SDK renamed, which are among the most
 * likely things for a model working from older material to reach for.
 *
 * Resolves the key against the type the SDK expects in that position and reads
 * the JSDoc tags off the declaration, so this tracks whatever the installed
 * version marks rather than a list maintained here.
 */
function findDeprecatedConfigProperties(project: Project, rootDir: string): Evidence[] {
  const checker = project.getTypeChecker();
  const found: Evidence[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      const literal = property.getParent();
      if (!Node.isObjectLiteralExpression(literal)) continue;

      let propertySymbol;
      try {
        propertySymbol = checker.getContextualType(literal)?.getProperty(property.getName());
      } catch {
        continue;
      }
      if (!propertySymbol) continue;

      const declaredByTriggerDev = propertySymbol
        .getDeclarations()
        .some((declaration) =>
          declaration.getSourceFile().getFilePath().includes("/@trigger.dev/"),
        );
      if (!declaredByTriggerDev) continue;

      const deprecated = propertySymbol
        .getJsDocTags()
        .find((tag) => tag.getName() === "deprecated");
      if (!deprecated) continue;

      const guidance = (deprecated.getText() ?? [])
        .map((part) => part.text)
        .join("")
        .trim();

      found.push({
        ...evidenceFor(property.getNameNode(), rootDir),
        snippet: `'${property.getName()}' is deprecated${guidance ? `. ${guidance}` : ""}`,
      });
    }
  }

  return found;
}

function evidenceFor(node: Node, rootDir: string): Evidence {
  const sourceFile = node.getSourceFile();
  return {
    file: path.relative(rootDir, sourceFile.getFilePath()),
    line: sourceFile.getLineAndColumnAtPos(node.getStart()).line,
    snippet: node.getText().split("\n")[0].slice(0, 160),
  };
}

/**
 * Collects variables initialised with a `task(...)`-family call. Used both to
 * detect unexported tasks and to spot direct `.run()` invocations later.
 *
 * Matches by call shape rather than a fixed name list so that
 * `schemaTask`, `task`, and any aliased import are all picked up.
 */
function collectTaskVariables(project: Project, resolver: TriggerResolver) {
  const found: { name: string; exported: boolean; taskId?: string; node: Node }[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    for (const declaration of sourceFile.getVariableDeclarations()) {
      const initializer = declaration.getInitializer();
      if (!initializer || !Node.isCallExpression(initializer)) continue;
      if (!resolver.isTriggerFactoryCall(initializer, TASK_FACTORIES)) continue;

      const configArg = initializer.getArguments()[0];
      let taskId: string | undefined;
      if (configArg && Node.isObjectLiteralExpression(configArg)) {
        const idProperty = configArg.getProperty("id");
        if (idProperty && Node.isPropertyAssignment(idProperty)) {
          taskId = idProperty.getInitializer()?.getText().replace(/['"`]/g, "");
        }
      }

      found.push({
        name: declaration.getName(),
        exported: declaration.getVariableStatement()?.isExported() ?? false,
        taskId,
        node: declaration,
      });
    }
  }

  return found;
}

/**
 * Methods that mean "this task dispatches that one".
 *
 * `run` is included deliberately. Calling it directly is a violation, flagged
 * separately by static.no_direct_run_calls, but for the purpose of finding the
 * orchestrator it is still a dispatch edge. Without it, a submission that
 * bypasses the platform entirely would be undiscoverable and could never be
 * run to demonstrate its other failures.
 */
const DISPATCH_METHODS = new Set([
  "trigger",
  "triggerAndWait",
  "batchTrigger",
  "batchTriggerAndWait",
  "triggerAndSubscribe",
  "run",
]);

export interface RootDiscovery {
  taskId?: string;
  candidates: string[];
  ambiguous: boolean;
  reason: string;
}

/**
 * Finds the task to trigger, without being told which one it is.
 *
 * The root is the task that dispatches other tasks but is itself dispatched by
 * nobody. Falls back to the only task when the submission defines just one.
 */
export function discoverRootTask(outputDir: string): RootDiscovery {
  const project = createProject(outputDir);
  const taskVariables = collectTaskVariables(project, createTriggerResolver(project));

  if (taskVariables.length === 0) {
    return { candidates: [], ambiguous: false, reason: "no task definitions found" };
  }

  const byName = new Map(taskVariables.map((t) => [t.name, t]));
  const dispatched = new Set<string>();
  const dispatchers = new Set<string>();

  for (const taskVariable of taskVariables) {
    for (const call of taskVariable.node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) continue;
      if (!DISPATCH_METHODS.has(expression.getName())) continue;

      const target = expression.getExpression().getText();
      if (byName.has(target)) {
        dispatched.add(target);
        dispatchers.add(taskVariable.name);
      }
    }
  }

  const roots = taskVariables.filter(
    (t) => dispatchers.has(t.name) && !dispatched.has(t.name),
  );

  if (roots.length === 1 && roots[0].taskId) {
    return {
      taskId: roots[0].taskId,
      candidates: [roots[0].taskId],
      ambiguous: false,
      reason: `"${roots[0].name}" dispatches other tasks and is dispatched by none`,
    };
  }

  if (roots.length === 0 && taskVariables.length === 1 && taskVariables[0].taskId) {
    return {
      taskId: taskVariables[0].taskId,
      candidates: [taskVariables[0].taskId],
      ambiguous: false,
      reason: "the submission defines exactly one task",
    };
  }

  const candidates = (roots.length > 0 ? roots : taskVariables)
    .map((t) => t.taskId)
    .filter((id): id is string => Boolean(id));

  return {
    candidates,
    ambiguous: true,
    reason:
      roots.length > 1
        ? `${roots.length} tasks dispatch others without being dispatched themselves`
        : "could not identify a single orchestrating task",
  };
}

export function runStaticGate(outputDir: string): StaticResult {
  const project = createProject(outputDir);
  const resolver = createTriggerResolver(project);
  const checks: Check[] = [];
  const sourceFiles = project.getSourceFiles();

  if (sourceFiles.length === 0) {
    checks.push({
      id: "static.sources_present",
      category: "static",
      title: "Submission contains TypeScript sources",
      status: "fail",
      expected: "at least one .ts file under the submission",
      actual: "no TypeScript files found",
      why: "There is nothing to verify. Check that the submission directory contains the implementation.",
      evidence: [],
    });
    return {
      checks,
      taskVariables: [],
      typeErrors: [],
      fatal: {
        stage: "empty",
        reason: "The submission directory contains no TypeScript sources.",
      },
    };
  }

  // --- Dependencies installed ---------------------------------------------
  // The submission installs its own dependencies. Without the SDK present,
  // every import fails to resolve and the type errors would be reported as
  // "the code is wrong" rather than "it was never installed".
  if (!resolveInstalledPackage(outputDir, "@trigger.dev/sdk")) {
    checks.push({
      id: "static.sdk_installed",
      category: "static",
      title: "Trigger.dev SDK is installed",
      status: "fail",
      expected: "@trigger.dev/sdk resolvable from the submission",
      actual: "not installed",
      why: "@trigger.dev/sdk is not installed in the submission, so it cannot be compiled against the real SDK. Run the submission's install step before verifying.",
      evidence: [],
    });
    return {
      checks,
      taskVariables: [],
      typeErrors: [],
      fatal: {
        stage: "dependencies",
        reason:
          "@trigger.dev/sdk is not installed in the submission, so it cannot be compiled against the real SDK.",
      },
    };
  }

  // --- Type validity -------------------------------------------------------
  // Compiles against the real @trigger.dev/sdk types, so a submission has to be
  // genuinely valid Trigger.dev code rather than something that merely looks right.
  const typeErrors = project
    .getPreEmitDiagnostics()
    .filter((d) => d.getCategory() === ts.DiagnosticCategory.Error)
    .map((d) => {
      const file = d.getSourceFile();
      const location = file && d.getStart() !== undefined
        ? `${path.relative(outputDir, file.getFilePath())}:${file.getLineAndColumnAtPos(d.getStart()!).line}`
        : "<unknown>";
      return `${location} TS${d.getCode()}: ${flattenMessage(d.getMessageText())}`;
    });

  checks.push({
    id: "static.type_checks",
    category: "static",
    title: "Compiles against the real Trigger.dev SDK types",
    status: typeErrors.length === 0 ? "pass" : "fail",
    expected: "no TypeScript errors against @trigger.dev/sdk",
    actual: typeErrors.length === 0 ? "clean" : `${typeErrors.length} type error(s)`,
    why:
      typeErrors.length === 0
        ? "The submission type-checks against the real SDK, so the primitives are being called with valid shapes."
        : `The submission does not type-check, so it is not valid Trigger.dev code:\n${typeErrors.slice(0, 5).join("\n")}`,
    evidence: [],
  });

  // --- Deprecated symbols, as flagged by the SDK itself --------------------
  // Reading TypeScript's own suggestion diagnostics means this tracks whatever
  // SDK version is installed instead of a hand-maintained list. Those
  // diagnostics cover every dependency, so each one is resolved back to its
  // declaration and kept only if it came from Trigger.dev: a deprecated Zod or
  // Node overload says nothing about how the submission uses the platform.
  const deprecatedEvidence: Evidence[] = [];
  const languageService = project.getLanguageService().compilerObject;
  for (const sourceFile of sourceFiles) {
    for (const diagnostic of languageService.getSuggestionDiagnostics(
      sourceFile.getFilePath(),
    )) {
      if (!DEPRECATED_DIAGNOSTIC_CODES.has(diagnostic.code)) continue;
      if (!isTriggerDevSymbol(project, sourceFile, diagnostic.start ?? 0)) continue;

      const { line } = sourceFile.getLineAndColumnAtPos(diagnostic.start ?? 0);
      deprecatedEvidence.push({
        file: path.relative(outputDir, sourceFile.getFilePath()),
        line,
        snippet: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      });
    }
  }

  deprecatedEvidence.push(...findDeprecatedConfigProperties(project, outputDir));

  checks.push({
    id: "static.no_deprecated_apis",
    category: "static",
    title: "No deprecated Trigger.dev SDK symbols",
    status: deprecatedEvidence.length === 0 ? "pass" : "fail",
    expected: "no @trigger.dev symbols marked @deprecated by the installed SDK",
    actual:
      deprecatedEvidence.length === 0
        ? "none"
        : `${deprecatedEvidence.length} deprecated SDK usage(s)`,
    why:
      deprecatedEvidence.length === 0
        ? "Nothing the installed Trigger.dev SDK marks as deprecated is used."
        : "The submission calls Trigger.dev APIs the SDK itself marks deprecated, which means it is written against an older mental model of the platform.",
    evidence: deprecatedEvidence,
  });

  // --- v3-era APIs ---------------------------------------------------------
  const legacyEvidence: Evidence[] = [];
  for (const sourceFile of sourceFiles) {
    for (const importDeclaration of sourceFile.getImportDeclarations()) {
      const specifier = importDeclaration.getModuleSpecifierValue();
      const match = LEGACY_APIS.find((l) => l.pattern.test(specifier));
      if (match) {
        legacyEvidence.push({
          ...evidenceFor(importDeclaration, outputDir),
          snippet: `${match.label}: ${importDeclaration.getText()}`,
        });
      }
    }

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) continue;
      const object = expression.getExpression().getText();
      const method = expression.getName();
      const match = LEGACY_CALLS.find((l) => l.object === object && l.method === method);
      if (match) {
        legacyEvidence.push({
          ...evidenceFor(call, outputDir),
          snippet: `${match.label}: ${call.getText().split("\n")[0].slice(0, 120)}`,
        });
      }
    }
  }

  checks.push({
    id: "static.no_v3_apis",
    category: "static",
    title: "No v3-era Trigger.dev APIs",
    status: legacyEvidence.length === 0 ? "pass" : "fail",
    expected: "no client.defineJob, io.runTask, or @trigger.dev/sdk/v3 imports",
    actual: legacyEvidence.length === 0 ? "none" : `${legacyEvidence.length} legacy usage(s)`,
    why:
      legacyEvidence.length === 0
        ? "No removed v3-era APIs are referenced."
        : "The submission uses APIs from Trigger.dev v2/v3 that no longer exist in v4.",
    evidence: legacyEvidence,
  });

  // --- Task registration ---------------------------------------------------
  const taskVariables = collectTaskVariables(project, resolver);
  const unexported = taskVariables.filter((t) => !t.exported);

  checks.push({
    id: "static.tasks_exported",
    category: "static",
    title: "Tasks are exported so the platform can register them",
    status:
      taskVariables.length === 0 ? "fail" : unexported.length === 0 ? "pass" : "fail",
    expected: "every task(...) definition is exported",
    actual:
      taskVariables.length === 0
        ? "no task definitions found"
        : unexported.length === 0
          ? `${taskVariables.length} task(s), all exported`
          : `${unexported.length} of ${taskVariables.length} task(s) not exported`,
    why:
      taskVariables.length === 0
        ? "No task() definitions were found at all, so nothing can run on the platform."
        : unexported.length === 0
          ? "All tasks are exported, which is what makes them discoverable by the worker."
          : "Trigger.dev only registers exported tasks. An unexported task silently never runs.",
    evidence: unexported.map((t) => evidenceFor(t.node, outputDir)),
  });

  // --- Direct .run() invocation -------------------------------------------
  // Calling a task's run function directly executes the body in-process and
  // bypasses the platform entirely: no queue, no retries, no run record.
  const taskNames = new Set(taskVariables.map((t) => t.name));
  const directRunEvidence: Evidence[] = [];
  for (const sourceFile of sourceFiles) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) continue;
      if (expression.getName() !== "run") continue;
      // The receiver must be one of the resolved task definitions, so an
      // unrelated object with a `run` method is not flagged.
      if (!taskNames.has(expression.getExpression().getText())) continue;
      directRunEvidence.push(evidenceFor(call, outputDir));
    }
  }

  checks.push({
    id: "static.no_direct_run_calls",
    category: "static",
    title: "Tasks are not invoked by calling run() directly",
    status: directRunEvidence.length === 0 ? "pass" : "fail",
    expected: "tasks invoked through trigger/batchTrigger, never task.run()",
    actual:
      directRunEvidence.length === 0
        ? "none"
        : `${directRunEvidence.length} direct run() call(s)`,
    why:
      directRunEvidence.length === 0
        ? "No task body is called directly, so invocations go through the platform."
        : "Calling a task's run() directly executes it in-process and bypasses Trigger.dev completely: no queue, no retries, and no run record.",
    evidence: directRunEvidence,
  });

  return {
    checks,
    taskVariables: taskVariables.map(({ name, exported, taskId }) => ({ name, exported, taskId })),
    typeErrors,
  };
}
