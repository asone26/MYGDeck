import "@xterm/xterm/css/xterm.css";
import "highlight.js/styles/github-dark.css";
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { Card } from "./card.js";
import { openConnections, refreshPool } from "./connections.js";
import { ptys } from "./pty.js";
import { BADGE, DENSITIES, autoLayout, fuzzyFilter, isDeckKey, keyCode, nextAttention, splitDeck } from "./logic.js";

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
  onPeek: () => overlayKind === "overview" && renderOverview(),
};

let overlayKind = null;
let overviewSel = 0;

async function boot() {
  await invoke("pty_reset");
  const [loaded, adapters, shell] = await Promise.all([invoke("load_config"), invoke("list_adapters"), invoke("default_shell")]);
  Object.assign(app, { adapters, shell, source: loaded.source });
  await listen("pty-data", (e) => ptys.get(e.payload.id)?.received(e.payload.data));
  await listen("pty-exit", (e) => ptys.get(e.payload.id)?.exited(e.payload.code));
  await listen("agent-hook", (e) => app.cards.find((c) => c.agent.id === e.payload.id)?.onHook(e.payload.event, e.payload.data));
  await listen("fs-change", (e) => app.cards.find((c) => c.id === e.payload)?.onFsChange());
  refreshPool();
  $("add-btn").onclick = addProject;
  $("conn-btn").onclick = () => {
    overlayKind = "connections";
    overlay.hidden = false;
    openConnections(overlay);
  };
  for (const p of loaded.config.projects) addCard(p, false);
  app.active = 0;
  layout();
  app.cards[0]?.focusDefault();
}

function adapterFor(cfg) {
  if (cfg.command) return null;
  const want = cfg.agent ?? app.adapters.find((a) => a.detected)?.name;
  return app.adapters.find((a) => a.name === want) ?? null;
}

function addCard(cfg, persist = true) {
  const card = new Card(app, cfg, adapterFor(cfg));
  app.cards.push(card);
  dragToSwap(card);
  app.active = app.cards.length - 1;
  layout();
  // Start after layout so the terminal knows its real size.
  requestAnimationFrame(() => card.start());
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
  if (typeof dir !== "string") return;
  const same = (p) => p.replace(/[\\/]+$/, "").toLowerCase() === dir.replace(/[\\/]+$/, "").toLowerCase();
  const existing = app.cards.findIndex((c) => same(c.root));
  if (existing >= 0) return setActive(existing);
  addCard({ path: dir });
  requestAnimationFrame(() => app.cards.at(-1)?.focusDefault());
}

async function closeCard(card) {
  const busy = card.status === "working" || card.status === "waiting";
  if (busy && !(await ask(`${card.name}: 에이전트가 작업 중입니다. 닫으면 작업이 중단됩니다.`, { title: "프로젝트 닫기", kind: "warning", okLabel: "닫기", cancelLabel: "취소" }))) return;
  const i = app.cards.indexOf(card);
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
    b.innerHTML = `<span class="dot"></span><span class="cn"></span><span class="cx" title="닫기 (Ctrl+F4)">×</span>`;
    b.querySelector(".cn").textContent = c.name;
    b.onclick = (e) => (e.target.classList.contains("cx") ? closeCard(c) : setActive(i));
    chips.append(b);
  });
}

function closeOverlay() {
  overlay.hidden = true;
  overlay.textContent = "";
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
  overlay.innerHTML = `<div class="ov"><div class="ov-title">전체 보기 · 방향키 이동 · Enter 열기 · Esc 닫기</div><div class="ov-grid"></div></div>`;
  const grid = overlay.querySelector(".ov-grid");
  app.cards.forEach((c, i) => {
    const t = document.createElement("button");
    t.className = "tile" + (i === overviewSel ? " on" : "");
    t.dataset.status = c.status;
    t.style.setProperty("--pc", c.color);
    t.innerHTML = `<div class="th"><span class="dot"></span><b></b><span class="cb"></span></div><div class="tt"></div><pre class="tp"></pre>`;
    t.querySelector("b").textContent = `#${i + 1} ${c.name}`;
    t.querySelector(".cb").textContent = BADGE[c.status] ?? "";
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
    // Ctrl+P belongs to the CLI while the terminal has focus (spec 3.3).
    if (e.ctrlKey && !e.altKey && !e.shiftKey && keyCode(e) === "KeyP" && !e.target.closest?.(".xterm")) {
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
    else if (k === "KeyI") c.viewer.insertSelection();
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
