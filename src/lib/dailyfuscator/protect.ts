import type { Expr, Stmt } from "./ast.ts";
import { canonicalNumber } from "./codec.ts";
import type { Rng } from "./rng.ts";

export interface PoolEntry {
  plain: string;
  userKey: string;
  salt: number;
}

export interface Pool {
  strings: PoolEntry[];
  numbers: PoolEntry[];
}

interface Ctx {
  strings: "off" | "standard" | "high";
  constants: "off" | "safe";
  ui: boolean;
  rng: Rng;
  pool: Pool;
  userKey: string;
  keyExpr: Expr | null;
  intern: boolean;
  warnings: string[];
  stringMap: Map<string, number>;
  numberMap: Map<string, number>;
  stats: { strings: number; numbers: number; skippedNumbers: number };
}

export function protectBody(
  body: Stmt[],
  opt: {
    strings: "off" | "standard" | "high";
    constants: "off" | "safe";
    ui: boolean;
    rng: Rng;
    pool: Pool;
  },
): { body: Stmt[]; warnings: string[]; stats: Ctx["stats"] } {
  const ctx: Ctx = {
    ...opt,
    userKey: "",
    keyExpr: null,
    intern: opt.strings !== "high",
    warnings: [],
    stringMap: new Map(),
    numberMap: new Map(),
    stats: { strings: 0, numbers: 0, skippedNumbers: 0 },
  };
  return { body: body.map((s) => protStmt(s, ctx)), warnings: ctx.warnings, stats: ctx.stats };
}

function protStmt(s: Stmt, ctx: Ctx): Stmt {
  switch (s.type) {
    case "local":
      return { ...s, inits: s.inits.map((e, i) => protExpr(e, ctx, "value")) };
    case "assign":
      return {
        ...s,
        targets: s.targets.map((e) => protTarget(e, ctx)),
        values: s.values.map((e, i) => protExpr(e, ctx, ctx.ui && isIndex(s.targets[i]) ? "uivalue" : "value")),
      };
    case "call":
      return { ...s, expr: protExpr(s.expr, ctx, "value") as Extract<Expr, { type: "call" }> };
    case "do":
      return { ...s, body: s.body.map((x) => protStmt(x, ctx)) };
    case "while":
      return { ...s, cond: protExpr(s.cond, ctx, "value"), body: s.body.map((x) => protStmt(x, ctx)) };
    case "if":
      return {
        ...s,
        arms: s.arms.map((a) => ({ cond: protExpr(a.cond, ctx, "value"), body: a.body.map((x) => protStmt(x, ctx)) })),
        elseBody: s.elseBody ? s.elseBody.map((x) => protStmt(x, ctx)) : null,
      };
    case "function": {
      const next = childCtx(ctx, s.flags?.encKey);
      return { ...s, body: s.body.map((x) => protStmt(x, next)) };
    }
    case "return":
      return { ...s, values: s.values.map((e) => protExpr(e, ctx, "value")) };
    default:
      return s;
  }
}

function childCtx(ctx: Ctx, encKey: string | undefined): Ctx {
  if (!encKey) return ctx;
  return { ...ctx, userKey: encKey, keyExpr: { type: "name", name: "_dfk" } };
}

function isIndex(e: Expr | undefined): boolean {
  return !!e && e.type === "index";
}

function protTarget(e: Expr, ctx: Ctx): Expr {
  if (e.type === "index") {
    return {
      ...e,
      object: protExpr(e.object, ctx, "value"),
      index: protExpr(e.index, ctx, "key"),
    };
  }
  return protExpr(e, ctx, "value");
}

function protExpr(e: Expr, ctx: Ctx, role: "value" | "key" | "uivalue"): Expr {
  switch (e.type) {
    case "string":
      return protectString(e, ctx, role);
    case "number":
      return protectNumber(e, ctx);
    case "function": {
      const next = childCtx(ctx, e.flags?.encKey);
      return { ...e, body: e.body.map((s) => protStmt(s, next)) };
    }
    case "unary":
      return { ...e, arg: protExpr(e.arg, ctx, "value") };
    case "binary":
      return {
        ...e,
        left: protExpr(e.left, ctx, "value"),
        right: protExpr(e.right, ctx, "value"),
      };
    case "index":
      return {
        ...e,
        object: protExpr(e.object, ctx, "value"),
        index: protExpr(e.index, ctx, "key"),
      };
    case "paren":
      return { ...e, expr: protExpr(e.expr, ctx, role) };
    case "call":
      return {
        ...e,
        callee: protExpr(e.callee, ctx, "value"),
        args: e.args.map((a) => protExpr(a, ctx, "value")),
      };
    case "table":
      return {
        ...e,
        fields: e.fields.map((f) => ({
          key: f.key ? protExpr(f.key, ctx, "key") : null,
          value: protExpr(f.value, ctx, ctx.ui ? "uivalue" : "value"),
        })),
      };
    case "prot":
      return { ...e, key: e.key ? protExpr(e.key, ctx, "value") : null };
    case "vmclosure":
      return { ...e, key: e.key ? protExpr(e.key, ctx, "value") : null };
    default:
      return e;
  }
}

function wantString(e: Extract<Expr, { type: "string" }>, ctx: Ctx, role: "value" | "key" | "uivalue"): boolean {
  if (e.force) return true;
  if (ctx.userKey) return true;
  if (ctx.strings !== "off") return true;
  if (ctx.ui && (role === "key" || role === "uivalue")) return true;
  return false;
}

function protectString(e: Extract<Expr, { type: "string" }>, ctx: Ctx, role: "value" | "key" | "uivalue"): Expr {
  if (!wantString(e, ctx, role)) return e;
  if (e.value.length >= 4) {
    let cut = 1 + ctx.rng.int(Math.min(3, e.value.length - 1));
    const prev = e.value.charCodeAt(cut - 1);
    const next = e.value.charCodeAt(cut);
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut += 1;
    if (cut <= 0 || cut >= e.value.length) cut = Math.max(1, e.value.length - 1);
    const left = protectString({ ...e, value: e.value.slice(0, cut), force: true }, ctx, role);
    const right = protectString({ ...e, value: e.value.slice(cut), force: true }, ctx, role);
    return { type: "binary", op: "..", left, right };
  }
  const index = addString(ctx, e.value);
  ctx.stats.strings++;
  return { type: "prot", pool: "s", index, key: ctx.userKey ? ctx.keyExpr : null };
}

function protectNumber(e: Extract<Expr, { type: "number" }>, ctx: Ctx): Expr {
  const enable = e.force || ctx.constants !== "off" || !!ctx.userKey;
  if (!enable) return e;
  const canon = canonicalNumber(e.value);
  if (canon == null) {
    ctx.stats.skippedNumbers++;
    ctx.warnings.push("Skipped a non-finite or non-round-trippable numeric constant.");
    return e;
  }
  const index = addNumber(ctx, canon);
  ctx.stats.numbers++;
  return { type: "prot", pool: "n", index, key: ctx.userKey ? ctx.keyExpr : null };
}

function addString(ctx: Ctx, value: string): number {
  const mapKey = `${ctx.userKey}\0${value}`;
  if (ctx.intern && ctx.stringMap.has(mapKey)) return ctx.stringMap.get(mapKey)!;
  const salt = ctx.rng.int(251);
  ctx.pool.strings.push({ plain: value, userKey: ctx.userKey, salt });
  const index = ctx.pool.strings.length;
  if (ctx.intern) ctx.stringMap.set(mapKey, index);
  return index;
}

function addNumber(ctx: Ctx, canon: string): number {
  const mapKey = `${ctx.userKey}\0${canon}`;
  if (ctx.constants !== "off" && ctx.intern && ctx.numberMap.has(mapKey)) return ctx.numberMap.get(mapKey)!;
  const salt = ctx.rng.int(251);
  ctx.pool.numbers.push({ plain: canon, userKey: ctx.userKey, salt });
  const index = ctx.pool.numbers.length;
  if (ctx.intern) ctx.numberMap.set(mapKey, index);
  return index;
}
