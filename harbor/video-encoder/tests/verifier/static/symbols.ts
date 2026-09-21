/**
 * Symbol resolution against the installed SDK.
 *
 * The checks used to recognise primitives by identifier text, which meant
 * `import { task as job }` was invisible and any local variable called
 * `metadata` counted as run metadata. Resolving through the type checker
 * instead ties every match to a declaration inside an @trigger.dev package, so
 * aliases are followed and lookalikes are rejected.
 */
import { Node, type Project, type Symbol as TsSymbol, type Type } from "ts-morph";

/**
 * SDK exports that define a task. Lives here rather than in facts.ts because
 * the resolver needs it to know where a task body begins.
 */
export const TASK_FACTORY_NAMES: ReadonlySet<string> = new Set(["task", "schemaTask"]);

/** Matches declaration paths inside any @trigger.dev package. */
const TRIGGER_PACKAGE = /[\\/]@trigger\.dev[\\/]/;

function declarationsOf(symbol: TsSymbol) {
  const declarations = [...symbol.getDeclarations()];

  // Import bindings declare locally and alias to the real export.
  try {
    const aliased = symbol.getAliasedSymbol();
    if (aliased) declarations.push(...aliased.getDeclarations());
  } catch {
    // Not an alias.
  }

  return declarations;
}

function declaredByTriggerDev(symbol: TsSymbol | undefined): boolean {
  if (!symbol) return false;
  return declarationsOf(symbol).some((declaration) =>
    TRIGGER_PACKAGE.test(declaration.getSourceFile().getFilePath()),
  );
}

function typeDeclaredByTriggerDev(type: Type | undefined): boolean {
  if (!type) return false;

  const candidates = type.isUnion() || type.isIntersection() ? type.getUnionTypes().concat(type.getIntersectionTypes()) : [type];
  for (const candidate of [type, ...candidates]) {
    if (declaredByTriggerDev(candidate.getSymbol() ?? candidate.getAliasSymbol())) return true;
  }
  return false;
}

export interface TriggerResolver {
  /** The thing this node names is declared by an @trigger.dev package. */
  isTriggerSymbol(node: Node | undefined): boolean;
  /** The type of this node comes from an @trigger.dev package. */
  isTriggerTyped(node: Node | undefined): boolean;
  /**
   * The call's callee resolves to an @trigger.dev export with one of these
   * names, following import aliases.
   */
  isTriggerCall(call: Node, names: ReadonlySet<string> | RegExp | undefined): boolean;
  /**
   * A property access whose property is declared on an @trigger.dev type, e.g.
   * `myTask.batchTriggerAndWait` or `ctx.signal`.
   */
  isTriggerMember(node: Node | undefined, names?: ReadonlySet<string> | RegExp): boolean;
  /**
   * An object-literal property whose key is declared on an @trigger.dev type,
   * e.g. `onCancel` in a task config or `idempotencyKey` in trigger options.
   * Falls back to the contextual type when the key has no direct symbol.
   */
  isTriggerProperty(property: Node, name: string): boolean;
  /**
   * The node sits inside the arguments of a call that resolves to the SDK.
   * Used where contextual typing does not reach, e.g. options built inside a
   * `.map()` callback passed to a batch trigger.
   */
  isInsideTriggerCall(node: Node): boolean;
  /**
   * A call to an SDK factory, whether written as a bare import (`task(...)`)
   * or as a member of an SDK namespace (`schedules.task(...)`).
   */
  isTriggerFactoryCall(node: Node, names: ReadonlySet<string> | RegExp): boolean;
  /**
   * The SDK export name this node resolves to, following aliases. Undefined
   * when it does not resolve to an @trigger.dev declaration.
   */
  triggerExportName(node: Node | undefined): string | undefined;
  /**
   * Declaration file paths for what this node names, restricted to
   * @trigger.dev packages. Namespace re-exports such as `schedules` resolve to
   * a module symbol rather than a named export, so matching the declaring
   * module is the reliable way to tell which SDK namespace a call came from.
   */
  triggerDeclarationPaths(node: Node | undefined): string[];
}

function matches(name: string, names: ReadonlySet<string> | RegExp | undefined): boolean {
  if (!names) return true;
  return names instanceof RegExp ? names.test(name) : names.has(name);
}

export function createTriggerResolver(project: Project): TriggerResolver {
  const checker = project.getTypeChecker();

  const symbolAt = (node: Node | undefined): TsSymbol | undefined => {
    if (!node) return undefined;
    return node.getSymbol() ?? checker.getSymbolAtLocation(node);
  };

  const isTriggerSymbol = (node: Node | undefined) => declaredByTriggerDev(symbolAt(node));

  const isTriggerTyped = (node: Node | undefined) => {
    if (!node) return false;
    try {
      return typeDeclaredByTriggerDev(node.getType());
    } catch {
      return false;
    }
  };

  const isTriggerMember: TriggerResolver["isTriggerMember"] = (node, names) => {
    if (!node || !Node.isPropertyAccessExpression(node)) return false;
    if (!matches(node.getName(), names)) return false;

    // The property itself is declared on an SDK type (e.g. Task.trigger), or
    // the receiver is an SDK value (e.g. the `metadata` export).
    return isTriggerSymbol(node.getNameNode()) || isTriggerSymbol(node.getExpression());
  };

  const resolver: TriggerResolver = {
    isTriggerSymbol,
    isTriggerTyped,

    isInsideTriggerCall(node) {
      // The walk stops at the task factory. Without that boundary every node
      // in a task body was "inside an SDK call", because `task({ run })` is
      // itself one -- so a submission's own `store.create({ idempotencyKey })`
      // resolved as if it were a trigger option.
      let found = false;

      node.getFirstAncestor((ancestor) => {
        if (!Node.isCallExpression(ancestor)) return false;
        if (resolver.isTriggerFactoryCall(ancestor, TASK_FACTORY_NAMES)) return true;

        const wrapsNode = ancestor
          .getArguments()
          .some((argument) => argument.containsRange(node.getPos(), node.getEnd()));
        if (!wrapsNode) return false;

        if (
          resolver.isTriggerCall(ancestor, undefined) ||
          resolver.isTriggerMember(ancestor.getExpression())
        ) {
          found = true;
          return true;
        }

        return false;
      });

      return found;
    },

    isTriggerCall(call, names) {
      if (!Node.isCallExpression(call)) return false;
      const callee = call.getExpression();
      if (!Node.isIdentifier(callee)) return false;

      const symbol = symbolAt(callee);
      if (!symbol) return false;

      // Compare against the resolved export name so aliased imports still
      // match, then confirm the declaration is the SDK's.
      const resolvedName =
        (() => {
          try {
            return symbol.getAliasedSymbol()?.getName();
          } catch {
            return undefined;
          }
        })() ?? symbol.getName();

      return matches(resolvedName, names) && declaredByTriggerDev(symbol);
    },

    isTriggerMember,

    triggerDeclarationPaths(node) {
      const symbol = symbolAt(node);
      if (!symbol) return [];

      return declarationsOf(symbol)
        .map((declaration) => declaration.getSourceFile().getFilePath() as string)
        .filter((filePath) => TRIGGER_PACKAGE.test(filePath));
    },

    triggerExportName(node) {
      const symbol = symbolAt(node);
      if (!declaredByTriggerDev(symbol)) return undefined;

      try {
        return symbol!.getAliasedSymbol()?.getName() ?? symbol!.getName();
      } catch {
        return symbol!.getName();
      }
    },

    isTriggerFactoryCall(node, names) {
      if (!Node.isCallExpression(node)) return false;
      if (resolver.isTriggerCall(node, names)) return true;

      // `schedules.task(...)` and friends: the factory is reached through an
      // SDK namespace rather than imported directly.
      return resolver.isTriggerMember(node.getExpression(), names);
    },

    isTriggerProperty(property, name) {
      if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property)) {
        return false;
      }
      if (property.getName() !== name) return false;

      // The key's own symbol belongs to the literal being written, not to the
      // SDK, so resolution has to go through the type the SDK expects in this
      // position. That is what distinguishes `onCancel` in a task config from
      // `onCancel` on some unrelated options bag.
      const literal = property.getParent();
      if (!Node.isObjectLiteralExpression(literal)) return false;

      try {
        const contextual = checker.getContextualType(literal);
        if (declaredByTriggerDev(contextual?.getProperty(name))) return true;
      } catch {
        // Fall through to the structural fallback.
      }

      // Contextual typing does not reach into a callback's return value, which
      // is exactly how batch items are usually built. Accepting the key only
      // when it is inside a resolved SDK call keeps the scope tight.
      return resolver.isInsideTriggerCall(property);
    },
  };

  return resolver;
}
