import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionLine, MENU, autoLayout, splitDeck, projectColor, isDeckKey, keyCode, hookStatus, nextAttention, fuzzyFilter, lineRange, mentionFor, pasteSequence, basename, seedPrompt, handoffPrompt } from "./logic.js";

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

test("seed prompt points the new session at its memory files", () => {
  const changed = Array.from({ length: 22 }, (_, i) => `f${i}.js`);
  const p = seedPrompt({ mention: "@{path}", spec: "MASTER SPEC.md", hasProgress: true, changed, lastAsk: "로그인\n고쳐줘" });
  assert.match(p, /스펙: @"MASTER SPEC\.md"/);
  assert.match(p, /진행 기록: @\.mygdeck\/progress\.md/);
  assert.match(p, /f19\.js 외 2개/);
  assert.match(p, /마지막 요청: "로그인 고쳐줘"/);
  const bare = seedPrompt({ mention: "", spec: null, hasProgress: false, changed: [], lastAsk: null });
  assert.equal(bare.split("\n").length, 2);
  assert.match(handoffPrompt("컨텍스트가 곧 가득 찹니다."), /progress\.md/);
});

test("router: explicit prefixes win, rules pick the rest", async () => {
  const { routeInput, nextRoute } = await import("./logic.js");
  assert.equal(routeInput("/model opus").route, "cli");
  assert.equal(routeInput("!ls").route, "cli");
  assert.equal(routeInput("?? tauri 단축키?").text, "tauri 단축키?");
  assert.equal(routeInput("로그인 화면에 토글 추가해").route, "code");
  assert.equal(routeInput("왜 터미널 출력이 끊기는지 원인 분석해").route, "deep");
  assert.equal(routeInput("Tauri v2 global shortcut 쓰는 법?").route, "search");
  assert.equal(routeInput("이 diff 한 줄로 요약해줘").route, "code");
  assert.equal(nextRoute("code", ["code", "deep"]), "deep");
  assert.equal(nextRoute("deep", ["code", "deep"]), "code");
});

test("router: everyday inputs land on the expected path", async () => {
  const { routeInput } = await import("./logic.js");
  const cases = [
    ["로그인 화면에 비밀번호 표시 토글 추가해", "code"],
    ["package.json 의존성 최신으로 업데이트해줘", "code"],
    ["src/main.js 읽고 구조 설명해줘", "code"],
    ["이 코드 왜 느려? 최적화해줘", "code"],
    ["새 컴포넌트 설계하고 구현해줘", "code"],
    ["다음으로 뭐하면 좋을까?", "code"],
    ["이거 어떻게 생각해?", "code"],
    ["응", "code"],
    ["왜 터미널 출력이 가끔 끊기는지 원인 분석해", "deep"],
    ["메모리 누수 원인 찾아줘", "deep"],
    ["아키텍처 설계해줘", "deep"],
    ["이 에러 원인이 뭐야? ECONNREFUSED 127.0.0.1", "search"],
    ["오늘 환율 알려줘", "search"],
    ["vite 최신 버전이 뭐야", "search"],
    ["README 요약해줘", "code"],
    ["이 함수 설명해줘", "code"],
  ];
  for (const [text, want] of cases) assert.equal(routeInput(text).route, want, text);
});

test("menus and permission lines", () => {
  assert.ok(MENU.test("❯ 1. Yes, switch to Haiku"));
  assert.ok(MENU.test("Enter to confirm · Esc to cancel"));
  assert.ok(!MENU.test("The command ran and printed ok."));
  assert.equal(permissionLine("Bash", "rm -rf build"), "허용하면 이 명령이 실행됩니다: rm -rf build");
});
