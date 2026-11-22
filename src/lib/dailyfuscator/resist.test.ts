import assert from "node:assert/strict";
import test from "node:test";
import { lauxlib, lua, lualib, to_jsstring, to_luastring } from "fengari";
import { obfuscate } from "./pipeline.ts";
import { decodePayload, encodePayload } from "./payload.ts";

const GREET = `local function greet(name)
  local msg = "hello, " .. name
  if #name > 0 then
    return msg
  end
  return "hello"
end
return greet
`;

function runLua(code: string): { ok: true; values: string[] } | { ok: false; error: string } {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const status = lauxlib.luaL_dostring(L, to_luastring(code));
  if (status !== lua.LUA_OK) {
    const error = lua.lua_type(L, -1) === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(L, -1)) : "lua error";
    return { ok: false, error };
  }
  const n = lua.lua_gettop(L);
  const values: string[] = [];
  for (let i = 1; i <= n; i++) {
    const t = lua.lua_type(L, i);
    if (t === lua.LUA_TSTRING || t === lua.LUA_TNUMBER) values.push(to_jsstring(lua.lua_tostring(L, i)));
    else if (t === lua.LUA_TBOOLEAN) values.push(lua.lua_toboolean(L, i) ? "true" : "false");
    else if (t === lua.LUA_TNIL) values.push("nil");
    else if (t === lua.LUA_TFUNCTION) values.push("function");
    else values.push(lua.lua_typename(L, t));
  }
  return { ok: true, values };
}

function norm(values: string[]) {
  return values.map((v) => (/^-?\d+(\.\d+)?$/.test(v) ? String(Number(v)) : v));
}

function callReturned(code: string, args: string[]) {
  const argList = args.map((a) => JSON.stringify(a)).join(",");
  return runLua(`local __fn=(function(...)\n${code}\nend)()\nreturn __fn(${argList})`);
}

function protect(source: string, profile: "light" | "standard" | "hard", seed: string, minBytes = 4000) {
  const result = obfuscate(source, { profile, seed, minBytes, notice: false });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) throw new Error(result.error);
  return result;
}

test("greet behavior matches across profiles and inputs", () => {
  const inputs = ["world", "", "x", "hello"];
  const expected = inputs.map((name) => (name.length > 0 ? `hello, ${name}` : "hello"));
  for (const profile of ["light", "standard", "hard"] as const) {
    const built = protect(GREET, profile, `greet-${profile}`, 4000);
    for (let i = 0; i < inputs.length; i++) {
      const got = callReturned(built.code, [inputs[i]]);
      assert.equal(got.ok, true, got.ok ? "" : `${profile}: ${got.error}`);
      if (got.ok) assert.deepEqual(norm(got.values), [expected[i]], `${profile} ${inputs[i]}`);
    }
  }
});

test("loops, tables, branches, numbers, and multiple returns", () => {
  const cases = [
    [`local s,i=0,1\nwhile i<=4 do s=s+i i=i+1 end\nreturn s`, ["10"]],
    [`local t={a=1}\nt.b=2\nreturn t.a+t["b"]`, ["3"]],
    [
      `local function f(n)\nif n>2 then\nif n>4 then return "big" end\nreturn "mid"\nend\nreturn "small"\nend\nreturn f(1), f(3), f(9)`,
      ["small", "mid", "big"],
    ],
    [`local function f()\nreturn 1,"x",3\nend\nreturn f()`, ["1", "x", "3"]],
    [`return (8+2)*3-4, 7%4, 2^3`, ["26", "3", "8"]],
    [`local function f()\nreturn nil, false, true\nend\nreturn f()`, ["nil", "false", "true"]],
    [`return "héllo", ""`, ["héllo", ""]],
    [`local function addn(n)\nreturn function(x) return x+n end\nend\nreturn addn(10)(5)`, ["15"]],
  ];
  for (const [source, expected] of cases) {
    const plain = runLua(source);
    assert.equal(plain.ok, true);
    if (plain.ok) assert.deepEqual(norm(plain.values), expected);
    const built = protect(source, "standard", `case-${expected.join("-")}`, 3000);
    const got = runLua(built.code);
    assert.equal(got.ok, true, got.ok ? "" : got.error);
    if (got.ok) assert.deepEqual(norm(got.values), expected, source);
  }
});

test("old linear pad and salt formulas are gone", () => {
  const built = protect(GREET, "standard", "mapping", 8000);
  assert.equal(/d4:[0-9a-f]+:[0-9a-f]+;d4:[0-9a-f]+:[0-9a-f]+/.test(built.code), false);
  assert.equal(/\bsel==\d+/.test(built.code), false);
  assert.equal(built.code.includes("[b]+"), false);
  assert.equal(built.code.includes("[b]<"), false);
  assert.equal(built.code.includes("index*17"), false);
  assert.equal(built.code.includes("%251"), false);
  assert.equal(built.code.includes("mixed-kb-salt"), false);
  assert.equal(built.code.includes("(y-salt)%256"), false);
  assert.equal(built.code.includes("(i*17)%256"), false);
  assert.equal(built.code.includes("(i*3)%256"), false);
  assert.equal(built.code.includes("hello, "), false);
  assert.equal(built.code.includes('"hello"'), false);
  assert.equal(built.code.includes("__DF_DS"), false);
  assert.equal(built.code.includes("__DF_VM"), false);
  assert.equal(/[^\x00-\x7F]/.test(built.code), false);
  assert.equal(built.code.includes("\u202e"), false);
  assert.equal(built.code.includes("\u200b"), false);
  assert.equal(/\n{8,}/.test(built.code), false);
  const cleaned = built.code
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/[^\x00-\x7F]/g, "");
  assert.equal(cleaned.includes("return setmetatable("), true);
  assert.equal(cleaned.includes("while st."), false);
  assert.equal(cleaned.includes("local function"), false);
  assert.equal(cleaned.includes('"load"'), false);
  assert.equal(cleaned.includes('"string"'), false);
  assert.equal(cleaned.includes("%4294967296"), false);
  assert.equal(cleaned.includes("[y]*"), false);
  assert.equal(cleaned.includes("Path2D"), true);
  assert.equal(cleaned.includes("hello, "), false);
});

test("two seeds differ in structure and both stay correct", () => {
  const a = protect(`return (function(s) if #s>0 then return "hello, "..s end return "hello" end)("world")`, "standard", "seed-a", 4000);
  const b = protect(`return (function(s) if #s>0 then return "hello, "..s end return "hello" end)("world")`, "standard", "seed-b", 4000);
  assert.notEqual(a.code, b.code);
  assert.notEqual(a.report.checksum, b.report.checksum);
  for (const built of [a, b]) {
    const got = runLua(built.code);
    assert.equal(got.ok, true, got.ok ? "" : got.error);
    if (got.ok) assert.deepEqual(norm(got.values), ["hello, world"]);
  }
});

test("call argument is not assembled outside the VM", () => {
  const source = `local function greet(name)\nlocal msg="hello, "..name\nif #name>0 then return msg end\nreturn "hello"\nend\nreturn greet("world")\n`;
  const built = protect(source, "standard", "call-site", 4000);
  assert.equal(built.report.virtualized >= 2, true);
  assert.equal(built.code.includes('"world"'), false);
  assert.equal(built.code.includes("hello, "), false);
  const got = runLua(built.code);
  assert.equal(got.ok, true, got.ok ? "" : got.error);
  if (got.ok) assert.deepEqual(got.values, ["hello, world"]);
});

test("ascii output has no unicode armor and still returns hello, world", () => {
  const source = `local function greet(name)\nlocal msg="hello, "..name\nif #name>0 then return msg end\nreturn "hello"\nend\nreturn greet("world")\n`;
  const built = protect(source, "standard", "full-size", 0);
  assert.equal(/[^\x00-\x7F]/.test(built.code), false);
  assert.ok(built.report.bytes > 1000);
  assert.equal(built.code.length, built.report.bytes);
  const got = runLua(built.code);
  assert.equal(got.ok, true, got.ok ? "" : got.error);
  if (got.ok) assert.deepEqual(norm(got.values), ["hello, world"]);
});

test("closures, recursion, loops, and metatables stay virtualized", () => {
  const cases: [string, string[], number][] = [
    [
      `local function fact(n)\nif n<=1 then return 1 end\nreturn n*fact(n-1)\nend\nreturn fact(5)`,
      ["120"],
      2,
    ],
    [
      `local function addn(n)\nreturn function(x) return x+n end\nend\nreturn addn(10)(5)`,
      ["15"],
      3,
    ],
    [
      `local n=1\nlocal function inc()\nn=n+1\nend\ninc()\nreturn n`,
      ["2"],
      2,
    ],
    [
      `local function counter()\nlocal n=0\nreturn function()\nn=n+1\nreturn n\nend\nend\nlocal c=counter()\nreturn c(),c(),c()`,
      ["1", "2", "3"],
      3,
    ],
    [
      `local s=0\nfor i=1,4 do s=s+i end\nreturn s`,
      ["10"],
      1,
    ],
    [
      `local s=0\nfor _,v in ipairs({3,4}) do s=s+v end\nreturn s`,
      ["7"],
      1,
    ],
    [
      `local t={}\nsetmetatable(t,{__index=function() return 7 end})\nreturn t.missing`,
      ["7"],
      1,
    ],
    [
      `local ok=pcall(function() error("boom") end)\nreturn ok`,
      ["false"],
      2,
    ],
  ];
  for (const [source, expected, minProtos] of cases) {
    const plain = runLua(source);
    assert.equal(plain.ok, true, plain.ok ? "" : plain.error);
    if (plain.ok) assert.deepEqual(norm(plain.values), expected, source);
    const built = protect(source, "standard", `vm-${expected.join("-")}`, 3000);
    assert.ok(built.report.virtualized >= minProtos, `${source} virtualized ${built.report.virtualized}`);
    assert.equal(built.report.skipped.upvalue ?? 0, 0);
    const got = runLua(built.code);
    assert.equal(got.ok, true, got.ok ? "" : `${got.error}\n${source}`);
    if (got.ok) assert.deepEqual(norm(got.values), expected, source);
    assert.equal(built.code.includes("DAILYFUSCATOR ON TOP"), false);
  }
});

test("payload rejects a bad header before any sections are trusted", () => {
  const ok = encodePayload([
    { tag: 1, data: [0, 0] },
    { tag: 2, data: [0, 0] },
    { tag: 3, data: [0, 0] },
  ]);
  assert.equal(decodePayload(ok).length, 3);
  assert.throws(() => decodePayload([0, 1, 2, 3, 3, 0, 0, 0]), /magic/);
  assert.throws(() => decodePayload([0x44, 0x46, 0x33, 0x01, 2, 0, 0, 0]), /version/);
  assert.throws(() => decodePayload(ok.slice(0, ok.length - 1)), /out of range|truncated/);
  const extra = ok.slice();
  extra.push(1);
  assert.throws(() => decodePayload(extra), /trailing|out of range|sections|truncated/);
});
