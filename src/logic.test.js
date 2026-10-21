import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeTurn, parseProgress, permissionLine, MENU, autoLayout, splitDeck, projectColor, isDeckKey, keyCode, hookStatus, nextAttention, fuzzyFilter, lineRange, mentionFor, pasteSequence, basename } from "./logic.js";

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
  assert.deepEqual(hookStatus("notify", { message: "Claude needs your permission to use Bash" }, "working"), { status: "waiting", text: "Bash 사용 허용을 기다립니다" });
  assert.equal(hookStatus("notify", { message: "Claude is waiting for your input" }, "done"), null);
  assert.equal(hookStatus("stop", {}, "working").status, "done");
  assert.equal(hookStatus("unknown", {}, "idle"), null);
});

test("next attention prefers waiting, wraps around", () => {
  assert.equal(nextAttention(["done", "working", "waiting"], 2), 0);
  assert.equal(nextAttention(["waiting", "done", "waiting"], 0), 2);
  assert.equal(nextAttention(["done", "failed", "idle"], 2), 1);
  assert.equal(hookStatus("notify", { message: "Claude is waiting for your input" }, "failed"), null);
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

test("summary: failed check gives cause and next step", () => {
  const turn = {
    texts: ["I updated the login rule. Tests are failing."],
    tools: [
      { name: "Edit", detail: "C:/p/src/auth.js" },
      { name: "Bash", detail: "npm test", error: "Exit code 1\n  ✕ login rejects short pw\nError: expected false" },
    ],
  };
  const s = summarizeTurn(turn, null);
  assert.equal(s.state, "failed");
  assert.equal(s.line, "I updated the login rule.");
  assert.equal(s.cause, "Error: expected false");
  assert.equal(summarizeTurn({ texts: [], tools: turn.tools }, null).line, "npm test 실패");
  assert.match(s.next, /npm test 실패 원인/);
});

test("summary: never claims success without proof", () => {
  const s = summarizeTurn({ texts: ["Added the password toggle."], tools: [{ name: "Write", detail: "a/b.tsx" }] }, null);
  assert.equal(s.state, "done");
  assert.equal(s.line, "Added the password toggle.");
  assert.equal(s.proof.ok, false);
  assert.match(s.next, /확인/);
});

test("summary: passing check and progress point to the next item", () => {
  const progress = parseProgress("- [x] 로그인\n- [ ] 회원가입\n* [X] 설정\n");
  assert.deepEqual(progress, { done: 2, total: 3, next: "회원가입", source: "progress" });
  const s = summarizeTurn({ texts: ["Done."], tools: [{ name: "Edit", detail: "x.rs" }, { name: "Bash", detail: "cargo test" }] }, progress);
  assert.deepEqual(s.proof, { ok: true, text: "cargo test 통과" });
  assert.equal(s.big, "진행 2/3");
  assert.equal(s.next, "회원가입 진행해줘");
  assert.equal(parseProgress("no boxes"), null);
});

test("summary: request line, docs-only proof, spec progress", () => {
  const spec = parseProgress("- [x] a\n- [ ] **b**\n", "spec");
  const s = summarizeTurn({ prompt: "README 고쳐줘\n자세히", texts: ["Checking.", "README를 고쳤습니다."], tools: [{ name: "Edit", detail: "C:/p/README.md" }] }, spec);
  assert.equal(s.ask, "README 고쳐줘 자세히");
  assert.equal(s.line, "README를 고쳤습니다.");
  assert.deepEqual(s.proof, { ok: true, text: "문서만 수정 · 실행 확인 불필요" });
  assert.equal(s.big, "스펙 진행 1/2");
  assert.equal(s.next, null);
  assert.equal(summarizeTurn({ texts: [], tools: [{ name: "PowerShell", detail: "npm test" }] }, null).proof.ok, true);
});

test("menus and permission lines", () => {
  assert.ok(MENU.test("❯ 1. Yes, switch to Haiku"));
  assert.ok(MENU.test("Enter to confirm · Esc to cancel"));
  assert.ok(!MENU.test("The command ran and printed ok."));
  assert.equal(permissionLine("Bash", "rm -rf build"), "허용하면 이 명령이 실행됩니다: rm -rf build");
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
