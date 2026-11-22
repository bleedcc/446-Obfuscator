import type { Expr, Stmt } from "./ast.ts";
import { utf8Bytes } from "./codec.ts";

const PREC: Record<string, number> = {
  or: 1,
  and: 2,
  "==": 3,
  "~=": 3,
  "<": 3,
  ">": 3,
  "<=": 3,
  ">=": 3,
  "|": 4,
  "~": 5,
  "&": 6,
  "<<": 7,
  ">>": 7,
  "..": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "//": 10,
  "%": 10,
  "^": 12,
};

const RIGHT = new Set(["..", "^"]);

export function emitChunk(body: Stmt[], compact = false): string {
  const parts = body.map((s) => emitStmt(s, 0, compact)).filter((s) => s.length > 0);
  return parts.join(compact ? " " : "\n");
}

function emitStmt(s: Stmt, indent: number, compact: boolean): string {
  const pad = compact ? "" : " ".repeat(indent);
  const nl = compact ? " " : "\n";
  const block = (stmts: Stmt[], inner: number) =>
    stmts
      .map((st) => emitStmt(st, inner, compact))
      .filter((x) => x.trim().length > 0)
      .join(nl);
  switch (s.type) {
    case "empty":
      return "";
    case "local": {
      const names = s.names.join(", ");
      if (!s.inits.length) return `${pad}local ${names}`;
      return `${pad}local ${names} = ${s.inits.map((e) => emitExpr(e, 0)).join(", ")}`;
    }
    case "assign":
      return `${pad}${s.targets.map((e) => emitExpr(e, 0)).join(", ")} = ${s.values.map((e) => emitExpr(e, 0)).join(", ")}`;
    case "compound":
      return `${pad}${emitExpr(s.target, 0)} ${s.op}= ${emitExpr(s.value, 0)}`;
    case "call":
      return `${pad}${emitExpr(s.expr, 0)}`;
    case "break":
      return `${pad}break`;
    case "continue":
      return `${pad}continue`;
    case "do":
      return `${pad}do${nl}${block(s.body, indent + 2)}${nl}${pad}end`;
    case "while":
      return `${pad}while ${emitExpr(s.cond, 0)} do${nl}${block(s.body, indent + 2)}${nl}${pad}end`;
    case "repeat":
      return `${pad}repeat${nl}${block(s.body, indent + 2)}${nl}${pad}until ${emitExpr(s.cond, 0)}`;
    case "if": {
      let out = `${pad}if ${emitExpr(s.arms[0].cond, 0)} then${nl}${block(s.arms[0].body, indent + 2)}`;
      for (let i = 1; i < s.arms.length; i++) {
        out += `${nl}${pad}elseif ${emitExpr(s.arms[i].cond, 0)} then${nl}${block(s.arms[i].body, indent + 2)}`;
      }
      if (s.elseBody) out += `${nl}${pad}else${nl}${block(s.elseBody, indent + 2)}`;
      out += `${nl}${pad}end`;
      return out;
    }
    case "numericfor": {
      const step = s.step ? `, ${emitExpr(s.step, 0)}` : "";
      return `${pad}for ${s.name} = ${emitExpr(s.start, 0)}, ${emitExpr(s.stop, 0)}${step} do${nl}${block(s.body, indent + 2)}${nl}${pad}end`;
    }
    case "genericfor":
      return `${pad}for ${s.names.join(", ")} in ${s.iters.map((e) => emitExpr(e, 0)).join(", ")} do${nl}${block(s.body, indent + 2)}${nl}${pad}end`;
    case "function": {
      const params = [...s.params, ...(s.vararg ? ["..."] : [])].join(", ");
      const head = s.local
        ? `local function ${s.name.path[0]}(${params})`
        : `function ${emitFuncName(s)}(${params})`;
      return `${pad}${head}${nl}${block(s.body, indent + 2)}${nl}${pad}end`;
    }
    case "return":
      if (!s.values.length) return `${pad}return`;
      return `${pad}return ${s.values.map((e) => emitExpr(e, 0)).join(", ")}`;
  }
}

function emitFuncName(s: Extract<Stmt, { type: "function" }>): string {
  const path = s.name.path.join(".");
  return s.name.method ? `${path}:${s.name.method}` : path;
}

export function emitExpr(e: Expr, parent: number): string {
  switch (e.type) {
    case "nil":
      return "nil";
    case "boolean":
      return e.value ? "true" : "false";
    case "number":
      return emitNumber(e.value, e.raw);
    case "string":
      return luaString(e.value);
    case "vararg":
      return "...";
    case "name":
      return e.name;
    case "unary": {
      const inner = emitExpr(e.arg, UNARY_OUT);
      const op = e.op === "not" ? "not " : e.op;
      const text = op + inner;
      return parent > UNARY_OUT ? `(${text})` : text;
    }
    case "binary": {
      const prec = PREC[e.op] ?? 0;
      const leftPrec = RIGHT.has(e.op) ? prec + 1 : prec;
      const rightPrec = RIGHT.has(e.op) ? prec : prec + 1;
      const text = `${emitExpr(e.left, leftPrec)} ${e.op} ${emitExpr(e.right, rightPrec)}`;
      return parent > prec ? `(${text})` : text;
    }
    case "index": {
      if (e.index.type === "string" && isIdent(e.index.value)) {
        return `${emitExpr(e.object, 13)}.${e.index.value}`;
      }
      return `${emitExpr(e.object, 13)}[${emitExpr(e.index, 0)}]`;
    }
    case "call": {
      const args = e.args.map((a) => emitExpr(a, 0)).join(", ");
      if (e.method) return `${emitExpr(e.callee, 13)}:${e.method}(${args})`;
      return `${emitExpr(e.callee, 13)}(${args})`;
    }
    case "function": {
      const params = [...e.params, ...(e.vararg ? ["..."] : [])].join(", ");
      const body = e.body
        .map((s) => emitStmt(s, 2, false))
        .filter((x) => x.trim().length > 0)
        .join("\n");
      if (!body) return `function(${params}) end`;
      return `function(${params})\n${body}\nend`;
    }
    case "table":
      return emitTable(e);
    case "paren":
      return `(${emitExpr(e.expr, 0)})`;
    case "prot": {
      const key = e.key ? `, ${emitExpr(e.key, 0)}` : "";
      const fn = e.pool === "s" ? "__DF_DS" : "__DF_DN";
      return `${fn}(${e.index}${key})`;
    }
    case "vmclosure": {
      const key = e.key ? emitExpr(e.key, 0) : "nil";
      return `function(...)\n  return __DF_VM(${e.proto}, ${key}, ...)\nend`;
    }
  }
}

const UNARY_OUT = 11;

function emitTable(e: Extract<Expr, { type: "table" }>): string {
  if (!e.fields.length) return "{}";
  const parts = e.fields.map((f) => {
    if (!f.key) return emitExpr(f.value, 0);
    if (f.key.type === "string" && isIdent(f.key.value)) return `${f.key.value} = ${emitExpr(f.value, 0)}`;
    return `[${emitExpr(f.key, 0)}] = ${emitExpr(f.value, 0)}`;
  });
  return `{ ${parts.join(", ")} }`;
}

function isIdent(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

export function emitNumber(n: number, raw?: string): string {
  if (Object.is(n, -0)) return "(-0)";
  if (Number.isNaN(n)) return "(0/0)";
  if (n === Infinity) return "(1/0)";
  if (n === -Infinity) return "(-1/0)";
  if (raw && /^[-+0-9.xXa-fA-FpPeE]+$/.test(raw)) return raw;
  if (Number.isSafeInteger(n)) return String(n);
  return n.toExponential(16);
}

export function luaString(s: string): string {
  let out = '"';
  for (const b of utf8Bytes(s)) {
    if (b === 34) out += '\\"';
    else if (b === 92) out += "\\\\";
    else if (b === 10) out += "\\n";
    else if (b === 13) out += "\\r";
    else if (b === 9) out += "\\t";
    else if (b >= 32 && b < 127) out += String.fromCharCode(b);
    else out += "\\" + String(b).padStart(3, "0");
  }
  out += '"';
  return out;
}

export function renameRuntime(code: string, names: { ds: string; dn: string; vm: string }): string {
  return code.replaceAll("__DF_DS", names.ds).replaceAll("__DF_DN", names.dn).replaceAll("__DF_VM", names.vm);
}
