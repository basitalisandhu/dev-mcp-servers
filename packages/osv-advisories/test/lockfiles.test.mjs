import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFormat, parseLockfile } from "../dist/lockfiles.js";

test("detects formats by name and by content", () => {
  assert.equal(detectFormat("package-lock.json", ""), "package-lock");
  assert.equal(detectFormat("/x/poetry.lock", ""), "poetry");
  assert.equal(detectFormat("go.sum", ""), "go-sum");
  assert.equal(detectFormat("dev-requirements.txt", ""), "requirements");
  assert.equal(detectFormat(undefined, '{"name":"a","lockfileVersion":2}'), "package-lock");
  assert.equal(detectFormat(undefined, '[[package]]\nname = "a"'), "poetry");
  assert.equal(detectFormat(undefined, "golang.org/x/text v0.3.0 h1:abc=\n"), "go-sum");
  assert.equal(detectFormat(undefined, "requests==2.0\n"), "requirements");
  assert.equal(detectFormat(undefined, "hello"), undefined);
});

test("poetry.lock and go.sum parse to exact pins", () => {
  const poetry = parseLockfile('[[package]]\nname = "Requests"\nversion = "2.31.0"\n\n[package.extras]\nsocks = []\n\n[[package]]\nname = "idna"\nversion = "3.4"\n', "poetry");
  assert.deepEqual(poetry.packages, [{ ecosystem: "PyPI", name: "requests", version: "2.31.0" }, { ecosystem: "PyPI", name: "idna", version: "3.4" }]);
  const gosum = parseLockfile("golang.org/x/text v0.3.0 h1:a=\ngolang.org/x/text v0.3.0/go.mod h1:b=\nbad line\n", "go-sum");
  assert.deepEqual(gosum.packages, [{ ecosystem: "Go", name: "golang.org/x/text", version: "0.3.0" }]);
  assert.equal(gosum.skipped.length, 1);
});

test("package-lock v1 dependencies tree is walked", () => {
  const v1 = parseLockfile(JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } }, c: { version: "file:../c" } } }), "package-lock");
  assert.deepEqual(v1.packages.map((p) => p.name), ["a", "b"]);
  assert.equal(v1.skipped[0].entry, "c");
  assert.throws(() => parseLockfile("{", "package-lock"), /not valid JSON/);
});
