import type { Expr, FnFlags, Stmt } from "./ast.ts";
import { containsFunction } from "./ast.ts";
import { freshIdent, type Rng } from "./rng.ts";

interface Ctx {
  level: number;
  rng: Rng;
  used: Set<string>;
  breakFlag: string | null;
  flattened: { n: number };
}

export function applyControlFlow(
  body: Stmt[],
  level: number,
  rng: Rng,
  used: Set<string>,
): { body: Stmt[]; flattened: number } {
  const ctx: Ctx = { level, rng, used, breakFlag: null, flattened: { n: 0 } };
  return { body: flattenBlock(body, ctx), flattened: ctx.flattened.n };
}

function flattenBlock(stmts: Stmt[], ctx: Ctx): Stmt[] {
  const mapped = stmts.map((s) => flattenStmt(s, ctx));
  if (ctx.level <= 0) return mapped;
  return pack(mapped, ctx);
}

function fnLevel(flags: FnFlags | undefined, level: number): number {
  if (flags?.locked) return 0;
  if (flags?.jit) return Math.min(level, 1);
  return level;
}

function flattenStmt(s: Stmt, ctx: Ctx): Stmt {
  switch (s.type) {
    case "if": {
      const arms = s.arms.map((a) => ({
        cond: mapFns(a.cond, ctx),
        body: flattenBlock(a.body, ctx),
      }));
      const elseBody = s.elseBody ? flattenBlock(s.elseBody, ctx) : null;
      const built: Stmt = { type: "if", arms, elseBody };
      if (ctx.level >= 2) return ifToStates(built, ctx);
      return built;
    }
    case "while":
      return flattenWhile({ ...s, cond: mapFns(s.cond, ctx) }, ctx);
    case "do":
      return { type: "do", body: flattenBlock(s.body, { ...ctx, breakFlag: null }) };
    case "function": {
      const level = fnLevel(s.flags, ctx.level);
      return { ...s, body: flattenBlock(s.body, { ...ctx, level, breakFlag: null }) };
    }
    case "local":
      return { ...s, inits: s.inits.map((e) => mapFns(e, ctx)) };
    case "assign":
      return {
        ...s,
        targets: s.targets.map((e) => mapFns(e, ctx)),
        values: s.values.map((e) => mapFns(e, ctx)),
      };
    case "return":
      return { ...s, values: s.values.map((e) => mapFns(e, ctx)) };
    case "call":
      return { ...s, expr: mapFns(s.expr, ctx) as Extract<Expr, { type: "call" }> };
    default:
      return s;
  }
}

function mapFns(e: Expr, ctx: Ctx): Expr {
  switch (e.type) {
    case "function": {
      const level = fnLevel(e.flags, ctx.level);
      return { ...e, body: flattenBlock(e.body, { ...ctx, level, breakFlag: null }) };
    }
    case "unary":
      return { ...e, arg: mapFns(e.arg, ctx) };
    case "binary":
      return { ...e, left: mapFns(e.left, ctx), right: mapFns(e.right, ctx) };
    case "index":
      return { ...e, object: mapFns(e.object, ctx), index: mapFns(e.index, ctx) };
    case "paren":
      return { ...e, expr: mapFns(e.expr, ctx) };
    case "call":
      return { ...e, callee: mapFns(e.callee, ctx), args: e.args.map((a) => mapFns(a, ctx)) };
    case "table":
      return {
        ...e,
        fields: e.fields.map((f) => ({
          key: f.key ? mapFns(f.key, ctx) : null,
          value: mapFns(f.value, ctx),
        })),
      };
    case "prot":
      return { ...e, key: e.key ? mapFns(e.key, ctx) : null };
    default:
      return e;
  }
}

function flattenWhile(s: Extract<Stmt, { type: "while" }>, ctx: Ctx): Stmt {
  const needs = hasBreak(s.body);
  const flag = needs ? freshIdent(ctx.rng, ctx.used) : null;
  const body = flattenBlock(s.body, { ...ctx, breakFlag: flag });
  const tail: Stmt[] = flag
    ? [
        {
          type: "if",
          arms: [{ cond: { type: "name", name: flag }, body: [{ type: "break" }] }],
          elseBody: null,
        },
      ]
    : [];
  const loop: Stmt = { type: "while", cond: s.cond, body: [...body, ...tail] };
  if (!flag) return loop;
  return {
    type: "do",
    body: [{ type: "local", names: [flag], inits: [{ type: "boolean", value: false }] }, loop],
  };
}

function hasBreak(stmts: Stmt[]): boolean {
  for (const s of stmts) {
    if (s.type === "break") return true;
    if (s.type === "if") {
      if (s.arms.some((a) => hasBreak(a.body)) || (s.elseBody ? hasBreak(s.elseBody) : false)) return true;
    } else if (s.type === "do" && hasBreak(s.body)) return true;
  }
  return false;
}

function isSimple(s: Stmt): boolean {
  if (
    s.type === "break" ||
    s.type === "return" ||
    s.type === "call" ||
    s.type === "assign" ||
    s.type === "local" ||
    s.type === "empty"
  ) {
    return !containsFunction(s);
  }
  return false;
}

function pack(stmts: Stmt[], ctx: Ctx): Stmt[] {
  const out: Stmt[] = [];
  let buf: Stmt[] = [];
  const flush = () => {
    if (buf.length >= 2) {
      const dispatched = dispatch(buf, ctx);
      if (dispatched) {
        out.push(...dispatched);
        ctx.flattened.n++;
      } else out.push(...buf);
    } else out.push(...buf);
    buf = [];
  };
  for (const s of stmts) {
    if (isSimple(s)) buf.push(s);
    else {
      flush();
      out.push(s);
    }
  }
  flush();
  return out;
}

function freshId(rng: Rng, used: Set<number>): number {
  for (let i = 0; i < 10000; i++) {
    const id = 100000 + rng.int(900000);
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error("state id space exhausted");
}

function dispatch(stepsIn: Stmt[], ctx: Ctx): Stmt[] | null {
  if (stepsIn.some((s) => s.type === "break") && !ctx.breakFlag) return null;
  const locals: string[] = [];
  const steps: Stmt[] = [];
  for (const s of stepsIn) {
    if (s.type === "local") {
      locals.push(...s.names);
      if (s.inits.length) {
        steps.push({
          type: "assign",
          targets: s.names.map((n) => ({ type: "name", name: n })),
          values: s.inits,
        });
      }
    } else steps.push(s);
  }
  const real = steps.filter((s) => s.type !== "empty");
  if (real.length < 2) return null;
  const idsUsed = new Set<number>();
  const ids = real.map(() => freshId(ctx.rng, idsUsed));
  const exitId = freshId(ctx.rng, idsUsed);
  const st = freshIdent(ctx.rng, ctx.used);
  const nx = freshIdent(ctx.rng, ctx.used);
  const num = (n: number): Expr => ({ type: "number", value: n, raw: String(n) });
  const arms: { cond: Expr; body: Stmt[] }[] = [];
  for (let i = 0; i < real.length; i++) {
    const step = real[i];
    const body: Stmt[] = [];
    if (step.type === "break") {
      body.push({
        type: "assign",
        targets: [{ type: "name", name: ctx.breakFlag! }],
        values: [{ type: "boolean", value: true }],
      });
      body.push({ type: "assign", targets: [{ type: "name", name: st }], values: [num(exitId)] });
    } else if (step.type === "return") {
      body.push(step);
    } else {
      body.push(step);
      const next = i + 1 < real.length ? ids[i + 1] : exitId;
      const value: Expr =
        ctx.level >= 2 && next !== exitId
          ? { type: "index", object: { type: "name", name: nx }, index: num(ids[i]) }
          : num(next);
      body.push({ type: "assign", targets: [{ type: "name", name: st }], values: [value] });
    }
    arms.push({
      cond: { type: "binary", op: "==", left: { type: "name", name: st }, right: num(ids[i]) },
      body,
    });
  }
  const decls: Stmt[] = [];
  if (locals.length) decls.push({ type: "local", names: locals, inits: [] });
  decls.push({ type: "local", names: [st], inits: [num(ids[0])] });
  if (ctx.level >= 2) {
    const fields = [];
    for (let i = 0; i < real.length - 1; i++) {
      if (real[i].type === "return" || real[i].type === "break") continue;
      fields.push({ key: num(ids[i]), value: num(ids[i + 1]) });
    }
    decls.push({ type: "local", names: [nx], inits: [{ type: "table", fields }] });
  }
  const loopBody: Stmt[] = [];
  if (ctx.level >= 3) {
    loopBody.push({
      type: "if",
      arms: [
        {
          cond: {
            type: "binary",
            op: "~=",
            left: { type: "name", name: st },
            right: { type: "name", name: st },
          },
          body: [{ type: "assign", targets: [{ type: "name", name: st }], values: [num(exitId)] }],
        },
      ],
      elseBody: null,
    });
  }
  const cond: Expr =
    ctx.level >= 2
      ? { type: "binary", op: "~=", left: { type: "name", name: st }, right: num(exitId) }
      : { type: "boolean", value: true };
  if (ctx.level < 2) loopBody.push({ type: "if", arms, elseBody: [{ type: "break" }] });
  else {
    loopBody.push({
      type: "if",
      arms,
      elseBody: [{ type: "assign", targets: [{ type: "name", name: st }], values: [num(exitId)] }],
    });
  }
  decls.push({ type: "while", cond, body: loopBody });
  return decls;
}

function ifToStates(s: Extract<Stmt, { type: "if" }>, ctx: Ctx): Stmt {
  const slots: Stmt[][] = [...s.arms.map((a) => a.body), ...(s.elseBody ? [s.elseBody] : [])];
  const idsUsed = new Set<number>();
  const ids = slots.map(() => freshId(ctx.rng, idsUsed));
  const exitId = freshId(ctx.rng, idsUsed);
  const st = freshIdent(ctx.rng, ctx.used);
  const num = (n: number): Expr => ({ type: "number", value: n, raw: String(n) });
  const setSt = (id: number): Stmt => ({
    type: "assign",
    targets: [{ type: "name", name: st }],
    values: [num(id)],
  });
  const selArms = s.arms.map((arm, i) => ({ cond: arm.cond, body: [setSt(ids[i])] }));
  const selElse: Stmt[] = s.elseBody ? [setSt(ids[ids.length - 1])] : [setSt(exitId)];
  const exitAssign = setSt(exitId);
  const dispArms = slots.map((body, i) => {
    const rewritten = ctx.breakFlag ? rewriteBreaks(body, ctx.breakFlag, exitAssign) : body;
    return {
      cond: { type: "binary", op: "==", left: { type: "name", name: st }, right: num(ids[i]) } as Expr,
      body: [...rewritten, setSt(exitId)],
    };
  });
  return {
    type: "do",
    body: [
      { type: "local", names: [st], inits: [num(0)] },
      { type: "if", arms: selArms, elseBody: selElse },
      {
        type: "while",
        cond: { type: "binary", op: "~=", left: { type: "name", name: st }, right: num(exitId) },
        body: [{ type: "if", arms: dispArms, elseBody: [setSt(exitId)] }],
      },
    ],
  };
}

function rewriteBreaks(stmts: Stmt[], flag: string, exitStmt: Stmt): Stmt[] {
  const out: Stmt[] = [];
  for (const s of stmts) {
    if (s.type === "break") {
      out.push({
        type: "assign",
        targets: [{ type: "name", name: flag }],
        values: [{ type: "boolean", value: true }],
      });
      out.push(exitStmt);
      continue;
    }
    if (s.type === "if") {
      out.push({
        ...s,
        arms: s.arms.map((a) => ({ ...a, body: rewriteBreaks(a.body, flag, exitStmt) })),
        elseBody: s.elseBody ? rewriteBreaks(s.elseBody, flag, exitStmt) : null,
      });
      continue;
    }
    if (s.type === "do") {
      out.push({ ...s, body: rewriteBreaks(s.body, flag, exitStmt) });
      continue;
    }
    out.push(s);
  }
  return out;
}
