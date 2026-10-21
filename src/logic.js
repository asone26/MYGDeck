// Pure helpers (no DOM, no Tauri) so they can be tested with `node --test`.

/** Auto preset (spec 3.0 ⑥): grid shape for the cards shown at full size. */
export function autoLayout(n) {
  return ["one", "one", "two", "three", "four"][n] ?? "many";
}

/**
 * Which cards get the main area and which are stacked in the narrow side column.
 * Up to 4 projects: full-size cards share the main area, shrunk ones move aside.
 * 5 or more: only the active card is large (Focus). Returns index lists.
 */
export function splitDeck(densities, active) {
  const all = densities.map((_, i) => i);
  if (densities.length >= 5) return { main: [active], side: all.filter((i) => i !== active) };
  const main = all.filter((i) => densities[i] === "full");
  if (!main.length) return { main: all, side: [] };
  return { main, side: all.filter((i) => densities[i] !== "full") };
}

const HUES = [28, 205, 135, 320, 52, 265, 175, 0, 95, 235];

/**
 * Per-project color (spec 3.0 ③). The name picks a preferred color so a project usually keeps
 * its color, but open projects never share one: the point is not confusing two cards.
 */
export function projectColor(name, used = []) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const colors = HUES.map((hue) => `hsl(${hue} 72% 62%)`);
  for (let k = 0; k < colors.length; k++) {
    const c = colors[(h + k) % colors.length];
    if (!used.includes(c)) return c;
  }
  return colors[h % colors.length];
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

/**
 * Physical key code. `code` keeps shortcuts working under the Korean IME; synthesized input
 * (SendKeys, some remote tools) leaves it empty, so fall back to the typed key then.
 */
export function keyCode(e) {
  if (e.code) return e.code;
  const k = e.key ?? "";
  if (/^[a-z]$/i.test(k)) return "Key" + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return "Digit" + k;
  return { "=": "Equal", "+": "Equal", "-": "Minus" }[k] ?? k;
}

export function isDeckKey(e) {
  return e.altKey && !e.ctrlKey && !e.metaKey && DECK_KEYS.has(keyCode(e));
}

export const DENSITIES = ["mini", "compact", "full"];

export function basename(p) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}
