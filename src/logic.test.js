import { test } from "node:test";
import assert from "node:assert/strict";
import { autoLayout, splitDeck, projectColor, isDeckKey, keyCode, hookStatus, nextAttention, fuzzyFilter, lineRange, mentionFor, pasteSequence, basename } from "./logic.js";

test("auto layout follows project count", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(autoLayout), ["one", "one", "two", "three", "four", "many"]);
});

test("shrunk cards move aside, 5+ projects focus on the active one", () => {
  assert.deepEqual(splitDeck(["full", "compact", "full"], 0), { main: [0, 2], side: [1] });
  assert.deepEqual(splitDeck(["mini", "compact"], 1), { main: [0, 1], side: [] });
  assert.deepEqual(splitDeck(Array(5).fill("full"), 3), { main: [3], side: [0, 1, 2, 4] });
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

test("deck keys work with and without physical key codes", () => {
  assert.equal(isDeckKey({ altKey: true, code: "KeyJ", key: "ㅓ" }), true);
  assert.equal(isDeckKey({ altKey: true, code: "", key: "j" }), true);
  assert.equal(isDeckKey({ altKey: true, code: "", key: "=" }), true);
  assert.equal(isDeckKey({ altKey: true, ctrlKey: true, code: "KeyJ" }), false);
  assert.equal(isDeckKey({ altKey: true, code: "KeyB", key: "b" }), false);
  assert.equal(keyCode({ code: "", key: "3" }), "Digit3");
});

test("open projects never share a color", () => {
  const used = [];
  for (const name of ["shop", "blog", "api", "a", "b", "c", "d", "e", "f", "g"]) used.push(projectColor(name, used));
  assert.equal(new Set(used).size, 10);
  assert.equal(projectColor("shop"), projectColor("shop"));
});

test("paste sequence", () => {
  assert.equal(pasteSequence("a\nb", true), "\x1b[200~a\nb\x1b[201~");
  assert.equal(pasteSequence("a\nb", false), "a\rb");
  assert.equal(basename("C:\\work\\mygstat\\"), "mygstat");
});
