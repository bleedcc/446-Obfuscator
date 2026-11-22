export interface FnFlags {
  locked?: boolean;
  noVirtualize?: boolean;
  jit?: boolean;
  /** LPH_ENCFUNC constant key. Literals inside are bound to this key. */
  encKey?: string;
}

export type Field = { key: Expr | null; value: Expr };

export type FuncName = { path: string[]; method: string | null };

export type Expr =
  | { type: "nil" }
  | { type: "boolean"; value: boolean }
  | { type: "number"; value: number; raw: string; force?: boolean }
  | { type: "string"; value: string; force?: boolean }
  | { type: "vararg" }
  | { type: "name"; name: string }
  | { type: "unary"; op: string; arg: Expr }
  | { type: "binary"; op: string; left: Expr; right: Expr }
  | { type: "index"; object: Expr; index: Expr }
  | { type: "call"; callee: Expr; args: Expr[]; method: string | null }
  | {
      type: "function";
      params: string[];
      vararg: boolean;
      body: Stmt[];
      flags?: FnFlags;
    }
  | { type: "table"; fields: Field[] }
  | { type: "paren"; expr: Expr }
  | { type: "prot"; pool: "s" | "n"; index: number; key: Expr | null }
  | { type: "vmclosure"; proto: number; key: Expr | null };

export type Stmt =
  | { type: "empty" }
  | { type: "local"; names: string[]; inits: Expr[] }
  | { type: "assign"; targets: Expr[]; values: Expr[] }
  | { type: "compound"; op: string; target: Expr; value: Expr }
  | { type: "call"; expr: Extract<Expr, { type: "call" }> }
  | { type: "break" }
  | { type: "continue" }
  | { type: "do"; body: Stmt[] }
  | { type: "while"; cond: Expr; body: Stmt[] }
  | { type: "repeat"; cond: Expr; body: Stmt[] }
  | { type: "if"; arms: { cond: Expr; body: Stmt[] }[]; elseBody: Stmt[] | null }
  | {
      type: "numericfor";
      name: string;
      start: Expr;
      stop: Expr;
      step: Expr | null;
      body: Stmt[];
    }
  | { type: "genericfor"; names: string[]; iters: Expr[]; body: Stmt[] }
  | {
      type: "function";
      local: boolean;
      name: FuncName;
      params: string[];
      vararg: boolean;
      body: Stmt[];
      flags?: FnFlags;
    }
  | { type: "return"; values: Expr[] };

export interface Chunk {
  body: Stmt[];
}

export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransformError";
  }
}

export function nameExpr(name: string): Expr {
  return { type: "name", name };
}

export function containsFunction(node: Stmt | Expr): boolean {
  let found = false;
  walk(node, () => {
    /* visit via map */
  });
  const scan = (n: Stmt | Expr): void => {
    if (found) return;
    if (n.type === "function") {
      found = true;
      return;
    }
    if (isStmt(n)) {
      for (const s of childStmts(n)) scan(s);
      for (const e of childExprsStmt(n)) scan(e);
    } else {
      for (const e of childExprs(n)) scan(e);
    }
  };
  scan(node);
  return found;
}

function isStmt(n: Stmt | Expr): n is Stmt {
  return (
    n.type === "empty" ||
    n.type === "local" ||
    n.type === "assign" ||
    n.type === "compound" ||
    n.type === "break" ||
    n.type === "continue" ||
    n.type === "do" ||
    n.type === "while" ||
    n.type === "repeat" ||
    n.type === "if" ||
    n.type === "numericfor" ||
    n.type === "genericfor" ||
    n.type === "return" ||
    (n.type === "call" && "expr" in n) ||
    (n.type === "function" && "local" in n)
  );
}

function childStmts(s: Stmt): Stmt[] {
  switch (s.type) {
    case "do":
    case "while":
    case "repeat":
      return s.body;
    case "if":
      return [...s.arms.flatMap((a) => a.body), ...(s.elseBody ?? [])];
    case "numericfor":
    case "genericfor":
      return s.body;
    case "function":
      return s.body;
    default:
      return [];
  }
}

function childExprsStmt(s: Stmt): Expr[] {
  switch (s.type) {
    case "local":
      return s.inits;
    case "assign":
      return [...s.targets, ...s.values];
    case "compound":
      return [s.target, s.value];
    case "call":
      return [s.expr];
    case "while":
    case "repeat":
      return [s.cond];
    case "if":
      return s.arms.map((a) => a.cond);
    case "numericfor":
      return s.step ? [s.start, s.stop, s.step] : [s.start, s.stop];
    case "genericfor":
      return s.iters;
    case "return":
      return s.values;
    default:
      return [];
  }
}

function childExprs(e: Expr): Expr[] {
  switch (e.type) {
    case "unary":
      return [e.arg];
    case "binary":
      return [e.left, e.right];
    case "index":
      return [e.object, e.index];
    case "call":
      return [e.callee, ...e.args];
    case "function":
      return [];
    case "table":
      return e.fields.flatMap((f) => (f.key ? [f.key, f.value] : [f.value]));
    case "paren":
      return [e.expr];
    case "prot":
      return e.key ? [e.key] : [];
    case "vmclosure":
      return e.key ? [e.key] : [];
    default:
      return [];
  }
}

export function walk(node: Stmt | Expr, _fn: (n: Stmt | Expr) => void): void {
  _fn(node);
}

export function mapExpr(e: Expr, fn: (e: Expr) => Expr | null): Expr {
  const hit = fn(e);
  if (hit) return hit;
  switch (e.type) {
    case "unary":
      return { ...e, arg: mapExpr(e.arg, fn) };
    case "binary":
      return { ...e, left: mapExpr(e.left, fn), right: mapExpr(e.right, fn) };
    case "index":
      return { ...e, object: mapExpr(e.object, fn), index: mapExpr(e.index, fn) };
    case "call":
      return {
        ...e,
        callee: mapExpr(e.callee, fn),
        args: e.args.map((a) => mapExpr(a, fn)),
      };
    case "function":
      return { ...e, body: mapStmts(e.body, fn) };
    case "table":
      return {
        ...e,
        fields: e.fields.map((f) => ({
          key: f.key ? mapExpr(f.key, fn) : null,
          value: mapExpr(f.value, fn),
        })),
      };
    case "paren":
      return { ...e, expr: mapExpr(e.expr, fn) };
    case "prot":
      return { ...e, key: e.key ? mapExpr(e.key, fn) : null };
    case "vmclosure":
      return { ...e, key: e.key ? mapExpr(e.key, fn) : null };
    default:
      return e;
  }
}

export function mapStmts(stmts: Stmt[], fn: (e: Expr) => Expr | null): Stmt[] {
  return stmts.map((s) => mapStmt(s, fn));
}

export function mapStmt(s: Stmt, fn: (e: Expr) => Expr | null): Stmt {
  switch (s.type) {
    case "local":
      return { ...s, inits: s.inits.map((e) => mapExpr(e, fn)) };
    case "assign":
      return {
        ...s,
        targets: s.targets.map((e) => mapExpr(e, fn)),
        values: s.values.map((e) => mapExpr(e, fn)),
      };
    case "compound":
      return { ...s, target: mapExpr(s.target, fn), value: mapExpr(s.value, fn) };
    case "call":
      return { ...s, expr: mapExpr(s.expr, fn) as Extract<Expr, { type: "call" }> };
    case "do":
      return { ...s, body: mapStmts(s.body, fn) };
    case "while":
      return { ...s, cond: mapExpr(s.cond, fn), body: mapStmts(s.body, fn) };
    case "repeat":
      return { ...s, body: mapStmts(s.body, fn), cond: mapExpr(s.cond, fn) };
    case "if":
      return {
        ...s,
        arms: s.arms.map((a) => ({ cond: mapExpr(a.cond, fn), body: mapStmts(a.body, fn) })),
        elseBody: s.elseBody ? mapStmts(s.elseBody, fn) : null,
      };
    case "numericfor":
      return {
        ...s,
        start: mapExpr(s.start, fn),
        stop: mapExpr(s.stop, fn),
        step: s.step ? mapExpr(s.step, fn) : null,
        body: mapStmts(s.body, fn),
      };
    case "genericfor":
      return { ...s, iters: s.iters.map((e) => mapExpr(e, fn)), body: mapStmts(s.body, fn) };
    case "function":
      return { ...s, body: mapStmts(s.body, fn) };
    case "return":
      return { ...s, values: s.values.map((e) => mapExpr(e, fn)) };
    default:
      return s;
  }
}

export function mapFunctionExprs(e: Expr, fn: (fnExpr: Extract<Expr, { type: "function" }>) => Expr): Expr {
  return mapExpr(e, (node) => {
    if (node.type !== "function") return null;
    const replaced = fn(node);
    if (replaced.type !== "function") return replaced;
    return { ...replaced, body: mapStmts(replaced.body, (inner) => {
      const next = mapFunctionExprs(inner, fn);
      return next === inner ? null : next;
    }) };
  });
}
