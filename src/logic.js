// Pure helpers (no DOM, no Tauri) so they can be tested with `node --test`.

/** Auto preset (spec 3.0 ⑥): layout name for a project count. */
export function autoLayout(n) {
  return ["one", "one", "two", "three", "four"][n] ?? "focus";
}

/** Stable per-project color so the same project always looks the same (spec 3.0 ③). */
export function projectColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 62%)`;
}

export const BADGE = { starting: "[ ]", idle: "[-]", working: "[*]", waiting: "[!]", done: "[v]", exited: "[x]" };

const PERMISSION = /permission|approve|허용|승인/i;

/** Map an agent hook event to a card status. Returns null when the event changes nothing. */
export function hookStatus(event, data, current) {
  switch (event) {
    case "prompt":
      return { status: "working", text: "작업 중" };
    case "tool":
      return { status: "working", text: toolText(data) };
    case "notify": {
      const msg = data?.message || "입력 대기";
      // An idle reminder after the agent finished is not a new request for the user.
      if (!PERMISSION.test(msg) && current === "done") return null;
      return { status: "waiting", text: msg };
    }
    case "stop":
      return { status: "done", text: "완료" };
    default:
      return null;
  }
}

function toolText(d) {
  const tool = d?.tool || "작업";
  if (!d?.detail) return tool;
  const s = String(d.detail);
  const base = s.split(/[\\/]/).pop();
  const shown = s.length <= 40 ? s : base.length <= 40 ? base : s.slice(0, 39) + "…";
  return `${tool} ${shown}`;
}

/** Next other card needing the user: waiting first, then done (spec 3.0 ⑧). -1 if none. */
export function nextAttention(statuses, active) {
  const n = statuses.length;
  for (const want of ["waiting", "done"]) {
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

/** Alt shortcuts owned by the deck; everything else goes to the CLI (spec 3.3). */
export const DECK_KEYS = new Set([
  "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
  "KeyJ", "KeyO", "Equal", "Minus", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "KeyI", "KeyT", "KeyN", "KeyW",
]);

export function isDeckKey(e) {
  return e.altKey && !e.ctrlKey && !e.metaKey && DECK_KEYS.has(e.code);
}

export const DENSITIES = ["mini", "compact", "full"];

export function basename(p) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}
