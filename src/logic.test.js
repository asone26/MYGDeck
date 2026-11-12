import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionLine, MENU, menuChoices, menuQuestion, autoLayout, splitDeck, projectColor, isDeckKey, keyCode, keyLabel, hookStatus, nextAttention, fuzzyFilter, lineRange, mentionFor, pasteSequence, basename, seedPrompt, handoffPrompt, promptWaiting, isAgentNotice, ghostSuggestion, timeline, errorLine } from "./logic.js";

test("auto layout follows project count", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(autoLayout), ["one", "one", "two", "three", "many", "many"]);
});

test("shrunk cards move aside, many projects stay full-size", () => {
  assert.deepEqual(splitDeck(["full", "compact", "full"], 0), { main: [0, 2], side: [1] });
  assert.deepEqual(splitDeck(["mini", "compact"], 1), { main: [0, 1], side: [] });
  assert.deepEqual(splitDeck(Array(5).fill("full"), 3), { main: [0, 1, 2, 3, 4], side: [] });
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
  assert.equal(isDeckKey({ ctrlKey: true, code: "KeyI", key: "ㅑ" }), true);
  assert.equal(isDeckKey({ ctrlKey: true, code: "", key: " " }), true);
  assert.equal(isDeckKey({ ctrlKey: true, code: "", key: "=" }), true);
  assert.equal(isDeckKey({ ctrlKey: true, code: "Period" }), true);
  assert.equal(isDeckKey({ ctrlKey: true, shiftKey: true, code: "KeyJ" }), false);
  assert.equal(isDeckKey({ altKey: true, code: "KeyJ" }), false);
  // Copy, cut, interrupt and Claude Code's own keys stay with the CLI.
  for (const code of ["KeyC", "KeyX", "KeyO", "KeyT", "KeyV", "KeyJ", "KeyN", "KeyW", "ArrowLeft"]) assert.equal(isDeckKey({ ctrlKey: true, code }), false);
  assert.equal(keyCode({ code: "", key: "3" }), "Digit3");
});

test("macOS deck keys use Command, except the ones the OS keeps", () => {
  assert.equal(isDeckKey({ metaKey: true, code: "KeyI" }, true), true);
  assert.equal(isDeckKey({ ctrlKey: true, code: "KeyI" }, true), false); // ⌃I goes to the CLI
  assert.equal(isDeckKey({ metaKey: true, ctrlKey: true, code: "KeyI" }, true), false);
  assert.equal(isDeckKey({ metaKey: true, code: "KeyC" }, true), false); // ⌘C copies
  for (const code of ["Space", "Tab", "Backquote", "KeyQ"]) {
    assert.equal(isDeckKey({ ctrlKey: true, code }, true), true);
    assert.equal(isDeckKey({ metaKey: true, code }, true), false);
  }
  assert.equal(isDeckKey({ metaKey: true, code: "KeyI" }, false), false);
  assert.equal(keyLabel("Ctrl+Space 다음 · Ctrl+1~9 이동 · Ctrl+` 터미널 (Ctrl+Q) (Ctrl+F4) Ctrl+;", true), "⌃Space 다음 · ⌘1~9 이동 · ⌃` 터미널 (⌃Q) (⌘F4) ⌘;");
  assert.equal(keyLabel("닫기 (Ctrl+F4)", false), "닫기 (Ctrl+F4)");
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
  assert.deepEqual(menuChoices(["1. old list item", "Pick a model", "❯ 1. Opus", "2. Haiku", "Enter to confirm"]), [
    { label: "Opus", keys: ["1"] },
    { label: "Haiku", keys: ["2"] },
  ]);
  // Claude Code's folder trust prompt: no numbers, cursor on the default.
  assert.deepEqual(menuChoices(["Quick safety check: trust this folder?", "Security guide", "❯ No, exit", "  Yes, I trust this folder", "Enter to confirm · Esc to cancel"]), [
    { label: "No, exit", keys: ["\r"] },
    { label: "Yes, I trust this folder", keys: ["\x1b[B", "\r"] },
  ]);
  assert.deepEqual(menuChoices(["Overwrite? (y/n)"]).map((c) => c.keys), [["y", "\r"], ["n", "\r"]]);
  const trust = ["Accessing workspace:", "", "C:\\Project\\MYGStat", "", "Quick safety check: Is this a project", "you trust?", "", "Security guide", "", "❯ No, exit", "  Yes, I trust this folder", "", "Enter to confirm · Esc to cancel"];
  assert.equal(menuQuestion(trust, menuChoices(trust)), "Accessing workspace:\nC:\\Project\\MYGStat\nQuick safety check: Is this a project you trust?\nSecurity guide");
  assert.equal(menuQuestion(["Overwrite? (y/n)"], menuChoices(["Overwrite? (y/n)"])), "Overwrite? (y/n)");
  assert.equal(menuQuestion(["╭───╮", "│ Pick a model │", "│ ❯ 1. Opus │", "╰───╯"], [{ label: "Opus", keys: ["1"] }]), "Pick a model");
  assert.deepEqual(menuChoices(["just text"]), []);
  assert.equal(permissionLine("Bash", "rm -rf build"), "허용하면 이 명령이 실행됩니다: rm -rf build");
});

test("replySuggestions offers listed options or yes/no only after a question", async () => {
  const { replySuggestions } = await import("./logic.js");
  assert.deepEqual(replySuggestions(["테스트를 모두 고쳤습니다."]), []);
  assert.deepEqual(replySuggestions([]), []);
  const yn = replySuggestions(["변경을 마쳤습니다.\n\n커밋까지 할까요?"]);
  assert.deepEqual(yn.map((r) => r.label), ["네, 진행", "아니요"]);
  const opts = replySuggestions([
    "두 가지 방법이 있습니다.\n\n1. **캐시 추가** — 빠르지만 메모리를 씁니다\n2. 쿼리 최적화: 느리지만 안전\n\n어느 쪽으로 할까요?",
  ]);
  assert.deepEqual(opts, [
    { label: "1. 캐시 추가", text: "1번으로 진행해줘" },
    { label: "2. 쿼리 최적화", text: "2번으로 진행해줘" },
  ]);
  const letters = replySuggestions(["A) 지금 배포\nB) 내일 배포\nWhich one?"]);
  assert.deepEqual(letters.map((r) => r.text), ["A안으로 진행해줘", "B안으로 진행해줘"]);
});

test("promptWaiting: menu patterns plus the adapter's regex", () => {
  assert.ok(promptWaiting(["Run tests?", "› 1. Yes, proceed", "  2. No", "Press enter to confirm or esc to cancel"], ""));
  assert.ok(promptWaiting(["⠏ Waiting for user confirmation..."], "Waiting for user confirmation"));
  assert.ok(!promptWaiting(["Writing file src/a.js", "done"], "Waiting for user confirmation"));
  assert.ok(!promptWaiting(["anything"], "(")); // invalid regex is ignored
});

test("menuQuestion stops at the first numbered option even when later labels repeat it", () => {
  const lines = [" Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again", "   3. No"];
  assert.equal(menuQuestion(lines, menuChoices(lines)), "Do you want to proceed?");
});

test("harness notices are not user requests", () => {
  assert.ok(isAgentNotice("<agent-message from=\"af3\">\n[Subagent hand-back] …"));
  assert.ok(isAgentNotice("  <task-notification>\n<task-id>1</task-id>"));
  assert.ok(isAgentNotice("[SYSTEM NOTIFICATION - NOT USER INPUT]"));
  assert.ok(!isAgentNotice("agent-message 형식이 왜 이래?"));
  assert.ok(!isAgentNotice(null));
});

test("ghost suggestion only on an empty input line", () => {
  const cells = (s, faint = true) => [...s].map((ch) => ({ ch, faint }));
  assert.equal(ghostSuggestion(cells("커밋해줘   ")), "커밋해줘");
  assert.equal(ghostSuggestion([...cells("커밋"), ...cells("해", false)]), null);
  assert.equal(ghostSuggestion(cells('Try "fix lint errors"')), null);
  assert.equal(ghostSuggestion(cells("    ")), null);
});

test("timeline keeps the CLI order of texts and tools", () => {
  const turn = {
    texts: ["원인을 보겠습니다.", "고쳤습니다."],
    tools: [
      { name: "Bash", detail: "npm test", error: "Exit code 1\n2 tests failed", at: 1 },
      { name: "Edit", detail: "src/a.js", error: null, at: 1 },
    ],
  };
  assert.deepEqual(timeline(turn).map((x) => x.kind), ["text", "tools", "text"]);
  assert.deepEqual(timeline(turn)[1].items.map((s) => [s.text, s.error]), [["Bash npm test", "2 tests failed"], ["Edit src/a.js", null]]);
  // the hook's tool shows before the transcript has it, once
  assert.equal(timeline(turn, "Read b.js").at(-1).items[0].text, "Read b.js");
  assert.equal(timeline({ texts: [], tools: [{ name: "Read", detail: "b.js", at: 0 }] }, "Read b.js")[0].items.length, 1);
  assert.deepEqual(timeline(null, "Bash ls"), [{ kind: "tools", items: [{ text: "Bash ls", error: null, full: null }] }]);
});

test("error line skips tags and the bare exit code", () => {
  assert.equal(errorLine("<tool_use_error>File has not been read yet</tool_use_error>"), "File has not been read yet");
  assert.equal(errorLine("Exit code 2"), "Exit code 2");
});
