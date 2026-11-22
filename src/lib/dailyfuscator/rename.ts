import type { Expr, Stmt } from "./ast.ts";
import { freshIdent, type Rng } from "./rng.ts";

export function renameBody(body: Stmt[], rng: Rng, used: Set<string>): { body: Stmt[]; renamed: number } {
  const count = { n: 0 };
  return { body: renameBlock(body, new Map(), rng, used, count), renamed: count.n };
}

function renameBlock(
  stmts: Stmt[],
  scope: Map<string, string>,
  rng: Rng,
  used: Set<string>,
  count: { n: number },
): Stmt[] {
  return stmts.map((s) => renameStmt(s, scope, rng, used, count));
}

function child(scope: Map<string, string>): Map<string, string> {
  return new Map(scope);
}

function bind(scope: Map<string, string>, name: string, rng: Rng, used: Set<string>, count: { n: number }): string {
  const neu = freshIdent(rng, used);
  scope.set(name, neu);
  count.n++;
  return neu;
}

function renameStmt(
  s: Stmt,
  scope: Map<string, string>,
  rng: Rng,
  used: Set<string>,
  count: { n: number },
): Stmt {
  switch (s.type) {
    case "local": {
      const inits = s.inits.map((e) => renameExpr(e, scope, rng, used, count));
      const names = s.names.map((n) => bind(scope, n, rng, used, count));
      return { type: "local", names, inits };
    }
    case "assign":
      return {
        ...s,
        targets: s.targets.map((e) => renameExpr(e, scope, rng, used, count)),
        values: s.values.map((e) => renameExpr(e, scope, rng, used, count)),
      };
    case "call":
      return { ...s, expr: renameExpr(s.expr, scope, rng, used, count) as Extract<Expr, { type: "call" }> };
    case "do":
      return { ...s, body: renameBlock(s.body, child(scope), rng, used, count) };
    case "while":
      return {
        ...s,
        cond: renameExpr(s.cond, scope, rng, used, count),
        body: renameBlock(s.body, child(scope), rng, used, count),
      };
    case "if":
      return {
        ...s,
        arms: s.arms.map((a) => ({
          cond: renameExpr(a.cond, scope, rng, used, count),
          body: renameBlock(a.body, child(scope), rng, used, count),
        })),
        elseBody: s.elseBody ? renameBlock(s.elseBody, child(scope), rng, used, count) : null,
      };
    case "function": {
      const path = s.name.path.slice();
      if (!s.local) path[0] = scope.get(path[0]) ?? path[0];
      const inner = child(s.local ? scope : scope);
      let params: string[];
      let name = s.name;
      if (s.local) {
        const neu = bind(scope, s.name.path[0], rng, used, count);
        inner.set(s.name.path[0], neu);
        params = s.params.map((p) => bind(inner, p, rng, used, count));
        name = { path: [neu], method: null };
      } else if (s.name.method) {
        const selfName = bind(inner, "self", rng, used, count);
        params = [selfName, ...s.params.map((p) => bind(inner, p, rng, used, count))];
        name = { path: [...path, s.name.method], method: null };
      } else {
        params = s.params.map((p) => bind(inner, p, rng, used, count));
        name = { path, method: null };
      }
      return { ...s, name, params, body: renameBlock(s.body, inner, rng, used, count) };
    }
    case "return":
      return { ...s, values: s.values.map((e) => renameExpr(e, scope, rng, used, count)) };
    default:
      return s;
  }
}

function renameExpr(
  e: Expr,
  scope: Map<string, string>,
  rng: Rng,
  used: Set<string>,
  count: { n: number },
): Expr {
  switch (e.type) {
    case "name":
      return { type: "name", name: scope.get(e.name) ?? e.name };
    case "function": {
      const inner = child(scope);
      const params = e.params.map((p) => bind(inner, p, rng, used, count));
      return { ...e, params, body: renameBlock(e.body, inner, rng, used, count) };
    }
    case "unary":
      return { ...e, arg: renameExpr(e.arg, scope, rng, used, count) };
    case "binary":
      return {
        ...e,
        left: renameExpr(e.left, scope, rng, used, count),
        right: renameExpr(e.right, scope, rng, used, count),
      };
    case "index":
      return {
        ...e,
        object: renameExpr(e.object, scope, rng, used, count),
        index: renameExpr(e.index, scope, rng, used, count),
      };
    case "paren":
      return { ...e, expr: renameExpr(e.expr, scope, rng, used, count) };
    case "call":
      return {
        ...e,
        callee: renameExpr(e.callee, scope, rng, used, count),
        args: e.args.map((a) => renameExpr(a, scope, rng, used, count)),
      };
    case "table":
      return {
        ...e,
        fields: e.fields.map((f) => ({
          key: f.key ? renameExpr(f.key, scope, rng, used, count) : null,
          value: renameExpr(f.value, scope, rng, used, count),
        })),
      };
    case "prot":
      return { ...e, key: e.key ? renameExpr(e.key, scope, rng, used, count) : null };
    case "vmclosure":
      return { ...e, key: e.key ? renameExpr(e.key, scope, rng, used, count) : null };
    default:
      return e;
  }
}

export function collectNames(node: Stmt | Expr, into: Set<string>): void {
  if ("body" in node && node.type === "function" && "local" in node) {
    node.name.path.forEach((n) => into.add(n));
    if (node.name.method) into.add(node.name.method);
    node.params.forEach((n) => into.add(n));
    node.body.forEach((s) => collectNames(s, into));
    return;
  }
  if (node.type === "name") into.add(node.name);
  if (node.type === "local") node.names.forEach((n) => into.add(n));
  if (node.type === "function" && !("local" in node)) {
    node.params.forEach((n) => into.add(n));
    node.body.forEach((s) => collectNames(s, into));
    return;
  }
  if (node.type === "numericfor") into.add(node.name);
  if (node.type === "genericfor") node.names.forEach((n) => into.add(n));
  const stmts = childStmtList(node);
  stmts.forEach((s) => collectNames(s, into));
  childExprList(node).forEach((e) => collectNames(e, into));
}

function childStmtList(node: Stmt | Expr): Stmt[] {
  switch (node.type) {
    case "do":
    case "while":
    case "repeat":
    case "function":
      return "body" in node ? node.body : [];
    case "if":
      return [...node.arms.flatMap((a) => a.body), ...(node.elseBody ?? [])];
    case "numericfor":
    case "genericfor":
      return node.body;
    default:
      return [];
  }
}

function childExprList(node: Stmt | Expr): Expr[] {
  switch (node.type) {
    case "local":
      return node.inits;
    case "assign":
      return [...node.targets, ...node.values];
    case "compound":
      return [node.target, node.value];
    case "call":
      return "expr" in node ? [node.expr] : [node.callee, ...node.args];
    case "while":
    case "repeat":
      return [node.cond];
    case "if":
      return node.arms.map((a) => a.cond);
    case "numericfor":
      return node.step ? [node.start, node.stop, node.step] : [node.start, node.stop];
    case "genericfor":
      return node.iters;
    case "return":
      return node.values;
    case "unary":
      return [node.arg];
    case "binary":
      return [node.left, node.right];
    case "index":
      return [node.object, node.index];
    case "paren":
      return [node.expr];
    case "table":
      return node.fields.flatMap((f) => (f.key ? [f.key, f.value] : [f.value]));
    case "prot":
      return node.key ? [node.key] : [];
    case "vmclosure":
      return node.key ? [node.key] : [];
    default:
      return [];
  }
}
