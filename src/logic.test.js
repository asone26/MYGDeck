import { test } from "node:test";
import assert from "node:assert/strict";
import { autoLayout, hookStatus, nextAttention, fuzzyFilter, lineRange, mentionFor, pasteSequence, basename } from "./logic.js";

test("auto layout follows project count", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(autoLayout), ["one", "one", "two", "three", "four", "focus", "focus"]);
});

test("hook events map to card status", () => {
  assert.equal(hookStatus("tool", { tool: "Edit", detail: "C:/p/src/auth.ts" }, "working").text, "Edit C:/p/src/auth.ts");
  assert.equal(hookStatus("notify", { message: "Claude needs your permission to use Bash" }, "working").status, "waiting");
  assert.equal(hookStatus("notify", { message: "Claude is waiting for your input" }, "done"), null);
  assert.equal(hookStatus("stop", {}, "working").status, "done");
  assert.equal(hookStatus("unknown", {}, "idle"), null);
});

test("next attention prefers waiting, wraps around", () => {
  assert.equal(nextAttention(["done", "working", "waiting"], 2), 0);
  assert.equal(nextAttention(["waiting", "done", "waiting"], 0), 2);
  assert.equal(nextAttention(["working", "idle"], 0), -1);
});

test("fuzzy filter ranks file-name matches first", () => {
  const files = ["src/main.rs", "docs/maintenance.md", "src/pty.rs"];
  assert.deepEqual(fuzzyFilter("pty", files), ["src/pty.rs"]);
  assert.equal(fuzzyFilter("main", files)[0], "src/main.rs");
  assert.equal(fuzzyFilter("", files).length, 3);
});

test("selection to line range and mention", () => {
  assert.deepEqual(lineRange("a\nb\n", "c\nd\n"), [3, 4]);
  assert.deepEqual(lineRange("", "one"), [1, 1]);
  assert.equal(mentionFor("@{path}", "src/a b.ts", [3, 4]), '@"src/a b.ts" L3-4');
  assert.equal(mentionFor(undefined, "x.rs"), "@x.rs");
});

test("paste sequence", () => {
  assert.equal(pasteSequence("a\nb", true), "\x1b[200~a\nb\x1b[201~");
  assert.equal(pasteSequence("a\nb", false), "a\rb");
  assert.equal(basename("C:\\work\\mygstat\\"), "mygstat");
});
