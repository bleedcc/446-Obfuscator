import type { Expr, Stmt } from "./ast.ts";
import { mapExpr } from "./ast.ts";

let tempSeq = 0;

function tmp(prefix: string): string {
  tempSeq += 1;
  return `__dfd_${prefix}_${tempSeq}`;
}

export function resetTemps(): void {
  tempSeq = 0;
}

export function desugar(body: Stmt[]): Stmt[] {
  resetTemps();
  const lowered = lowerContinue(body.map(desugarStmt).flat());
  return stripRepeat(lowered);
}

function desugarStmt(s: Stmt): Stmt[] {
  switch (s.type) {
    case "compound":
      return desugarCompound(s);
    case "numericfor":
      return [desugarNumeric(s)];
    case "genericfor":
      return [desugarGeneric(s)];
    case "repeat": {
      const body = s.body.map(desugarStmt).flat();
      return [
        {
          type: "while",
          cond: { type: "boolean", value: true },
          body: [
            ...body,
            {
              type: "if",
              arms: [{ cond: desugarExpr(s.cond), body: [{ type: "break" }] }],
              elseBody: null,
            },
          ],
        },
      ];
    }
    case "do":
      return [{ type: "do", body: s.body.map(desugarStmt).flat() }];
    case "while":
      return [{ type: "while", cond: desugarExpr(s.cond), body: s.body.map(desugarStmt).flat() }];
    case "if":
      return [
        {
          type: "if",
          arms: s.arms.map((a) => ({
            cond: desugarExpr(a.cond),
            body: a.body.map(desugarStmt).flat(),
          })),
          elseBody: s.elseBody ? s.elseBody.map(desugarStmt).flat() : null,
        },
      ];
    case "function":
      return [{ ...s, body: s.body.map(desugarStmt).flat() }];
    case "local":
      return [{ ...s, inits: s.inits.map(desugarExpr) }];
    case "assign":
      return [{ ...s, targets: s.targets.map(desugarExpr), values: s.values.map(desugarExpr) }];
    case "call":
      return [{ ...s, expr: desugarExpr(s.expr) as Extract<Expr, { type: "call" }> }];
    case "return":
      return [{ ...s, values: s.values.map(desugarExpr) }];
    default:
      return [s];
  }
}

function desugarExpr(e: Expr): Expr {
  return mapExpr(e, (node) => {
    if (node.type === "function") {
      return { ...node, body: node.body.map(desugarStmt).flat() };
    }
    return null;
  });
}

function desugarCompound(s: Extract<Stmt, { type: "compound" }>): Stmt[] {
  const value = desugarExpr(s.value);
  const target = desugarExpr(s.target);
  if (target.type === "name") {
    return [
      {
        type: "assign",
        targets: [target],
        values: [{ type: "binary", op: s.op, left: target, right: value }],
      },
    ];
  }
  if (target.type === "index") {
    const t = tmp("_t");
    const k = tmp("_k");
    const v = tmp("_v");
    return [
      {
        type: "do",
        body: [
          {
            type: "local",
            names: [t, k, v],
            inits: [target.object, target.index, value],
          },
          {
            type: "assign",
            targets: [
              {
                type: "index",
                object: { type: "name", name: t },
                index: { type: "name", name: k },
              },
            ],
            values: [
              {
                type: "binary",
                op: s.op,
                left: {
                  type: "index",
                  object: { type: "name", name: t },
                  index: { type: "name", name: k },
                },
                right: { type: "name", name: v },
              },
            ],
          },
        ],
      },
    ];
  }
  return [
    {
      type: "assign",
      targets: [target],
      values: [{ type: "binary", op: s.op, left: target, right: value }],
    },
  ];
}

function desugarNumeric(s: Extract<Stmt, { type: "numericfor" }>): Stmt {
  const iName = tmp("_i");
  const limit = tmp("_lim");
  const step = tmp("_step");
  const v = s.name;
  const stepExpr: Expr = s.step
    ? {
        type: "binary",
        op: "or",
        left: desugarExpr(s.step),
        right: { type: "number", value: 1, raw: "1" },
      }
    : { type: "number", value: 1, raw: "1" };
  const cond: Expr = {
    type: "binary",
    op: "or",
    left: {
      type: "binary",
      op: "and",
      left: {
        type: "binary",
        op: ">",
        left: { type: "name", name: step },
        right: { type: "number", value: 0, raw: "0" },
      },
      right: {
        type: "binary",
        op: "<=",
        left: { type: "name", name: iName },
        right: { type: "name", name: limit },
      },
    },
    right: {
      type: "binary",
      op: "and",
      left: {
        type: "binary",
        op: "<=",
        left: { type: "name", name: step },
        right: { type: "number", value: 0, raw: "0" },
      },
      right: {
        type: "binary",
        op: ">=",
        left: { type: "name", name: iName },
        right: { type: "name", name: limit },
      },
    },
  };
  const body = s.body.map(desugarStmt).flat();
  return {
    type: "do",
    body: [
      {
        type: "local",
        names: [iName, limit, step],
        inits: [desugarExpr(s.start), desugarExpr(s.stop), stepExpr],
      },
      {
        type: "while",
        cond,
        body: [
          { type: "local", names: [v], inits: [{ type: "name", name: iName }] },
          ...body,
          {
            type: "assign",
            targets: [{ type: "name", name: iName }],
            values: [
              {
                type: "binary",
                op: "+",
                left: { type: "name", name: iName },
                right: { type: "name", name: step },
              },
            ],
          },
        ],
      },
    ],
  };
}

function desugarGeneric(s: Extract<Stmt, { type: "genericfor" }>): Stmt {
  const f = tmp("_f");
  const state = tmp("_s");
  const varName = tmp("_var");
  const temps = s.names.map(() => tmp("_g"));
  const body = s.body.map(desugarStmt).flat();
  const iterCall: Expr = {
    type: "call",
    callee: { type: "name", name: f },
    args: [
      { type: "name", name: state },
      { type: "name", name: varName },
    ],
    method: null,
  };
  return {
    type: "do",
    body: [
      {
        type: "local",
        names: [f, state, varName],
        inits: s.iters.map(desugarExpr),
      },
      {
        type: "while",
        cond: { type: "boolean", value: true },
        body: [
          { type: "local", names: temps, inits: [iterCall] },
          {
            type: "if",
            arms: [
              {
                cond: {
                  type: "binary",
                  op: "==",
                  left: { type: "name", name: temps[0] },
                  right: { type: "nil" },
                },
                body: [{ type: "break" }],
              },
            ],
            elseBody: null,
          },
          {
            type: "assign",
            targets: [{ type: "name", name: varName }],
            values: [{ type: "name", name: temps[0] }],
          },
          {
            type: "local",
            names: s.names,
            inits: temps.map((n) => ({ type: "name", name: n }) as Expr),
          },
          ...body,
        ],
      },
    ],
  };
}

function lowerContinue(stmts: Stmt[]): Stmt[] {
  return stmts.map(lowerContinueStmt);
}

function lowerContinueStmt(s: Stmt): Stmt {
  switch (s.type) {
    case "do":
      return { ...s, body: lowerContinue(s.body) };
    case "if":
      return {
        ...s,
        arms: s.arms.map((a) => ({ ...a, body: lowerContinue(a.body) })),
        elseBody: s.elseBody ? lowerContinue(s.elseBody) : null,
      };
    case "function":
      return { ...s, body: lowerContinue(s.body) };
    case "while":
      return lowerWhileContinue({ ...s, body: lowerContinue(s.body) });
    case "local":
      return { ...s, inits: s.inits.map(lowerExprContinue) };
    case "assign":
      return {
        ...s,
        targets: s.targets.map(lowerExprContinue),
        values: s.values.map(lowerExprContinue),
      };
    case "return":
      return { ...s, values: s.values.map(lowerExprContinue) };
    case "call":
      return { ...s, expr: lowerExprContinue(s.expr) as Extract<Expr, { type: "call" }> };
    default:
      return s;
  }
}

function lowerExprContinue(e: Expr): Expr {
  return mapExpr(e, (node) => {
    if (node.type !== "function") return null;
    return { ...node, body: lowerContinue(node.body) };
  });
}

function blockHasContinue(stmts: Stmt[]): boolean {
  for (const s of stmts) {
    if (s.type === "continue") return true;
    if (s.type === "if") {
      if (s.arms.some((a) => blockHasContinue(a.body))) return true;
      if (s.elseBody && blockHasContinue(s.elseBody)) return true;
    } else if (s.type === "do" && blockHasContinue(s.body)) return true;
  }
  return false;
}

function lowerWhileContinue(s: Extract<Stmt, { type: "while" }>): Stmt {
  if (!blockHasContinue(s.body)) return s;
  const flag = tmp("_brk");
  const cont = tmp("_cont");
  const rewritten = rewriteContinue(s.body, flag, cont);
  return {
    type: "do",
    body: [
      { type: "local", names: [flag], inits: [{ type: "boolean", value: false }] },
      {
        type: "while",
        cond: s.cond,
        body: [
          { type: "local", names: [cont], inits: [{ type: "boolean", value: false }] },
          {
            type: "while",
            cond: { type: "boolean", value: true },
            body: [
              ...rewritten,
              {
                type: "if",
                arms: [{ cond: { type: "boolean", value: true }, body: [{ type: "break" }] }],
                elseBody: null,
              },
            ],
          },
          {
            type: "if",
            arms: [{ cond: { type: "name", name: flag }, body: [{ type: "break" }] }],
            elseBody: null,
          },
        ],
      },
    ],
  };
}

function rewriteContinue(stmts: Stmt[], brk: string, cont: string): Stmt[] {
  return stmts.map((s) => rewriteContinueStmt(s, brk, cont));
}

function rewriteContinueStmt(s: Stmt, brk: string, cont: string): Stmt {
  if (s.type === "continue") {
    return {
      type: "do",
      body: [
        {
          type: "assign",
          targets: [{ type: "name", name: cont }],
          values: [{ type: "boolean", value: true }],
        },
        { type: "break" },
      ],
    };
  }
  if (s.type === "break") {
    return {
      type: "do",
      body: [
        {
          type: "assign",
          targets: [{ type: "name", name: brk }],
          values: [{ type: "boolean", value: true }],
        },
        { type: "break" },
      ],
    };
  }
  if (s.type === "if") {
    return {
      ...s,
      arms: s.arms.map((a) => ({ ...a, body: rewriteContinue(a.body, brk, cont) })),
      elseBody: s.elseBody ? rewriteContinue(s.elseBody, brk, cont) : null,
    };
  }
  if (s.type === "do") return { ...s, body: rewriteContinue(s.body, brk, cont) };
  return s;
}

function stripRepeat(stmts: Stmt[]): Stmt[] {
  return stmts.map(stripRepeatStmt);
}

function stripRepeatStmt(s: Stmt): Stmt {
  switch (s.type) {
    case "repeat":
      return {
        type: "while",
        cond: { type: "boolean", value: true },
        body: [
          ...stripRepeat(s.body),
          {
            type: "if",
            arms: [{ cond: s.cond, body: [{ type: "break" }] }],
            elseBody: null,
          },
        ],
      };
    case "do":
      return { ...s, body: stripRepeat(s.body) };
    case "while":
      return { ...s, cond: stripRepeatExpr(s.cond), body: stripRepeat(s.body) };
    case "if":
      return {
        ...s,
        arms: s.arms.map((a) => ({ cond: stripRepeatExpr(a.cond), body: stripRepeat(a.body) })),
        elseBody: s.elseBody ? stripRepeat(s.elseBody) : null,
      };
    case "function":
      return { ...s, body: stripRepeat(s.body) };
    case "local":
      return { ...s, inits: s.inits.map(stripRepeatExpr) };
    case "assign":
      return {
        ...s,
        targets: s.targets.map(stripRepeatExpr),
        values: s.values.map(stripRepeatExpr),
      };
    case "return":
      return { ...s, values: s.values.map(stripRepeatExpr) };
    case "call":
      return { ...s, expr: stripRepeatExpr(s.expr) as Extract<Expr, { type: "call" }> };
    default:
      return s;
  }
}

function stripRepeatExpr(e: Expr): Expr {
  return mapExpr(e, (node) => {
    if (node.type !== "function") return null;
    return { ...node, body: stripRepeat(node.body) };
  });
}
