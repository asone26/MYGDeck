import "@xterm/xterm/css/xterm.css";
import "highlight.js/styles/github-dark.css";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Card } from "./card.js";
import { openConnections, refreshPool } from "./connections.js";
import { ptys, setTermFontSize, setTermTheme } from "./pty.js";
import { exportMarkdown } from "./summary.js";
import { ICONS, icon, statusIcon } from "./icons.js";
import { DENSITIES, autoLayout, fuzzyFilter, IS_MAC, isDeckKey, isDeckMod, keyCode, keyLabel, nextAttention, splitDeck } from "./logic.js";

const $ = (id) => document.getElementById(id);
const deck = $("deck");
const overlay = $("overlay");

const app = {
  cards: [],
  active: 0,
  adapters: [],
  shell: "",
  source: "",
  setActive,
  closeCard,
  renderStrip,
  live: [],
  takeLive,
  save,
  addCard,
  layout,
  onStatus,
  onTestFail,
  onPeek: () => overlayKind === "overview" && renderOverview(),
};

let overlayKind = null;
let overviewSel = 0;

// ---- Motion: cards glide to new places, each project lights the sky behind its card ----

const calm = matchMedia("(prefers-reduced-motion: reduce)");
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
let booting = true; // cards restored at startup come in together once, not one by one

/** FLIP: cards that changed place slide from where they were; new cards rise in. */
function animateMoves(before) {
  if (booting || calm.matches) return;
  for (const [c, r] of before) {
    if (!c.el.isConnected) continue;
    if (!r) {
      c.el.animate([{ opacity: 0, transform: "translateY(16px) scale(0.97)" }, { opacity: 1, transform: "none" }], { duration: 520, easing: EASE });
      continue;
    }
    const n = c.el.getBoundingClientRect();
    const [dx, dy] = [r.left - n.left, r.top - n.top];
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) c.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 480, easing: EASE });
  }
}

const orbs = new Map(); // key → light element in #aura
// Lights for the empty deck, in project colors.
const IDLE_LIGHTS = [["#a98cf0", 0.26, 0.7], ["#7aa6da", 0.74, 0.36], ["#6fbfc0", 0.55, 1.0]];

/** One light per project, centered behind its card; brighter for the active card, amber while it waits. */
function updateAura() {
  const lights = app.cards.length
    ? app.cards.slice(0, 8).map((c, i) => {
        const r = c.el.getBoundingClientRect();
        const o = c.status === "waiting" ? 0.85 : i === app.active ? 0.75 : 0.45;
        return { key: c.id, color: c.color, status: c.status, x: r.left + r.width / 2, y: r.top + r.height * 0.45, s: Math.max(0.35, Math.max(r.width, r.height) / 850), o };
      })
    : IDLE_LIGHTS.map(([color, x, y], i) => ({ key: `idle${i}`, color, status: "idle", x: x * innerWidth, y: y * innerHeight, s: 1, o: 0.6 }));
  const keep = new Set(lights.map((l) => l.key));
  for (const [key, el] of orbs) {
    if (keep.has(key) || el.dataset.dead) continue;
    el.dataset.dead = "1";
    el.style.setProperty("--o", 0);
    setTimeout(() => el.dataset.dead && (el.remove(), orbs.delete(key)), 900);
  }
  for (const l of lights) {
    let el = orbs.get(l.key);
    if (!el) {
      el = document.createElement("div");
      el.className = "orb";
      el.style.setProperty("--o", 0); // fade in from nothing at its place
      el.style.setProperty("--x", `${l.x}px`);
      el.style.setProperty("--y", `${l.y}px`);
      $("aura").append(el);
      orbs.set(l.key, el);
      el.getBoundingClientRect(); // commit the start state so the fade-in transitions
    }
    delete el.dataset.dead;
    el.dataset.status = l.status;
    el.style.setProperty("--c", l.color);
    el.style.setProperty("--x", `${l.x}px`);
    el.style.setProperty("--y", `${l.y}px`);
    el.style.setProperty("--s", l.s.toFixed(3));
    el.style.setProperty("--o", l.o);
  }
}

const glider = document.createElement("span");
glider.className = "glider still";
glider.setAttribute("aria-hidden", "true");

/** The active chip's lit pill slides to the newly active chip. */
function moveGlider() {
  const on = $("chips").querySelector(".chip.on");
  if (!on) return (glider.style.opacity = 0);
  const s = $("strip").getBoundingClientRect();
  const r = on.getBoundingClientRect();
  glider.style.setProperty("--pc", app.cards[app.active]?.color ?? "var(--work)");
  Object.assign(glider.style, { opacity: 1, width: `${r.width}px`, height: `${r.height}px`, transform: `translate(${r.left - s.left}px, ${r.top - s.top}px)` });
  if (glider.classList.contains("still")) requestAnimationFrame(() => requestAnimationFrame(() => glider.classList.remove("still")));
}

let reflowQueued = false;
function reflowLights() {
  if (reflowQueued) return;
  reflowQueued = true;
  requestAnimationFrame(() => {
    reflowQueued = false;
    updateAura();
    moveGlider();
  });
}
window.addEventListener("resize", reflowLights);

// Theme: dark (default) or light. A per-machine preference, kept in the window's storage.
const THEMES = { dark: ["다크", ICONS.Moon], light: ["밝게", ICONS.Sun] };
let themePref = (() => {
  try {
    return THEMES[localStorage.getItem("mygdeck.theme")] ? localStorage.getItem("mygdeck.theme") : "dark";
  } catch {
    return "dark";
  }
})();

function applyTheme() {
  const light = themePref === "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  setTermTheme(light);
  getCurrentWindow().setTheme(light ? "light" : "dark").catch(() => {});
  const btn = $("theme-btn");
  if (!btn) return;
  const order = Object.keys(THEMES);
  const next = order[(order.indexOf(themePref) + 1) % order.length];
  btn.innerHTML = icon(THEMES[themePref][1]);
  btn.title = `테마: ${THEMES[themePref][0]} · 누르면 ${THEMES[next][0]}`;
}
applyTheme();

function cycleTheme() {
  const order = Object.keys(THEMES);
  themePref = order[(order.indexOf(themePref) + 1) % order.length];
  try {
    localStorage.setItem("mygdeck.theme", themePref);
  } catch {}
  applyTheme();
}

async function boot() {
  $("theme-btn").onclick = cycleTheme;
  applyFontSize(Number(localStorage.getItem("mygdeck-font-size") || 14));
  const addBtn = document.getElementById("add-btn");
  addBtn.title = keyLabel(addBtn.title);
  addBtn.innerHTML = icon(ICONS.Plus);
  $("keys-btn").innerHTML = icon(ICONS.Keyboard);
  $("conn-btn").innerHTML = icon(ICONS.KeyRound);
  await listen("pty-data", (e) => ptys.get(e.payload.id)?.received(e.payload.data, !!e.payload.replay));
  await listen("pty-exit", (e) => ptys.get(e.payload.id)?.exited(e.payload.code));
  await listen("daemon-lost", () => [...ptys.values()].forEach((p) => p.exited(null)));
  // Sessions that kept running in the daemon while the window was closed (or reloading).
  const [loaded, adapters, shell, live] = await Promise.all([
    invoke("load_config"),
    invoke("list_adapters"),
    invoke("default_shell"),
    invoke("pty_list").catch((e) => {
      console.error("session daemon unavailable", e);
      return [];
    }),
  ]);
  Object.assign(app, { adapters, shell, source: loaded.source, live });
  await listen("agent-hook", (e) => app.cards.find((c) => c.agent.id === e.payload.id)?.onHook(e.payload.event, e.payload.data));
  await listen("deck-add-project", (e) => typeof e.payload?.path === "string" && openProject(e.payload.path));
  await listen("fs-change", (e) => app.cards.find((c) => c.id === e.payload)?.onFsChange());
  getCurrentWindow().onDragDropEvent((e) => {
    if (e.payload?.type !== "drop" || !e.payload.paths?.length) return;
    const pos = e.payload.position;
    const el = pos ? document.elementFromPoint(pos.x / devicePixelRatio, pos.y / devicePixelRatio)?.closest?.(".card") : null;
    const target = app.cards.find((c) => c.el === el) ?? app.cards[app.active];
    target?.composer.insertPaths(e.payload.paths);
  }).catch(() => {});
  refreshPool();
  $("add-btn").onclick = addProject;
  $("add-first").onclick = addProject;
  $("add-first").querySelector("kbd").textContent = keyLabel("Ctrl+'");
  $("strip").prepend(glider);
  $("grid").addEventListener("scroll", reflowLights, { passive: true });
  $("keys-btn").onclick = openShortcuts;
  $("conn-btn").onclick = () => {
    overlayKind = "connections";
    overlay.hidden = false;
    openConnections(overlay);
  };
  for (const p of loaded.config.projects) addCard(p, false, true);
  // Sessions of projects that are no longer in the deck would run unseen forever.
  for (const s of app.live) if (!app.cards.some((c) => s.id.startsWith(`${c.root}#`))) invoke("pty_kill", { id: s.id }).catch(() => {});
  app.active = 0;
  layout();
  booting = false;
  // One orchestrated entrance for the restored deck.
  if (!calm.matches) {
    app.cards.forEach((c, i) =>
      c.el.animate([{ opacity: 0, transform: "translateY(24px) scale(0.98)" }, { opacity: 1, transform: "none" }], { duration: 700, delay: 80 + i * 70, easing: EASE, fill: "backwards" }),
    );
  }
  app.cards[0]?.focusDefault();
}

// ---- Attention (A3): a project that needs the user reaches them even when the deck is in the background ----

const NOTIFY_GAP = 5000;
let notifyAllowed = null;
let jumpTo = null; // card to show when the user comes back to the window

let audioCtx = null;
function playChime(kind) {
  if (localStorage.getItem("mygdeck-sound") === "off") return;
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const notes = kind === "waiting" ? [587.33, 783.99] : [523.25, 659.25];
    notes.forEach((freq, idx) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + idx * 0.09);
      gain.gain.setValueAtTime(0.0001, now + idx * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.05, now + idx * 0.09 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.09 + 0.22);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + idx * 0.09);
      osc.stop(now + idx * 0.09 + 0.24);
    });
  } catch {}
}

async function onStatus(card, prev) {
  if (card.cfg?.muted) return;
  if (!["waiting", "done"].includes(card.status) || card.rotating || prev === "starting") return;
  if (card.status === "done" && card.queue.length) return; // the next queued input goes on by itself
  if (document.hasFocus()) return; // the header strip already shows it
  if (Date.now() - (card.notifiedAt ?? 0) < NOTIFY_GAP) return;
  card.notifiedAt = Date.now();
  playChime(card.status);
  if (card.status === "waiting" || !jumpTo) jumpTo = card; // a permission prompt outranks a finished turn
  const win = getCurrentWindow();
  win.requestUserAttention(card.status === "waiting" ? UserAttentionType.Critical : UserAttentionType.Informational).catch(() => {});
  notifyAllowed ??= (await isPermissionGranted().catch(() => false)) || (await requestPermission().catch(() => "denied")) === "granted";
  if (!notifyAllowed) return;
  const what = card.status === "waiting" ? card.statusText || "입력을 기다립니다" : `완료${card.turnAsk ? `: ${card.turnAsk.slice(0, 80)}` : ""}`;
  sendNotification({ title: `MYG Deck · ${card.name}`, body: what });
}

async function onTestFail(card, res) {
  if (card.cfg?.muted || document.hasFocus()) return;
  notifyAllowed ??= (await isPermissionGranted().catch(() => false)) || (await requestPermission().catch(() => "denied")) === "granted";
  if (notifyAllowed) sendNotification({ title: `MYG Deck · ${card.name} 검증 실패`, body: `종료 코드 ${res.code}: ${card.cfg.post_turn_cmd}` });
}

window.addEventListener("focus", () => {
  const c = jumpTo;
  jumpTo = null;
  const i = app.cards.indexOf(c);
  if (i >= 0 && ["waiting", "done"].includes(c.status)) setActive(i);
});

/** A running daemon session for `key` (project + role), handed out once. */
function takeLive(key) {
  const i = app.live.findIndex((s) => s.id.startsWith(`${key}|`));
  return i < 0 ? null : app.live.splice(i, 1)[0];
}

function adapterFor(cfg) {
  if (cfg.command) return null;
  const want = cfg.agent ?? app.adapters.find((a) => a.detected)?.name;
  return app.adapters.find((a) => a.name === want) ?? null;
}

/** `restore`: the card comes back from the saved deck, so its agent reopens the last conversation. */
function addCard(cfg, persist = true, restore = false) {
  const card = new Card(app, cfg, adapterFor(cfg));
  app.cards.push(card);
  dragToSwap(card);
  app.active = app.cards.length - 1;
  layout();
  // Start after layout so the terminal knows its real size.
  requestAnimationFrame(() => card.start({ resume: restore }));
  if (persist) save();
}

/** Drag a card by its header onto another card to swap their places. */
function dragToSwap(card) {
  const head = card.el.querySelector(".head");
  head.draggable = true;
  head.ondragstart = (e) => {
    e.dataTransfer.setData("text/x-card", String(app.cards.indexOf(card)));
    e.dataTransfer.effectAllowed = "move";
  };
  card.el.ondragover = (e) => {
    if (!e.dataTransfer.types.includes("text/x-card")) return;
    e.preventDefault();
    card.el.classList.add("drop");
  };
  card.el.ondragleave = (e) => !card.el.contains(e.relatedTarget) && card.el.classList.remove("drop");
  card.el.ondrop = (e) => {
    card.el.classList.remove("drop");
    const i = Number(e.dataTransfer.getData("text/x-card"));
    const j = app.cards.indexOf(card);
    if (!app.cards[i] || i === j) return;
    e.preventDefault();
    [app.cards[i], app.cards[j]] = [app.cards[j], app.cards[i]];
    app.active = j;
    layout();
    save();
  };
}

async function addProject() {
  const dir = await openDialog({ directory: true, title: "프로젝트 폴더 선택", defaultPath: "C:\\Project" }).catch(() => null);
  if (typeof dir === "string") openProject(dir);
}

/** Add a folder as a project, or show it if the deck already has it (the + button and the phone). */
function openProject(dir) {
  const same = (p) => p.replace(/[\\/]+$/, "").toLowerCase() === dir.replace(/[\\/]+$/, "").toLowerCase();
  const existing = app.cards.findIndex((c) => same(c.root));
  if (existing >= 0) return setActive(existing);
  addCard({ path: dir });
  requestAnimationFrame(() => app.cards.at(-1)?.focusDefault());
}

async function closeCard(card) {
  const busy = card.status === "working" || card.status === "waiting";
  if (busy && !(await ask(`${card.name}: 에이전트가 작업 중입니다. 닫으면 작업이 중단됩니다.`, { title: "프로젝트 닫기", kind: "warning", okLabel: "닫기", cancelLabel: "취소" }))) return;
  if (!calm.matches) {
    await card.el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.96)" }], { duration: 220, easing: "ease-in", fill: "forwards" }).finished.catch(() => {});
  }
  const i = app.cards.indexOf(card);
  if (i < 0) return; // closed twice while the exit played
  rememberRecent(card.root);
  card.dispose();
  app.cards.splice(i, 1);
  app.active = Math.max(0, Math.min(app.active, app.cards.length - 1));
  layout();
  save();
  app.cards[app.active]?.focusDefault();
}

function save() {
  invoke("save_config", { source: app.source, projects: app.cards.map((c) => c.cfg) }).catch((e) => console.error("save failed", e));
}

function layout() {
  const before = new Map(app.cards.map((c) => [c, c.el.isConnected ? c.el.getBoundingClientRect() : null]));
  const { main, side } = splitDeck(app.cards.map((c) => c.density), app.active);
  place($("grid"), main);
  place($("side"), side);
  $("grid").dataset.layout = autoLayout(main.length);
  app.cards.forEach((c, i) => {
    c.setIndex(i);
    c.el.classList.toggle("active", i === app.active);
  });
  deck.hidden = app.cards.length === 0;
  $("empty").hidden = app.cards.length > 0;
  if (app.cards.length === 0) renderEmptyExtra();
  animateMoves(before);
  renderStrip();
}

/** Move cards into a container in order, touching the DOM only when something changed. */
function place(box, indexes) {
  const want = indexes.map((i) => app.cards[i].el);
  if (want.length === box.children.length && want.every((el, i) => box.children[i] === el)) return;
  box.append(...want);
}

function setActive(i, focus = true) {
  if (i < 0 || i >= app.cards.length) return;
  if (i !== app.active) {
    app.active = i;
    layout();
  }
  const c = app.cards[i];
  c.el.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (focus) c.focusDefault();
}

/** Header strip: every project's state on one line, including cards scrolled out of view (spec 3.0 ①). */
function renderStrip() {
  const chips = $("chips");
  chips.textContent = "";
  app.cards.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "chip" + (i === app.active ? " on" : "");
    b.dataset.status = c.status;
    b.style.setProperty("--pc", c.color);
    b.title = `#${i + 1} ${c.root}\n${c.statusText}`;
    b.innerHTML = `<span class="dot"></span><span class="cn"></span><span class="cx" title="${keyLabel("닫기 (Ctrl+F4)")}">${icon(ICONS.X)}</span>`;
    b.querySelector(".cn").textContent = c.name;
    b.onclick = (e) => (e.target.closest(".cx") ? closeCard(c) : setActive(i));
    b.draggable = true;
    b.ondragstart = (e) => e.dataTransfer.setData("text/x-card", String(i));
    b.ondragover = (e) => { if (e.dataTransfer.types.includes("text/x-card")) e.preventDefault(); };
    b.ondrop = (e) => {
      const from = Number(e.dataTransfer.getData("text/x-card"));
      if (!app.cards[from] || from === i) return;
      e.preventDefault();
      [app.cards[from], app.cards[i]] = [app.cards[i], app.cards[from]];
      app.active = i;
      layout();
      save();
    };
    chips.append(b);
  });
  moveGlider();
  updateAura();
}

function closeOverlay() {
  overlay.hidden = true;
  overlay.textContent = "";
  overlay.classList.remove("still");
  overlayKind = null;
}

function toggleOverview() {
  if (overlayKind === "overview") return closeOverlay();
  overviewSel = app.active;
  overlayKind = "overview";
  overlay.hidden = false;
  app.cards.forEach((c) => c.updatePeek());
  renderOverview();
}

/** Ctrl+0: every project as a tile on one screen (spec 3.0 ⑦). */
function renderOverview() {
  // Rebuilt on every peek and key press: only the first build plays the entrance.
  overlay.classList.toggle("still", !!overlay.querySelector(".ov"));
  overlay.innerHTML = `<div class="ov"><div class="ov-title">전체 보기 · 방향키 이동 · Enter 열기 · Esc 닫기</div><div class="ov-grid"></div></div>`;
  const grid = overlay.querySelector(".ov-grid");
  app.cards.forEach((c, i) => {
    const t = document.createElement("button");
    t.className = "tile" + (i === overviewSel ? " on" : "");
    t.dataset.status = c.status;
    t.style.setProperty("--pc", c.color);
    t.style.setProperty("--i", i);
    t.innerHTML = `<div class="th"><span class="dot"></span><b></b><span class="cb"></span></div><div class="tt"></div><pre class="tp"></pre>`;
    t.querySelector("b").textContent = `#${i + 1} ${c.name}`;
    t.querySelector(".cb").innerHTML = statusIcon(c.status);
    const statText = c.stats?.turns ? ` · ${c.stats.turns}턴 (${Math.max(1, Math.round(c.stats.totalMs / 60000))}분)` : "";
    t.querySelector(".tt").textContent = `${c.statusText}${statText}`;
    t.querySelector(".tp").textContent = c.peek.join("\n");
    t.onclick = () => {
      closeOverlay();
      setActive(i);
    };
    grid.append(t);
  });
}

/** Ctrl+P: open any file of the active project in the code viewer. */
async function quickOpen() {
  const c = app.cards[app.active];
  if (!c) return;
  overlayKind = "quick";
  overlay.hidden = false;
  overlay.innerHTML = `<div class="qo"><div class="qo-title"></div><input class="qo-in" placeholder="파일 이름 일부 입력" spellcheck="false"><ul class="qo-list"></ul></div>`;
  overlay.querySelector(".qo-title").textContent = `${c.name} · 파일 열기`;
  const input = overlay.querySelector("input");
  const ul = overlay.querySelector("ul");
  input.focus();
  const files = await c.fileList();
  let sel = 0;
  let shown = [];
  const pick = (f) => {
    closeOverlay();
    if (c.density !== "full") {
      c.setDensity("full");
      layout();
    }
    c.viewer.open(f);
  };
  const draw = () => {
    shown = fuzzyFilter(input.value, files);
    ul.textContent = "";
    shown.forEach((f, i) => {
      const li = document.createElement("li");
      li.textContent = f;
      if (i === sel) li.className = "on";
      li.onmousedown = (e) => {
        e.preventDefault();
        pick(f);
      };
      ul.append(li);
    });
  };
  input.oninput = () => {
    sel = 0;
    draw();
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(0, Math.min(shown.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
      draw();
      ul.children[sel]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && shown[sel]) {
      pick(shown[sel]);
    }
  };
  draw();
}

function renderEmptyExtra() {
  const box = $("empty-extra");
  if (!box) return;
  box.textContent = "";
  const recent = loadRecent().slice(0, 5);
  if (recent.length) {
    const sec = document.createElement("div");
    sec.className = "empty-sec";
    sec.innerHTML = `<span class="empty-lbl">최근 프로젝트</span>`;
    const row = document.createElement("div");
    row.className = "empty-pills";
    for (const p of recent) {
      const b = document.createElement("button");
      b.textContent = p.split(/[\\/]/).pop() || p;
      b.title = p;
      b.onclick = () => openProject(p);
      row.append(b);
    }
    sec.append(row);
    box.append(sec);
  }
  if (app.adapters?.length) {
    const sec = document.createElement("div");
    sec.className = "empty-sec";
    sec.innerHTML = `<span class="empty-lbl">감지된 에이전트</span>`;
    const row = document.createElement("div");
    row.className = "empty-pills";
    for (const a of app.adapters) {
      const s = document.createElement("span");
      s.className = `empty-agent ${a.detected ? "on" : ""}`;
      s.textContent = `${a.detected ? "●" : "○"} ${a.name}`;
      row.append(s);
    }
    sec.append(row);
    box.append(sec);
  }
}

function loadRecent() {
  try { return JSON.parse(localStorage.getItem("mygdeck-recent") || "[]"); } catch { return []; }
}

function rememberRecent(path) {
  const same = (a, b) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
  const next = [path, ...loadRecent().filter((p) => !same(p, path))].slice(0, 8);
  localStorage.setItem("mygdeck-recent", JSON.stringify(next));
}

let fontSize = 14;
function applyFontSize(px) {
  fontSize = Math.max(11, Math.min(20, Number(px) || 14));
  localStorage.setItem("mygdeck-font-size", String(fontSize));
  document.documentElement.style.fontSize = `${fontSize}px`;
  setTermFontSize(fontSize - 1);
}

function openPalette() {
  if (overlayKind === "palette") return closeOverlay();
  overlayKind = "palette";
  overlay.hidden = false;
  const c = app.cards[app.active];
  const actions = [
    ...app.cards.map((card, idx) => ({ label: `프로젝트 이동: ${card.name}`, hint: `#${idx + 1}`, run: () => setActive(idx) })),
    { label: "프로젝트 폴더 추가", hint: keyLabel("Ctrl+'"), run: addProject },
    { label: "여러 프로젝트에 동시 지시 (브로드캐스트)", hint: "비교 실행", run: openBroadcast },
    ...(c ? [
      { label: `${c.name}: 파일 빠른 열기`, hint: keyLabel("Ctrl+P"), run: quickOpen },
      { label: `${c.name}: 프로젝트 코드 내용 검색`, hint: keyLabel("Ctrl+Shift+F"), run: openCodeSearch },
      { label: `${c.name}: 화면 내 텍스트 검색`, hint: keyLabel("Ctrl+F"), run: openFind },
      { label: `${c.name}: 스펙 패널 열기/닫기`, hint: keyLabel("Ctrl+;"), run: () => c.toggleSpec() },
      { label: `${c.name}: 하단 터미널 열기/닫기`, hint: keyLabel("Ctrl+`"), run: () => c.toggleShell() },
      { label: `${c.name}: GUI / CLI 화면 전환`, hint: keyLabel("Ctrl+."), run: () => c.toggleView() },
      { label: `${c.name}: 대화 내용 마크다운 복사`, hint: "내보내기", run: () => navigator.clipboard.writeText(exportMarkdown(c)).catch(() => {}) },
      { label: `${c.name}: 이전 턴 상태로 되돌리기 (체크포인트)`, hint: c.turnCheckpoint ? "복원 가능" : "없음", run: () => c.restoreCheckpoint() },
      { label: `${c.name}: 수동 세션 핸드오프 (progress.md → 새 대화)`, hint: "컨텍스트", run: () => c.manualHandoff() },
      { label: `${c.name}: worktree로 하나 더 열기`, hint: "병렬", run: () => c.openWorktree() },
      { label: `${c.name}: 프로젝트 자동화 · 알림 설정`, hint: c.cfg.muted ? "음소거됨" : "훅/검증", run: () => openProjectSettings(c) },
      { label: `${c.name}: 알림 ${c.cfg.muted ? "켜기" : "음소거"}`, hint: "알림", run: () => { c.cfg.muted = !c.cfg.muted; save(); } },
    ] : []),
    ...loadRecent()
      .filter((p) => !app.cards.some((card) => card.root.replace(/[\\/]+$/, "").toLowerCase() === p.replace(/[\\/]+$/, "").toLowerCase()))
      .map((p) => ({ label: `최근 닫은 프로젝트 열기: ${p.split(/[\\/]/).pop()}`, hint: p, run: () => openProject(p) })),
    { label: "전체 보기", hint: keyLabel("Ctrl+0"), run: toggleOverview },
    { label: "글자 크기 크게 (+1px)", hint: `${fontSize}px`, run: () => applyFontSize(fontSize + 1) },
    { label: "글자 크기 작게 (-1px)", hint: `${fontSize}px`, run: () => applyFontSize(fontSize - 1) },
    { label: "글자 크기 기본 (14px)", hint: "초기화", run: () => applyFontSize(14) },
    { label: "모바일 대시보드 연결 안내", hint: "원격", run: openMobileGuide },
    { label: "AI 연결 설정", hint: "모델", run: () => $("conn-btn").click() },
    { label: "테마 바꾸기 (다크 / 밝게 / 시스템)", hint: "테마", run: cycleTheme },
    { label: `알림 효과음 ${localStorage.getItem("mygdeck-sound") === "off" ? "켜기" : "끄기"}`, hint: "오디오", run: () => localStorage.setItem("mygdeck-sound", localStorage.getItem("mygdeck-sound") === "off" ? "on" : "off") },
    { label: "키보드 단축키 보기", hint: "도움말", run: openShortcuts },
  ];
  overlay.innerHTML = `<div class="qo pal"><div class="qo-title">커맨드 팔레트 · ${keyLabel("Ctrl+K")}</div><input class="qo-in" placeholder="실행할 명령이나 프로젝트 이름 입력…" spellcheck="false"><ul class="qo-list"></ul></div>`;
  const input = overlay.querySelector("input");
  const ul = overlay.querySelector("ul");
  let matches = actions;
  let sel = 0;
  const draw = () => {
    ul.textContent = "";
    matches.slice(0, 14).forEach((item, i) => {
      const li = document.createElement("li");
      if (i === sel) li.className = "sel";
      const sp = document.createElement("span");
      sp.textContent = item.label;
      const hint = document.createElement("span");
      hint.className = "pal-hint";
      hint.textContent = item.hint;
      li.append(sp, hint);
      li.onmousedown = () => { closeOverlay(); item.run(); };
      ul.append(li);
    });
  };
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    matches = q ? actions.filter((a) => `${a.label} ${a.hint}`.toLowerCase().includes(q)) : actions;
    sel = 0;
    draw();
  };
  input.onkeydown = (e) => {
    const n = Math.min(matches.length, 14);
    if (e.key === "ArrowDown" && n) { e.preventDefault(); sel = (sel + 1) % n; draw(); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); sel = (sel - 1 + n) % n; draw(); }
    else if (e.key === "Enter" && matches[sel]) { e.preventDefault(); const item = matches[sel]; closeOverlay(); item.run(); }
  };
  draw();
  input.focus();
}

function openBroadcast() {
  if (!app.cards.length) return;
  overlayKind = "broadcast";
  overlay.hidden = false;
  const box = document.createElement("div");
  box.className = "qo mod-box";
  box.innerHTML = `<div class="keys-head"><span class="qo-title">여러 프로젝트에 동시 지시 (브로드캐스트)</span><button class="keys-close" aria-label="닫기">${icon(ICONS.X)}</button></div>
    <div class="mod-list"></div>
    <textarea class="mod-ta" rows="4" placeholder="선택한 모든 카드에 동시에 보낼 지시를 입력하세요…"></textarea>
    <div class="mod-foot"><button class="mod-send">선택한 카드에 전송</button></div>`;
  box.querySelector(".keys-close").onclick = closeOverlay;
  const list = box.querySelector(".mod-list");
  app.cards.forEach((c, i) => {
    const lbl = document.createElement("label");
    lbl.className = "mod-chk";
    lbl.innerHTML = `<input type="checkbox" value="${i}" checked> <span>${c.name}</span> <small class="muted">${c.adapter?.name ?? "custom"}</small>`;
    list.append(lbl);
  });
  const ta = box.querySelector(".mod-ta");
  box.querySelector(".mod-send").onclick = () => {
    const text = ta.value.trim();
    if (!text) return;
    const targets = [...list.querySelectorAll("input:checked")].map((el) => app.cards[Number(el.value)]).filter(Boolean);
    closeOverlay();
    for (const card of targets) card.sendToAgent(text);
  };
  overlay.replaceChildren(box);
  ta.focus();
}

function openProjectSettings(card) {
  overlayKind = "proj-settings";
  overlay.hidden = false;
  const box = document.createElement("div");
  box.className = "qo mod-box";
  box.innerHTML = `<div class="keys-head"><span class="qo-title">${card.name} · 자동화 및 알림 설정</span><button class="keys-close" aria-label="닫기">${icon(ICONS.X)}</button></div>
    <label class="mod-field"><span>Worktree 생성 시 실행할 명령 (예: <code>npm ci</code>)</span><input class="qo-in f-wt" placeholder="비워 두면 .env 파일만 자동 복사"></label>
    <label class="mod-field"><span>턴 종료 후 자동 검증 명령 (예: <code>npm test</code>)</span><input class="qo-in f-pt" placeholder="비워 두면 실행 안 함"></label>
    <label class="mod-chk"><input type="checkbox" class="f-mute"> <span>이 프로젝트의 OS 알림 음소거</span></label>
    <div class="mod-foot"><button class="mod-send">저장</button></div>`;
  box.querySelector(".keys-close").onclick = closeOverlay;
  const wt = box.querySelector(".f-wt");
  const pt = box.querySelector(".f-pt");
  const mute = box.querySelector(".f-mute");
  wt.value = card.cfg.worktree_setup ?? "";
  pt.value = card.cfg.post_turn_cmd ?? "";
  mute.checked = !!card.cfg.muted;
  box.querySelector(".mod-send").onclick = () => {
    card.cfg.worktree_setup = wt.value.trim() || undefined;
    card.cfg.post_turn_cmd = pt.value.trim() || undefined;
    card.cfg.muted = mute.checked || undefined;
    save();
    closeOverlay();
  };
  overlay.replaceChildren(box);
  wt.focus();
}

function openMobileGuide() {
  overlayKind = "mobile-guide";
  overlay.hidden = false;
  const url = "https://mygdeck.asone26g.workers.dev";
  const box = document.createElement("div");
  box.className = "qo mod-box";
  box.innerHTML = `<div class="keys-head"><span class="qo-title">모바일 대시보드 연결 안내</span><button class="keys-close" aria-label="닫기">${icon(ICONS.X)}</button></div>
    <p class="mod-p">PC 데몬을 Cloudflare 터널로 연결해 휴대폰에서 상태 확인·승인·지시 전송을 할 수 있습니다.</p>
    <div class="mod-row"><code>${url}</code><button class="mod-copy">주소 복사</button></div>
    <ol class="mod-steps">
      <li>터미널에서 <code>mygdeck-cli mobile on</code> 실행 (최초 1회는 <code>docs/mobile.md</code> 참고해 토큰 설정)</li>
      <li>휴대폰 브라우저에서 위 주소를 열고 홈 화면에 추가(PWA)</li>
      <li>종료할 때는 <code>mygdeck-cli mobile off</code></li>
    </ol>`;
  box.querySelector(".keys-close").onclick = closeOverlay;
  box.querySelector(".mod-copy").onclick = async (e) => {
    await navigator.clipboard.writeText(url).catch(() => {});
    e.target.textContent = "복사됨";
  };
  overlay.replaceChildren(box);
}

function openFind() {
  let bar = document.getElementById("find-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "find-bar";
    bar.className = "find-bar";
    bar.innerHTML = `<div class="find-row"><input class="find-in" placeholder="전체 대화 · 화면 검색…" spellcheck="false"><button class="find-prev" title="이전 (Shift+Enter)">▲</button><button class="find-next" title="다음 (Enter)">▼</button><button class="find-x" title="닫기 (Esc)">✕</button></div><div class="find-hits" hidden></div>`;
    document.body.append(bar);
    const input = bar.querySelector(".find-in");
    const hitsBox = bar.querySelector(".find-hits");
    const run = (back = false) => input.value && window.find(input.value, false, back, true, false, false, false);
    const renderHits = () => {
      const q = input.value.trim().toLowerCase();
      hitsBox.textContent = "";
      if (q.length < 2) { hitsBox.hidden = true; return; }
      const hits = [];
      app.cards.forEach((c, ci) => {
        (c.history ?? []).forEach((h, ti) => {
          const text = [h.ask, ...(h.texts ?? [])].filter(Boolean).join(" ");
          const pos = text.toLowerCase().indexOf(q);
          if (pos >= 0) hits.push({ ci, c, ti, cur: false, snippet: text.slice(Math.max(0, pos - 16), pos + 44) });
        });
        const curText = [c.turnAsk, ...(c.turn?.texts ?? [])].filter(Boolean).join(" ");
        const pos = curText.toLowerCase().indexOf(q);
        if (pos >= 0) hits.push({ ci, c, ti: -1, cur: true, snippet: curText.slice(Math.max(0, pos - 16), pos + 44) });
      });
      hitsBox.hidden = !hits.length;
      for (const h of hits.slice(0, 8)) {
        const b = document.createElement("button");
        b.className = "find-hit";
        b.innerHTML = `<b>${h.c.name}</b><span>${h.cur ? "현재 턴" : `${h.ti + 1}턴`} · ${h.snippet.replace(/</g, "&lt;")}</span>`;
        b.onclick = () => {
          setActive(h.ci);
          const sel = h.cur ? ".s-ask.cur" : `.s-past[data-turn="${h.ti}"]`;
          requestAnimationFrame(() => h.c.el.querySelector(sel)?.scrollIntoView({ behavior: "smooth", block: "start" }));
        };
        hitsBox.append(b);
      }
    };
    input.oninput = renderHits;
    input.onkeydown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); bar.hidden = true; app.cards[app.active]?.focusDefault(); }
      else if (e.key === "Enter") { e.preventDefault(); run(e.shiftKey); }
    };
    bar.querySelector(".find-prev").onclick = () => run(true);
    bar.querySelector(".find-next").onclick = () => run(false);
    bar.querySelector(".find-x").onclick = () => { bar.hidden = true; app.cards[app.active]?.focusDefault(); };
  }
  bar.hidden = false;
  const input = bar.querySelector(".find-in");
  input.focus();
  input.select();
}

/** Ctrl+Shift+F: search text inside project files and open in the code viewer. */
function openCodeSearch() {
  const c = app.cards[app.active];
  if (!c) return;
  if (overlayKind === "codesearch") return closeOverlay();
  overlayKind = "codesearch";
  overlay.hidden = false;
  overlay.innerHTML = `<div class="qo pal"><input class="qo-in" placeholder="${c.name} 코드 내 텍스트 검색…" spellcheck="false"><ul class="qo-list"></ul></div>`;
  const input = overlay.querySelector("input");
  const list = overlay.querySelector("ul");
  let hits = [];
  let sel = 0;
  let timer = null;
  const open = () => {
    const h = hits[sel];
    closeOverlay();
    if (h) c.viewer.open(h.path, "code");
  };
  const render = () => {
    list.textContent = "";
    hits.forEach((h, i) => {
      const li = document.createElement("li");
      if (i === sel) li.className = "on";
      const main = document.createElement("span");
      main.textContent = `${h.path}:${h.line}`;
      const hint = document.createElement("small");
      hint.className = "pal-hint";
      hint.textContent = h.text;
      li.append(main, hint);
      li.onclick = () => { sel = i; open(); };
      list.append(li);
    });
  };
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hits = []; render(); return; }
    timer = setTimeout(async () => {
      hits = await invoke("search_in_files", { root: c.root, query: q }).catch(() => []);
      sel = 0;
      render();
    }, 180);
  };
  input.onkeydown = (e) => {
    if (e.key === "Escape") return closeOverlay();
    if (e.key === "Enter") { e.preventDefault(); return open(); }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && hits.length) {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
      render();
      list.children[sel]?.scrollIntoView({ block: "nearest" });
    }
  };
  input.focus();
}

function openShortcuts() {
  if (overlayKind === "shortcuts") return closeOverlay();
  overlayKind = "shortcuts";
  overlay.hidden = false;
  const items = [
    ["Ctrl+K", "커맨드 팔레트 열기"],
    ["Ctrl+F", "화면 내 텍스트 검색"],
    ["Ctrl+Shift+F", "프로젝트 코드 내용 검색"],
    ["Ctrl+Space", "다음 대기 프로젝트로 이동"],
    ["Ctrl+0", "전체 보기 열기 / 닫기"],
    ["Ctrl+1~9", "해당 번호 프로젝트로 이동"],
    ["Ctrl+PgUp / PgDn", "이전 / 다음 프로젝트"],
    ["Ctrl+'", "프로젝트 폴더 추가"],
    ["Ctrl+P", "파일 빠른 열기"],
    ["Ctrl+.", "CLI / GUI 화면 전환"],
    ["Ctrl+`", "하단 터미널 열기 / 닫기"],
    ["Ctrl+;", "탐색기 · 뷰어 열기 / 닫기"],
    ["Ctrl+I", "선택한 코드 위치 입력창에 넣기"],
    ["Ctrl++ / -", "카드 크기 조절"],
    ["Ctrl+Tab", "카드 내 포커스 전환"],
    ["Ctrl+Q", "실행 중인 에이전트 중단"],
    ["Ctrl+F4", "현재 프로젝트 닫기"],
    ["Esc", "팝업 닫기"],
  ];
  const box = document.createElement("div");
  box.className = "qo keys-box";
  box.innerHTML = `<div class="keys-head"><span class="qo-title">키보드 단축키</span><button class="keys-close" aria-label="닫기">${icon(ICONS.X)}</button></div><div class="keys-grid"></div>`;
  box.querySelector(".keys-close").onclick = closeOverlay;
  const grid = box.querySelector(".keys-grid");
  for (const [k, label] of items) {
    const row = document.createElement("div");
    row.className = "keys-row";
    const kbd = document.createElement("kbd");
    kbd.textContent = keyLabel(k);
    const span = document.createElement("span");
    span.textContent = label;
    row.append(kbd, span);
    grid.append(row);
  }
  overlay.replaceChildren(box);
}

overlay.addEventListener("mousedown", (e) => e.target === overlay && closeOverlay());

window.addEventListener(
  "keydown",
  (e) => {
    if (overlayKind && e.key === "Escape") {
      e.preventDefault();
      closeOverlay();
      return app.cards[app.active]?.focusDefault();
    }
    if (overlayKind === "overview" && !e.ctrlKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "Enter") {
        closeOverlay();
        return setActive(overviewSel);
      }
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      overviewSel = (overviewSel + step + app.cards.length) % app.cards.length;
      return renderOverview();
    }
    // Ctrl+P / Ctrl+F belong to the CLI while the terminal has focus (spec 3.3); ⌘P / ⌘F on macOS never reach it.
    if (keyCode(e) === "KeyP" && isDeckMod(e, "KeyP") && (IS_MAC || !e.target.closest?.(".xterm"))) {
      e.preventDefault();
      return quickOpen();
    }
    if (keyCode(e) === "KeyF" && isDeckMod(e, "KeyF") && (IS_MAC || !e.target.closest?.(".xterm"))) {
      e.preventDefault();
      return e.shiftKey ? openCodeSearch() : openFind();
    }
    if (!isDeckKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const k = keyCode(e);
    const c = app.cards[app.active];
    if (k === "Digit0") toggleOverview();
    else if (k.startsWith("Digit")) setActive(Number(k.slice(5)) - 1);
    else if (k === "Space") {
      const i = nextAttention(app.cards.map((x) => x.status), app.active);
      if (i >= 0) setActive(i);
    }
    else if (k === "Quote") addProject();
    else if (k === "KeyK") openPalette();
    else if (!c) return;
    else if (k === "Equal" || k === "Minus") {
      const d = DENSITIES.indexOf(c.density) + (k === "Equal" ? 1 : -1);
      if (d >= 0 && d < DENSITIES.length) {
        c.setDensity(DENSITIES[d]);
        layout();
      }
    } else if (k === "PageUp" || k === "PageDown") {
      setActive((app.active + (k === "PageDown" ? 1 : -1) + app.cards.length) % app.cards.length);
    } else if (k === "Tab") c.cycleFocus(1);
    else if (k === "KeyI") c.insertSelection();
    else if (k === "Backquote") c.toggleShell();
    else if (k === "Period") c.toggleView();
    else if (k === "Semicolon") c.toggleSpec();
    else if (k === "KeyQ") c.interrupt();
    else if (k === "F4") closeCard(c);
  },
  true,
);

boot().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<pre class="fatal"></pre>`);
  document.querySelector(".fatal").textContent = `시작 실패: ${e}`;
});
