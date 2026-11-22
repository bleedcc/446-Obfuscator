import type { Expr, Stmt } from "./ast.ts";
import { TransformError } from "./ast.ts";
import { checksumString } from "./codec.ts";

const STR = new Set(["LPH_ENCSTR", "LPH_STRENC"]);
const NUM = new Set(["LPH_ENCNUM", "LPH_NUMENC"]);
const FUNC = new Set(["LPH_ENCFUNC", "LPH_FUNCENC"]);
const JIT = new Set(["LPH_JIT", "LPH_JIT_MAX"]);
const NOVIRT = new Set(["LPH_NO_VIRTUALIZE"]);
const NOUP = new Set(["LPH_NO_UPVALUES"]);
const CRASH = new Set(["LPH_CRASH"]);

export interface MacroReport {
  body: Stmt[];
  applied: string[];
  warnings: string[];
}

export function applyMacros(body: Stmt[]): MacroReport {
  const applied: string[] = [];
  const warnings: string[] = [];
  const stripped = body.flatMap((s) => {
    if (isStub(s)) {
      applied.push("lph-stub-removed");
      warnings.push(
        "Removed the unobfuscated LPH_* compatibility stub. Generated macros do not use getrenv.",
      );
      return [];
    }
    return [s];
  });
  const next = stripped.map((s) => txStmt(s, applied));
  next.unshift({
    type: "local",
    names: ["LPH_OBFUSCATED"],
    inits: [{ type: "boolean", value: true }],
  });
  applied.push("LPH_OBFUSCATED");
  return { body: next, applied, warnings };
}

function isStub(s: Stmt): boolean {
  if (s.type !== "if" || s.arms.length !== 1 || s.elseBody) return false;
  if (!isObfCond(s.arms[0].cond)) return false;
  return s.arms[0].body.every(isStubStmt);
}

function isObfCond(e: Expr): boolean {
  if (e.type === "binary" && e.op === "==" && e.right.type === "nil" && isName(e.left, "LPH_OBFUSCATED")) {
    return true;
  }
  if (e.type === "unary" && e.op === "not" && isName(e.arg, "LPH_OBFUSCATED")) return true;
  return false;
}

function isStubStmt(s: Stmt): boolean {
  if (s.type === "empty" || s.type === "local" || s.type === "do") return true;
  if (s.type === "assign") {
    return s.targets.every((t) => t.type === "name" && t.name.startsWith("LPH_"));
  }
  if (s.type === "function" && s.name.path.length === 1 && s.name.path[0].startsWith("LPH_") && !s.name.method) {
    return true;
  }
  return false;
}

function isName(e: Expr, name: string): boolean {
  return e.type === "name" && e.name === name;
}

function txStmt(s: Stmt, applied: string[]): Stmt {
  switch (s.type) {
    case "local":
      return { ...s, inits: s.inits.map((e) => txExpr(e, applied)) };
    case "assign":
      return {
        ...s,
        targets: s.targets.map((e) => txExpr(e, applied)),
        values: s.values.map((e) => txExpr(e, applied)),
      };
    case "compound":
      return { ...s, target: txExpr(s.target, applied), value: txExpr(s.value, applied) };
    case "call": {
      const expr = txExpr(s.expr, applied);
      if (expr.type === "call") return { type: "call", expr };
      return { type: "do", body: [{ type: "return", values: [expr] }] };
    }
    case "do":
      return { ...s, body: s.body.map((x) => txStmt(x, applied)) };
    case "while":
      return { ...s, cond: txExpr(s.cond, applied), body: s.body.map((x) => txStmt(x, applied)) };
    case "repeat":
      return { ...s, body: s.body.map((x) => txStmt(x, applied)), cond: txExpr(s.cond, applied) };
    case "if":
      return {
        ...s,
        arms: s.arms.map((a) => ({ cond: txExpr(a.cond, applied), body: a.body.map((x) => txStmt(x, applied)) })),
        elseBody: s.elseBody ? s.elseBody.map((x) => txStmt(x, applied)) : null,
      };
    case "numericfor":
      return {
        ...s,
        start: txExpr(s.start, applied),
        stop: txExpr(s.stop, applied),
        step: s.step ? txExpr(s.step, applied) : null,
        body: s.body.map((x) => txStmt(x, applied)),
      };
    case "genericfor":
      return { ...s, iters: s.iters.map((e) => txExpr(e, applied)), body: s.body.map((x) => txStmt(x, applied)) };
    case "function":
      return { ...s, body: s.body.map((x) => txStmt(x, applied)) };
    case "return":
      return { ...s, values: s.values.map((e) => txExpr(e, applied)) };
    default:
      return s;
  }
}

function txExpr(e: Expr, applied: string[]): Expr {
  switch (e.type) {
    case "unary":
      return { ...e, arg: txExpr(e.arg, applied) };
    case "binary":
      return { ...e, left: txExpr(e.left, applied), right: txExpr(e.right, applied) };
    case "index":
      return { ...e, object: txExpr(e.object, applied), index: txExpr(e.index, applied) };
    case "paren":
      return { ...e, expr: txExpr(e.expr, applied) };
    case "table":
      return {
        ...e,
        fields: e.fields.map((f) => ({
          key: f.key ? txExpr(f.key, applied) : null,
          value: txExpr(f.value, applied),
        })),
      };
    case "function":
      return { ...e, body: e.body.map((s) => txStmt(s, applied)) };
    case "call":
      return txCall({ ...e, callee: txExpr(e.callee, applied), args: e.args.map((a) => txExpr(a, applied)) }, applied);
    default:
      return e;
  }
}

function txCall(e: Extract<Expr, { type: "call" }>, applied: string[]): Expr {
  if (e.callee.type !== "name" || e.method) return e;
  const name = e.callee.name;
  if (STR.has(name)) {
    if (e.args.length !== 1 || e.args[0].type !== "string") {
      throw new TransformError(`${name} only accepts a single constant string as an argument.`);
    }
    applied.push(name);
    return { ...e.args[0], force: true };
  }
  if (NUM.has(name)) {
    if (e.args.length !== 1 || e.args[0].type !== "number") {
      throw new TransformError(`${name} only accepts a single constant number as an argument.`);
    }
    applied.push(name);
    return { ...e.args[0], force: true };
  }
  if (JIT.has(name) || NOVIRT.has(name)) {
    if (e.args.length !== 1 || e.args[0].type !== "function") {
      throw new TransformError(`${name} only accepts a single constant function as an argument.`);
    }
    applied.push(name);
    const fn = e.args[0];
    return {
      ...fn,
      flags: {
        ...fn.flags,
        noVirtualize: true,
        jit: JIT.has(name) ? true : fn.flags?.jit,
      },
    };
  }
  if (FUNC.has(name)) {
    if (e.args.length !== 3 || e.args[0].type !== "function" || e.args[1].type !== "string") {
      throw new TransformError(
        `${name} accepts a constant function, a constant string key, and a runtime string expression.`,
      );
    }
    applied.push(name);
    const fn: Expr = {
      ...e.args[0],
      flags: { ...e.args[0].flags, encKey: e.args[1].value },
    };
    return keyGate(fn, e.args[2], checksumString(e.args[1].value));
  }
  if (NOUP.has(name)) {
    if (e.args.length !== 1 || e.args[0].type !== "function") {
      throw new TransformError(`${name} only accepts a single constant function as an argument.`);
    }
    applied.push(name);
    return noUpvalues(e.args[0]);
  }
  if (CRASH.has(name)) {
    applied.push(name);
    return {
      type: "call",
      callee: { type: "name", name: "__DF_CRASH" },
      args: [],
      method: null,
    };
  }
  return e;
}

function keyGate(fn: Expr, decKey: Expr, expect: number): Expr {
  const body: Stmt[] = [
    {
      type: "if",
      arms: [
        {
          cond: {
            type: "binary",
            op: "~=",
            left: {
              type: "call",
              callee: { type: "name", name: "__DF_KSUM" },
              args: [{ type: "name", name: "_dfk" }],
              method: null,
            },
            right: { type: "number", value: expect, raw: String(expect), force: true },
          },
          body: [
            {
              type: "call",
              expr: {
                type: "call",
                callee: { type: "name", name: "__DF_CRASH" },
                args: [],
                method: null,
              },
            },
          ],
        },
      ],
      elseBody: null,
    },
    { type: "return", values: [fn] },
  ];
  return {
    type: "call",
    callee: {
      type: "function",
      params: ["_dfk"],
      vararg: false,
      body,
      flags: { locked: true, noVirtualize: true },
    },
    args: [decKey],
    method: null,
  };
}

function noUpvalues(fn: Extract<Expr, { type: "function" }>): Expr {
  const trampoline: Extract<Expr, { type: "function" }> = {
    type: "function",
    params: [],
    vararg: true,
    flags: { locked: true, noVirtualize: true },
    body: [
      {
        type: "return",
        values: [
          {
            type: "call",
            callee: { type: "name", name: "func" },
            args: [{ type: "vararg" }],
            method: null,
          },
        ],
      },
    ],
  };
  const envTable: Expr = {
    type: "call",
    callee: { type: "name", name: "setmetatable" },
    method: null,
    args: [
      {
        type: "table",
        fields: [{ key: { type: "string", value: "func" }, value: { type: "name", name: "_dff" } }],
      },
      {
        type: "table",
        fields: [
          {
            key: { type: "string", value: "__index" },
            value: { type: "name", name: "_dfe" },
          },
          {
            key: { type: "string", value: "__newindex" },
            value: { type: "name", name: "_dfe" },
          },
        ],
      },
    ],
  };
  const outerBody: Stmt[] = [
    {
      type: "local",
      names: ["_dfe"],
      inits: [
        {
          type: "call",
          callee: { type: "name", name: "getfenv" },
          args: [{ type: "name", name: "_dff" }],
          method: null,
        },
      ],
    },
    {
      type: "return",
      values: [
        {
          type: "call",
          callee: { type: "name", name: "setfenv" },
          args: [trampoline, envTable],
          method: null,
        },
      ],
    },
  ];
  return {
    type: "call",
    callee: {
      type: "function",
      params: ["_dff"],
      vararg: false,
      body: outerBody,
      flags: { locked: true, noVirtualize: true },
    },
    args: [fn],
    method: null,
  };
}
