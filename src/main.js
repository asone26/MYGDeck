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
import { ptys, setTermTheme } from "./pty.js";
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

async function onStatus(card, prev) {
  if (!["waiting", "done"].includes(card.status) || card.rotating || prev === "starting") return;
  if (card.status === "done" && card.queue.length) return; // the next queued input goes on by itself
  if (document.hasFocus()) return; // the header strip already shows it
  if (Date.now() - (card.notifiedAt ?? 0) < NOTIFY_GAP) return;
  card.notifiedAt = Date.now();
  if (card.status === "waiting" || !jumpTo) jumpTo = card; // a permission prompt outranks a finished turn
  const win = getCurrentWindow();
  win.requestUserAttention(card.status === "waiting" ? UserAttentionType.Critical : UserAttentionType.Informational).catch(() => {});
  notifyAllowed ??= (await isPermissionGranted().catch(() => false)) || (await requestPermission().catch(() => "denied")) === "granted";
  if (!notifyAllowed) return;
  const what = card.status === "waiting" ? card.statusText || "입력을 기다립니다" : `완료${card.turnAsk ? `: ${card.turnAsk.slice(0, 80)}` : ""}`;
  sendNotification({ title: `MYG Deck · ${card.name}`, body: what });
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
    t.querySelector(".tt").textContent = c.statusText;
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

function openShortcuts() {
  if (overlayKind === "shortcuts") return closeOverlay();
  overlayKind = "shortcuts";
  overlay.hidden = false;
  const items = [
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
    // Ctrl+P belongs to the CLI while the terminal has focus (spec 3.3); ⌘P on macOS never reaches it.
    if (keyCode(e) === "KeyP" && isDeckMod(e, "KeyP") && (IS_MAC || !e.target.closest?.(".xterm"))) {
      e.preventDefault();
      return quickOpen();
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
