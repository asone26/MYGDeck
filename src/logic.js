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

// Soft, mid-saturation tones that read well on the dark UI without glowing.
const COLORS = ["#e3a06b", "#7aa6da", "#86bfa0", "#c79bd9", "#e08c8c", "#d6be76", "#6fbfc0", "#a3a8e8", "#b8c77a", "#e39bb6"];

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

export const BADGE = { starting: "[ ]", idle: "[-]", working: "[*]", waiting: "[!]", failed: "[x]", exited: "[off]" };

const PERMISSION = /permission|approve|허용|승인/i;

/** Map an agent hook event to a card status. Returns null when the event changes nothing. */
export function hookStatus(event, data, current) {
  switch (event) {
    case "prompt":
      return { status: "working", text: "작업 중" };
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

function toolText(d) {
  const tool = d?.tool || "작업";
  if (!d?.detail) return tool;
  const s = String(d.detail);
  const base = s.split(/[\\/]/).pop();
  const shown = s.length <= 40 ? s : base.length <= 40 ? base : s.slice(0, 39) + "…";
  return `${tool} ${shown}`;
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
  "KeyI", "Equal", "Minus",
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

export function isDeckKey(e) {
  return !!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && DECK_KEYS.has(keyCode(e));
}

export const DENSITIES = ["mini", "compact", "full"];

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** On-screen markers of an interactive CLI menu the user must answer in the raw CLI. */
export const MENU = /Enter to confirm|Esc to cancel|❯\s*\d+\.|\(y\/n\)|\[y\/N\]|\[Y\/n\]/i;

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

export const ROUTE_CHIP = { cli: "⌨ cli", ask: "?? ask", code: "🛠 code", deep: "🧠 deep", search: "🔍 search" };
/** Tab cycles the paths the deck can currently reach. */
export const nextRoute = (route, reachable) => reachable[(reachable.indexOf(route) + 1) % reachable.length];
