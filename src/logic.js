// Pure helpers (no DOM, no Tauri) so they can be tested with `node --test`.

/** Auto preset (spec 3.0 ⑥): grid shape for the cards shown at full size. */
export function autoLayout(n) {
  return ["one", "one", "two", "three"][n] ?? "many";
}

/**
 * Which cards get the main area and which are stacked in the narrow side column.
 * Full-size cards share the main area (it scrolls sideways past 3), shrunk ones move aside.
 */
export function splitDeck(densities, active) {
  const all = densities.map((_, i) => i);
  const main = all.filter((i) => densities[i] === "full");
  if (!main.length) return { main: all, side: [] };
  return { main, side: all.filter((i) => densities[i] !== "full") };
}

// Soft, mid-saturation tones that read well on the dark UI.
// No reds, ambers or greens: those hues mean failed, waiting and done, and a project must never look like a state.
const COLORS = ["#7aa6da", "#c79bd9", "#6fbfc0", "#b8c77a", "#e39bb6", "#5ec4e8", "#a98cf0", "#e08fd0", "#9fd172", "#8f97ee"];

/**
 * Per-project color (spec 3.0 ③). The name picks a preferred color so a project usually keeps
 * its color, but open projects never share one: the point is not confusing two cards.
 */
export function projectColor(name, used = []) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const colors = COLORS;
  for (let k = 0; k < colors.length; k++) {
    const c = colors[(h + k) % colors.length];
    if (!used.includes(c)) return c;
  }
  return colors[h % colors.length];
}


const PERMISSION = /permission|approve|허용|승인/i;

/** Map an agent hook event to a card status. Returns null when the event changes nothing. */
export function hookStatus(event, data, current) {
  switch (event) {
    case "prompt":
      return { status: "working", text: "작업 중" };
    case "invocation":
      return current === "working" ? null : { status: "working", text: "작업 중" };
    case "tool":
      return { status: "working", text: toolText(data) };
    case "notify": {
      const msg = koMessage(data?.message) || "입력 대기";
      // An idle reminder after the agent finished is not a new request for the user.
      if (!PERMISSION.test(msg) && (current === "done" || current === "failed")) return null;
      return { status: "waiting", text: msg };
    }
    case "stop":
      return { status: "done", text: "완료" };
    default:
      return null;
  }
}

/** Common agent notices in plain Korean; anything unknown is shown as-is. */
export function koMessage(msg) {
  if (!msg) return msg;
  const perm = msg.match(/needs your permission to use (.+?)\.?$/i);
  if (perm) return `${perm[1]} 사용 허용을 기다립니다`;
  if (/waiting for your input/i.test(msg)) return "다음 지시를 기다립니다";
  return msg;
}

export function toolText(d) {
  const tool = d?.tool || "작업";
  if (!d?.detail) return tool;
  const s = String(d.detail);
  const base = s.split(/[\\/]/).pop();
  const shown = s.length <= 40 ? s : base.length <= 40 ? base : s.slice(0, 39) + "…";
  return `${tool} ${shown}`;
}

/**
 * Agents without hooks: does the screen end on an approval prompt? The deck's menu patterns plus the
 * adapter's own `waiting` regex (an invalid one is ignored).
 */
export function promptWaiting(lines, extra) {
  const tail = lines.filter(Boolean).slice(-8).join("\n");
  if (MENU.test(tail)) return true;
  try {
    return !!extra && new RegExp(extra, "i").test(tail);
  } catch {
    return false;
  }
}

/** Next other card needing the user: waiting, then failed, then done (spec 3.0 ⑧). -1 if none. */
export function nextAttention(statuses, active) {
  const n = statuses.length;
  for (const want of ["waiting", "failed", "done"]) {
    for (let k = 1; k < n; k++) {
      const i = (active + k) % n;
      if (statuses[i] === want) return i;
    }
  }
  return -1;
}

/** Subsequence fuzzy filter for quick open; matches inside the file name rank first. */
export function fuzzyFilter(query, items, limit = 60) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return items.slice(0, limit);
  const scored = [];
  for (const item of items) {
    const s = score(q, item.toLowerCase());
    if (s >= 0) scored.push([s, item]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
  return scored.slice(0, limit).map((x) => x[1]);
}

function score(q, s) {
  const base = s.lastIndexOf("/") + 1;
  let from = 0;
  let last = -1;
  let gaps = 0;
  for (const ch of q) {
    const j = s.indexOf(ch, from);
    if (j < 0) return -1;
    if (last >= 0) gaps += j - last - 1;
    last = j;
    from = j + 1;
  }
  return gaps + (s.indexOf(q[0], base) >= 0 && s.indexOf(q, base) >= 0 ? 0 : 100);
}

/** 1-based [first, last] line of a selection, given the text before it and the selected text. */
export function lineRange(before, selected) {
  const first = before.split("\n").length;
  const last = first + selected.replace(/\n$/, "").split("\n").length - 1;
  return [first, last];
}

/** `@path`, plus the line range when code is selected (spec 3.2 ⑤). */
export function mentionFor(template, rel, range) {
  const path = /\s/.test(rel) ? `"${rel}"` : rel;
  const m = (template || "@{path}").replace("{path}", path);
  return range ? `${m} L${range[0]}-${range[1]}` : m;
}

/** Text to type into the CLI. Bracketed paste keeps multi-line input from being submitted early. */
export function pasteSequence(text, bracketed) {
  return bracketed ? `\x1b[200~${text}\x1b[201~` : text.replace(/\r?\n/g, "\r");
}

/** Ctrl shortcuts owned by the deck; everything else goes to the CLI (spec 3.3). */
export const DECK_KEYS = new Set([
  "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
  "KeyI", "KeyK", "Equal", "Minus",
  // Not Ctrl+letters: in the CLI those are copy/interrupt, line editing (Ctrl+W/N/J...) or Claude Code shortcuts.
  "Space", "Quote", "F4", "Period", "KeyQ", "Backquote", "Semicolon", "PageUp", "PageDown", "Tab",
]);

/**
 * Physical key code. `code` keeps shortcuts working under the Korean IME; synthesized input
 * (SendKeys, some remote tools) leaves it empty, so fall back to the typed key then.
 */
export function keyCode(e) {
  if (e.code) return e.code;
  const k = e.key ?? "";
  if (/^[a-z]$/i.test(k)) return "Key" + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return "Digit" + k;
  return { "=": "Equal", "+": "Equal", "-": "Minus", ".": "Period", ";": "Semicolon", "`": "Backquote", " ": "Space", "'": "Quote" }[k] ?? k;
}

/** WKWebView on macOS; Node (tests) and WebView2 are not. */
export const IS_MAC = /Macintosh|Mac OS X/.test(globalThis.navigator?.userAgent ?? "");

/** On macOS the OS keeps ⌘ with these (app switcher, Spotlight, window cycling, quit), so they stay on ⌃. */
const MAC_CTRL_KEYS = new Set(["Tab", "Space", "Backquote", "KeyQ"]);

/** Modifier of a deck shortcut: Ctrl everywhere, ⌘ on macOS (⌘ never reaches the CLI there). */
export function deckMod(code, mac = IS_MAC) {
  return mac && !MAC_CTRL_KEYS.has(code) ? "meta" : "ctrl";
}

/** The deck modifier alone is held for `code` (no Alt/Shift, not the other of Ctrl/⌘). */
export function isDeckMod(e, code = keyCode(e), mac = IS_MAC) {
  if (e.altKey || e.shiftKey) return false;
  return deckMod(code, mac) === "meta" ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
}

export function isDeckKey(e, mac = IS_MAC) {
  const code = keyCode(e);
  return DECK_KEYS.has(code) && isDeckMod(e, code, mac);
}

const MAC_LABEL = { Space: "⌃Space", Tab: "⌃Tab", "`": "⌃`", Q: "⌃Q" };

/** "Ctrl+P" in UI text → "⌘P" on macOS ("⌃Space" for the keys that stay on Ctrl). */
export function keyLabel(text, mac = IS_MAC) {
  return mac ? text.replace(/Ctrl\+([A-Za-z]\w*|[^\sA-Za-z)]+)/g, (_, k) => MAC_LABEL[k] ?? "⌘" + k) : text;
}

export const DENSITIES = ["mini", "compact", "full"];

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** On-screen markers of an interactive CLI menu the user must answer in the raw CLI. */
export const MENU = /Enter to confirm|Esc to cancel|❯\s*\d+\.|\(y\/n\)|\[y\/N\]|\[Y\/n\]/i;

/**
 * Choices of the on-screen CLI menu, as { label, keys }: key sequences to type into the CLI one by one.
 * Lines keep their indentation. Numbered menus take the last "1. 2. 3." run (a number key picks it);
 * unnumbered "❯ No, exit / Yes, I trust" menus are the lines aligned with the cursor's label (arrows, then Enter);
 * y/n prompts get Yes/No.
 */
export function menuChoices(lines) {
  let opts = [];
  for (const l of lines) {
    const m = /^\s*(?:[❯>›]\s*)?(\d)\.\s+(.+)$/.exec(l);
    if (!m) continue;
    const n = Number(m[1]);
    if (n === 1) opts = [];
    if (n === opts.length + 1) opts.push({ label: m[2].trim(), keys: [m[1]] });
  }
  if (opts.length) return opts;
  const at = lines.findLastIndex((l) => /^\s*❯\s+\S/.test(l));
  if (at >= 0) {
    const col = /^\s*❯\s+/.exec(lines[at])[0].length;
    const isOption = (l) => l.length > col && !l.slice(0, col).trim() && l[col] !== " ";
    let from = at;
    let to = at;
    while (from > 0 && isOption(lines[from - 1])) from--;
    while (to < lines.length - 1 && isOption(lines[to + 1])) to++;
    for (let i = from; i <= to; i++) {
      const d = i - at;
      opts.push({ label: lines[i].slice(col).trim(), keys: [...Array(Math.abs(d)).fill(d > 0 ? "\x1b[B" : "\x1b[A"), "\r"] });
    }
    return opts;
  }
  if (/\(y\/n\)|\[y\/N\]|\[Y\/n\]/i.test(lines.at(-1) ?? "")) return [{ label: "Yes", keys: ["y", "\r"] }, { label: "No", keys: ["n", "\r"] }];
  return [];
}

/**
 * The question above a menu's options (up to 10 lines), so the GUI can ask it before the buttons.
 * Blank lines split paragraphs; wrapped lines inside one are joined back. A y/n prompt is its own last line.
 */
export function menuQuestion(lines, choices) {
  if (!choices.length) return "";
  const yn = choices[0].keys[0] === "y";
  // A numbered menu starts at its "1." line; matching the label alone also hits "2. Yes, and…".
  const first = /^\d$/.test(choices[0].keys[0]) ? lines.findLastIndex((l) => /^\s*(?:[❯>›]\s*)?1\.\s/.test(l)) : -1;
  const end = yn ? lines.length : first >= 0 ? first : lines.findLastIndex((l) => l.includes(choices[0].label));
  if (end < 0) return "";
  const paras = [[]];
  for (const raw of lines.slice(Math.max(0, end - 10), end)) {
    const l = raw.replace(/^[\s│┃|]+|[\s│┃|]+$/g, "");
    if (/^[─━╭╮╰╯┌┐└┘\s]*$/.test(l)) paras.push([]);
    else paras.at(-1).push(l);
  }
  return paras.filter((p) => p.length).map((p) => p.join(" ")).join("\n");
}

/** Plain-language line for a permission prompt, from the last tool the agent tried. */
export function permissionLine(tool, detail) {
  if (!tool) return "에이전트가 허용을 기다립니다";
  if (tool === "Bash" || tool === "PowerShell") return `허용하면 이 명령이 실행됩니다: ${detail}`;
  if (EDIT_TOOLS.has(tool)) return `허용하면 이 파일이 바뀝니다: ${detail}`;
  return `허용하면 ${tool}${detail ? ` (${detail})` : ""}을 실행합니다`;
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function basename(p) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

// ---- Infinite session (spec 4.4): memory lives in project files, not in the conversation ----

/** Share of the context window at which the deck rotates, before the agent's own auto-compact. */
export const ROTATE_AT = 0.7;

/** Context window for the model the transcript last used: the first `context_limits` key in its name, else `context_limit`. */
export function contextLimit(adapter, model) {
  const hit = model && Object.entries(adapter?.context_limits ?? {}).find(([k]) => model.includes(k));
  return hit ? hit[1] : adapter?.context_limit;
}

/** Turn-end instruction before a new session: write down what the next session needs. */
export function handoffPrompt(why) {
  return `[mygdeck] ${why} 새 세션으로 이어가기 전에 .mygdeck/progress.md 를 갱신하세요: 지금까지 한 일, 다음 할 일(- [ ] 체크박스), 중요한 결정 사항. 짧게 쓰고 다른 작업은 하지 마세요.`;
}

/** First message of the new session: point it at the spec, the work log and recent changes. */
export function seedPrompt({ mention, spec, hasProgress, changed, lastAsk }) {
  const lines = ["[mygdeck] 이전 세션에서 이어서 작업합니다. 아래를 읽고 맥락을 복구하세요."];
  if (spec) lines.push(`- 스펙: ${mentionFor(mention, spec)}`);
  if (hasProgress) lines.push(`- 진행 기록: ${mentionFor(mention, ".mygdeck/progress.md")}`);
  if (changed.length) lines.push(`- 최근 변경 파일: ${changed.slice(0, 20).join(", ")}${changed.length > 20 ? ` 외 ${changed.length - 20}개` : ""}`);
  if (lastAsk) lines.push(`- 사용자의 마지막 요청: "${clip(lastAsk.replace(/\s+/g, " ").trim(), 300)}"`);
  lines.push("읽은 뒤 지금 상태와 다음 할 일을 3줄 이내로 말하고, 새 작업은 시작하지 말고 지시를 기다리세요.");
  return lines.join("\n");
}

const ACTION = /(추가|만들|구현|고쳐|수정|최적화|삭제|지워|업데이트|리팩터링해|돌려|실행|커밋|푸시|설치|읽고|열어|바꿔)/;
const FILE = /[\w./\\-]+\.(js|ts|rs|py|md|json|toml|css|html)\b|\bsrc[/\\]/;
// Time-sensitive or outside-the-project questions: only a search can answer them. ERRNO: ECONNREFUSED, ENOENT...
const SEARCH = /(최신|오늘|현재|환율|날씨|뉴스|가격|주가|공식\s*문서|릴리[스즈]|버전|사용법|쓰는\s*(법|방법)|exception|stack ?trace)/i;
const ERRNO = /\bE[A-Z]{4,}\b/;
const DEEP = /(원인|설계|아키텍처|난해|디버깅|root cause|why does|architecture)/i;

/** Input router (spec 4.3), rules only: which path an input takes. `??`/`/`/`!`/`#` are explicit and skip the rules.
 *  Work on the project (a verb or a file name) always goes to the agent, so only plain questions reach the other paths. */
export function routeInput(text) {
  const t = text.trim();
  if (/^[/!#]/.test(t)) return { route: "cli", text };
  if (t.startsWith("??")) return { route: "ask", text: t.slice(2).trim() };
  if (ACTION.test(t) || FILE.test(t)) return { route: "code", text };
  if (SEARCH.test(t) || ERRNO.test(t)) return { route: "search", text };
  if (DEEP.test(t)) return { route: "deep", text };
  return { route: "code", text };
}

export const ROUTE_CHIP = { cli: "cli", ask: "ask", code: "code", deep: "deep", search: "search" };
/** Tab cycles the paths the deck can currently reach. */
export const nextRoute = (route, reachable) => reachable[(reachable.indexOf(route) + 1) % reachable.length];

// ---- Quick replies (A2): the answer ends by asking the user, so offer the likely answers as buttons ----

const ASKS = /[?？]\**\s*$|(할까요|될까요|드릴까요|원하시|하시겠|골라\s*주세요|선택해\s*주세요|알려\s*주세요)/;
const OPTION = /^(?:[-*]\s+)?(?:\*\*)?(?:([1-9])[.)]|\(?([A-Da-d])\))(?:\*\*)?\s+(.+)$/;

/**
 * Replies for an answer that ends with a question: its listed options ("1. …", "A) …") near the end,
 * otherwise yes/no. [] when the answer does not ask anything. Each is { label, text } (text goes to the agent).
 */
export function replySuggestions(texts) {
  const lines = String(texts?.at(-1) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.slice(-3).some((l) => ASKS.test(l))) return [];
  const opts = [];
  for (const l of lines.slice(-15)) {
    const m = OPTION.exec(l);
    if (!m) continue;
    const key = m[1] ?? m[2].toUpperCase();
    if (opts.some((o) => o.key === key)) opts.length = 0; // a new list restarts the numbering
    const label = m[3].replace(/\*\*|`/g, "").replace(/\s*[:：—–-]\s.*$/, "").trim();
    opts.push({ key, label: clip(`${key}. ${label}`, 48), text: m[1] ? `${key}번으로 진행해줘` : `${key}안으로 진행해줘` });
  }
  if (opts.length >= 2) return opts.slice(0, 6).map(({ label, text }) => ({ label, text }));
  return [
    { label: "네, 진행", text: "네, 진행해줘" },
    { label: "아니요", text: "아니요, 그건 하지 말아줘" },
  ];
}

/** The answer recommends a fresh conversation: it names `/clear`, or a new session/conversation with a recommendation. */
export function suggestsClear(texts) {
  const t = String(texts?.at(-1) ?? "");
  return /(^|[^\w/])\/clear\b/i.test(t) || /새\s*(세션|대화)[^\n]{0,24}(권|추천|시작하|여는|열어)/.test(t);
}

// ---- Text the agent's harness injects as a "user" turn (subagent reports, task notices): not the user's request ----

const NOTICE = /^\s*(?:<(?:task-notification|agent-message|system-reminder)[\s>]|\[SYSTEM NOTIFICATION)/;
export const isAgentNotice = (prompt) => NOTICE.test(String(prompt ?? ""));

// ---- CLI prompt suggestion: grey text in an otherwise empty input line ----

/**
 * cells: the input line after the prompt mark, as { ch, faint } (faint = dim or grey; the cursor block counts as faint).
 * Returns the suggestion only when every visible cell is faint, i.e. the user typed nothing. The idle placeholder
 * ('Try "…"') is a hint, not a suggestion.
 */
export function ghostSuggestion(cells) {
  const text = cells.map((c) => c.ch).join("").trim();
  if (!text || cells.some((c) => c.ch.trim() && !c.faint) || /^Try "/.test(text)) return null;
  return text;
}

/** The line of a tool error worth reading: tags and a bare "Exit code N" are skipped (the CLI shows the output). */
export function errorLine(err) {
  const lines = String(err ?? "").replace(/<\/?[a-z_]+>/gi, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !/^exit code \d+$/i.test(l)) ?? lines[0] ?? "";
  return line.length <= 160 ? line : line.slice(0, 159) + "…";
}

/**
 * The turn as the CLI showed it, in order: the agent's texts with runs of tools between them (spec 3.2 ④-1).
 * `pending` is the tool the hook just reported, which the transcript may not have yet.
 */
export function timeline(turn, pending) {
  const out = [];
  const texts = turn?.texts ?? [];
  const tools = turn?.tools ?? [];
  const step = (t) => ({ text: toolText({ tool: t.name, detail: t.detail }), error: t.error ? errorLine(t.error) : null, full: t.error ?? null });
  const push = (s) => (out.at(-1)?.kind === "tools" ? out.at(-1).items.push(s) : out.push({ kind: "tools", items: [s] }));
  let ti = 0;
  texts.forEach((text, i) => {
    for (; ti < tools.length && (tools[ti].at ?? 0) <= i; ti++) push(step(tools[ti]));
    out.push({ kind: "text", text });
  });
  for (; ti < tools.length; ti++) push(step(tools[ti]));
  const last = out.at(-1)?.kind === "tools" ? out.at(-1).items.at(-1).text : null;
  if (pending && pending !== last) push({ text: pending, error: null, full: null });
  return out;
}

/** Unified diff of one file → rows for the review view: hunk headers, then lines with old/new numbers. */
export function parseDiff(text) {
  const rows = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)/.exec(line);
    if (h) {
      [o, n, inHunk] = [+h[1], +h[2], true];
      rows.push({ kind: "hunk", text: h[3] });
    } else if (line.startsWith("diff --git")) {
      inHunk = false;
    } else if (!inHunk) {
      if (line.startsWith("Binary files")) rows.push({ kind: "meta", text: "바이너리 파일이 바뀌었습니다" });
    } else if (line[0] === "+") rows.push({ kind: "add", new: n++, text: line.slice(1) });
    else if (line[0] === "-") rows.push({ kind: "del", old: o++, text: line.slice(1) });
    else if (line[0] === " ") rows.push({ kind: "ctx", old: o++, new: n++, text: line.slice(1) });
  }
  return rows;
}

/** A file git doesn't know yet, shown as one all-added hunk. */
export function addedRows(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [{ kind: "hunk", text: "새 파일" }, ...lines.map((t, i) => ({ kind: "add", new: i + 1, text: t }))];
}

const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})(?:\/[^\s\x1b"'<>)]*)?/i;

/** Detect a local dev-server URL in terminal output (strips trailing punctuation). */
export function detectLocalhostUrl(text) {
  const m = LOCAL_URL_RE.exec(String(text ?? "").replace(/\x1b\[[0-9;]*m/g, ""));
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 80 || port > 65535) return null;
  return { url: m[0].replace(/[.,;:!?]+$/, ""), port };
}

export const DEFAULT_SNIPPETS = [
  { cmd: "/review", hint: "변경 코드 리뷰", prompt: "방금 변경된 코드를 검토하고 버그나 개선점을 알려줘." },
  { cmd: "/test", hint: "테스트 실행·수정", prompt: "테스트를 실행하고 실패하는 부분만 고쳐줘." },
  { cmd: "/fix", hint: "최근 오류 수정", prompt: "방금 발생한 오류 원인을 찾아 수정해줘." },
  { cmd: "/commit", hint: "변경사항 커밋", prompt: "지금까지 변경사항을 확인하고 적절한 커밋 메시지로 커밋해줘." },
];

/** Active `@query` token immediately before the cursor, or null if not typing a file mention. */
export function mentionToken(value, cursor = value.length) {
  const before = String(value ?? "").slice(0, cursor);
  const m = /(?:^|\s)(@([^\s@]*))$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[1].length, end: cursor, query: m[2] };
}

/** Normalize a project path and strip `-wtN` worktree suffix so sibling worktrees group together. */
export function repoFamily(root) {
  return String(root ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/-wt\d+$/i, "")
    .toLowerCase();
}

/**
 * Find overlapping modified files across cards sharing the same repository family.
 * Returns `{ [cardId]: [{ file, others: string[] }] }`.
 */
export function findFileConflicts(cards) {
  const groups = new Map();
  for (const c of cards) {
    const fam = repoFamily(c.root);
    if (!fam) continue;
    if (!groups.has(fam)) groups.set(fam, []);
    groups.get(fam).push(c);
  }
  const out = {};
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const byFile = new Map();
    for (const c of group) {
      for (const file of c.files ?? []) {
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push(c);
      }
    }
    for (const [file, owners] of byFile) {
      if (owners.length < 2) continue;
      for (const c of owners) {
        const others = owners.filter((o) => o.id !== c.id).map((o) => o.name);
        if (!others.length) continue;
        (out[c.id] ??= []).push({ file, others });
      }
    }
  }
  return out;
}

/** Format inline diff review comments into a single prompt for the agent. */
export function formatReviewComments(comments) {
  if (!comments?.length) return "";
  const lines = comments.map((c) => `- \`${c.rel}${c.line ? ` L${c.line}` : ""}\`: ${c.comment}`);
  return `다음 리뷰 코멘트를 반영해 주세요:\n${lines.join("\n")}\n`;
}

const SHELL_ERR_RE = /\b(error|failed|exception|traceback|panic|err!|fatal)\b|exit code [1-9]/i;

/** Pick the error-relevant tail of shell output, falling back to the last 30 lines. */
export function pickErrorLines(lines, maxLines = 30) {
  const clean = (lines ?? []).map((l) => String(l).trimEnd()).filter(Boolean);
  if (!clean.length) return "";
  const idx = clean.findLastIndex((l) => SHELL_ERR_RE.test(l));
  if (idx >= 0) {
    const start = Math.max(0, idx - 10);
    return clean.slice(start, Math.min(clean.length, start + maxLines)).join("\n");
  }
  return clean.slice(-maxLines).join("\n");
}
