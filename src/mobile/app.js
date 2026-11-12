// Phone dashboard: the deck's agents from a phone (served by the session daemon, src-tauri/src/mobile.rs).
// The terminal is parsed by xterm.js without being drawn, so menus are read exactly as the deck reads them.
import { MENU, basename, koMessage, menuChoices, menuQuestion, permissionLine, projectColor } from "/logic.js";

const $ = (id) => document.getElementById(id);
const RANK = { waiting: 0, working: 1, starting: 2, done: 3, idle: 4 };
const LABEL = { waiting: "응답 필요", working: "작업 중", starting: "시작 중", done: "완료", idle: "대기" };

let sessions = [];
let colors = new Map();
let authFailed = false;
let pollTimer = null;
const seenWaiting = new Set();

// ---------- API ----------

async function api(path, body) {
  const opts = body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Mygdeck": "1" }, body: JSON.stringify(body) } : {};
  // The dashboard never redirects an API call. A redirect is a sign-in put in front of it (such as
  // Cloudflare Access) whose session ran out: reloading the page shows that sign-in screen.
  const r = await fetch(path, { cache: "no-store", redirect: "manual", ...opts });
  if (r.type === "opaqueredirect") {
    location.reload();
    throw new Error("로그인이 만료되어 다시 로그인합니다");
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    authFailed = true;
    // The Pages relay asks for the daily password; the PC's own page wants its link instead.
    if (data.error === "login") showLogin();
    else showBanner("auth");
  }
  if (r.status === 503) throw new Error("offline");
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function showBanner(kind) {
  const b = $("banner");
  if (!kind) return (b.hidden = true);
  b.hidden = false;
  b.className = "banner" + (kind === "auth" || kind === "open-failed" ? " bad" : "");
  b.innerHTML = {
    auth: "이 기기는 아직 연결되지 않았습니다. PC에서 <code>mygdeck-cli mobile</code>을 실행해 나온 링크로 열어 주세요.",
    offline: "PC에 연결할 수 없습니다. PC가 켜져 있고 로그인되어 있는지 확인하세요. 다시 시도하는 중…",
    opening: "PC에서 MYG Deck을 여는 중입니다. 프로젝트가 뜰 때까지 잠시 기다리세요.",
    "open-failed": "PC에서 MYG Deck이 열리지 않았습니다. PC 화면을 확인해 주세요.",
  }[kind];
}

// ---------- Open the deck on the PC when it is closed ----------

let deckChecked = false;
let openingSince = 0;

/** The tunnel lives in the daemon, which outlives the window; if no window is open, open one. */
async function ensureDeck() {
  if (deckChecked && !openingSince) return;
  deckChecked = true;
  try {
    const { window: open } = await api("/api/status");
    if (open) {
      if (openingSince) showBanner(null);
      openingSince = 0;
      return;
    }
    if (!openingSince) {
      openingSince = Date.now();
      showBanner("opening");
      await api("/api/open", {});
    } else if (Date.now() - openingSince > 60_000) {
      openingSince = 0;
      showBanner("open-failed");
    }
  } catch (e) {
    openingSince = 0;
    if (e.message !== "offline") toast(e.message);
  }
}

// ---------- Daily password (Cloudflare Pages relay) ----------

function showLogin() {
  detail?.close();
  detail = null;
  $("list-view").hidden = $("detail-view").hidden = true;
  $("login-view").hidden = false;
  setTimeout(() => $("password").focus(), 50);
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  btn.disabled = true;
  $("login-error").hidden = true;
  try {
    const r = await fetch("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("password").value }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    $("password").value = "";
    $("login-view").hidden = true;
    authFailed = false;
    await poll();
    route();
  } catch (err) {
    $("login-error").textContent = err.message;
    $("login-error").hidden = false;
  } finally {
    btn.disabled = false;
  }
});

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------- Project list ----------

const nameOf = (s) => basename(s.cwd || s.id);

function statusLine(s) {
  if (s.status === "waiting") return koMessage(s.text) || "선택지에 답해 주세요";
  if (s.status === "working") return s.text && s.text !== "작업 중" ? s.text : "작업 중";
  if (s.status === "done") return `마지막 출력 ${ago(s.idle_secs)}`;
  return s.idle_secs != null ? `마지막 출력 ${ago(s.idle_secs)}` : "";
}

function ago(sec) {
  if (sec == null) return "";
  if (sec < 60) return "방금";
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

function assignColors() {
  const used = [];
  const next = new Map();
  for (const s of sessions) {
    const c = projectColor(nameOf(s), used);
    used.push(c);
    next.set(s.id, c);
  }
  colors = next;
}

function renderList() {
  const ul = $("projects");
  const sorted = [...sessions].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
  ul.replaceChildren(
    ...sorted.map((s) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "proj";
      btn.dataset.status = s.status;
      btn.style.setProperty("--pc", colors.get(s.id));
      btn.innerHTML = `<span class="bar-c"></span><span class="main"><span class="name"></span><br><span class="line"></span></span><span class="st"><span class="pulse"></span></span>`;
      btn.querySelector(".name").textContent = nameOf(s);
      btn.querySelector(".line").textContent = statusLine(s);
      btn.querySelector(".st").append(LABEL[s.status] ?? s.status);
      btn.addEventListener("click", () => (location.hash = encodeURIComponent(s.id)));
      li.append(btn);
      return li;
    }),
  );
  $("empty").hidden = sessions.length > 0 || authFailed || !!openingSince;
  const waiting = sessions.filter((s) => s.status === "waiting").length;
  const working = sessions.filter((s) => s.status === "working").length;
  const parts = [];
  if (waiting) parts.push(`<b>응답 필요 ${waiting}</b>`);
  if (working) parts.push(`작업 중 ${working}`);
  if (!parts.length && sessions.length) parts.push(`${sessions.length}개 프로젝트`);
  $("summary").innerHTML = parts.join(" · ");
  document.title = waiting ? `(${waiting}) MYG Deck` : "MYG Deck";
}

async function poll() {
  clearTimeout(pollTimer);
  if (authFailed) return;
  try {
    sessions = await api("/api/list");
    if (!openingSince) showBanner(null);
    await ensureDeck();
    // A buzz when a project starts waiting for an answer (Android; iOS ignores it).
    for (const s of sessions) {
      if (s.status === "waiting" && !seenWaiting.has(s.id)) navigator.vibrate?.(120);
    }
    seenWaiting.clear();
    for (const s of sessions) if (s.status === "waiting") seenWaiting.add(s.id);
    assignColors();
    renderList();
    detail?.onList();
  } catch (e) {
    if (!authFailed) showBanner("offline");
  }
  if (!authFailed && document.visibilityState === "visible") pollTimer = setTimeout(poll, 2000);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  deckChecked = false; // the deck may have been closed while the phone was away
  poll();
  detail?.pullScreen();
});

// ---------- One project ----------

let detail = null;

class Detail {
  constructor(id) {
    this.id = id;
    this.tab = null;
    this.choices = [];
    this.question = "";
    this.lastStatus = null;
    this.turnKey = "";
    this.term = null;
    this.es = null;
    this.screenTimer = null;
    this.turnTimer = null;
    this.ended = false;
    this.open();
  }

  get session() {
    return sessions.find((s) => s.id === this.id);
  }

  open() {
    const s = this.session;
    // Parsed but never drawn: the same screen the PC shows, read as text.
    this.term = new Terminal({ cols: s?.cols || 120, rows: s?.rows || 40, scrollback: 2000, allowProposedApi: true });
    this.next = 0;
    this.pullScreen();
    this.setTab(s?.has_turn ? "turn" : "cli");
    $("tab-turn").disabled = !s?.has_turn;
    this.onList();
  }

  /** New terminal output since the last pull (polled: the tunnel carries no event streams). */
  async pullScreen() {
    clearTimeout(this.pullTimer);
    if (this.closed || this.ended) return;
    try {
      const r = await api(`/api/screen?id=${encodeURIComponent(this.id)}&from=${this.next}`);
      if (this.closed) return;
      if (r.reset) this.term.reset();
      if (r.data) this.term.write(r.data, () => this.scheduleScreen());
      this.next = r.next;
    } catch (e) {
      if (/세션이 끝났습니다/.test(e.message)) return this.end();
    }
    if (document.visibilityState === "visible") this.pullTimer = setTimeout(() => this.pullScreen(), 1000);
  }

  close() {
    this.closed = true;
    clearTimeout(this.pullTimer);
    this.term?.dispose();
    clearTimeout(this.screenTimer);
    clearTimeout(this.turnTimer);
  }

  end() {
    this.ended = true;
    clearTimeout(this.pullTimer);
    $("d-status").textContent = "세션이 끝났습니다";
    $("d-status").dataset.status = "";
    $("input").disabled = $("send").disabled = $("stop").disabled = true;
    $("ask").hidden = $("hint").hidden = true;
  }

  onList() {
    const s = this.session;
    if (!s) {
      if (!this.ended) this.end();
      return;
    }
    $("d-name").textContent = nameOf(s);
    document.querySelector("#detail-view .d-title").style.setProperty("--pc", colors.get(s.id));
    const st = $("d-status");
    st.dataset.status = s.status;
    st.innerHTML = `<span class="pulse"></span>`;
    st.append(`${LABEL[s.status] ?? s.status}${s.status === "working" && s.text && s.text !== "작업 중" ? " · " + s.text : ""}`);
    if (this.term && s.cols && (s.cols !== this.term.cols || s.rows !== this.term.rows)) this.term.resize(s.cols, s.rows);
    $("tab-turn").disabled = !s.has_turn;
    if (s.status !== this.lastStatus) this.renderAsk();
    if (s.has_turn && (s.status !== this.lastStatus || s.status === "working")) this.loadTurnSoon(s.status !== this.lastStatus ? 0 : 3000);
    this.lastStatus = s.status;
  }

  // ----- screen (menus + CLI view) -----

  scheduleScreen() {
    if (this.screenTimer) return;
    this.screenTimer = setTimeout(() => {
      this.screenTimer = null;
      this.readScreen();
    }, 250);
  }

  /** Same reading as the deck's card (card.js onOutput): last 20 lines up to the cursor. */
  lastLines(n) {
    const b = this.term.buffer.active;
    const out = [];
    for (let y = b.baseY + b.cursorY; y >= 0 && out.length < n; y--) {
      const raw = b.getLine(y)?.translateToString(true) ?? "";
      if (raw.trim()) out.unshift(raw.trimEnd());
      else if (out.length && out[0] !== "") out.unshift("");
    }
    return out;
  }

  readScreen() {
    const lines = this.lastLines(20);
    const menu = MENU.test(lines.filter(Boolean).slice(-8).join("\n"));
    const choices = menu ? menuChoices(lines) : [];
    const question = menuQuestion(lines, choices);
    if (!this.screenRead) {
      this.screenRead = true;
      this.renderAsk();
    }
    if (JSON.stringify(choices) !== JSON.stringify(this.choices) || question !== this.question) {
      this.choices = choices;
      this.question = question;
      this.renderAsk();
    }
    if (this.tab === "cli") this.renderCli();
  }

  renderAsk() {
    const open = this.choices.length > 0 && !this.ended;
    // The agent says it waits but no menu was read off the screen: point at the raw CLI.
    const blind = !open && !this.ended && this.session?.status === "waiting";
    $("ask").hidden = !open && !blind;
    const input = $("input");
    // Until the screen is read, a waiting agent may have a menu open: typing would pick an option.
    input.disabled = open || this.ended || (blind && !this.screenRead);
    input.placeholder = open ? "" : "에이전트에게 지시";
    $("send").disabled = open || this.ended;
    $("hint").hidden = !open;
    // Headline in plain words (what allowing does); the CLI's own wording goes below it, quieter.
    const tool = this.session?.tool;
    const head = tool?.tool ? permissionLine(tool.tool, tool.detail) : koMessage(this.session?.text) || "";
    $("ask-head").textContent = head;
    $("ask-head").hidden = !head;
    if (blind) {
      $("ask-q").textContent = this.screenRead ? "선택지를 읽지 못했습니다. CLI 화면에서 확인하세요." : "선택지를 읽는 중…";
      const b = document.createElement("button");
      b.textContent = "CLI 화면 보기";
      b.addEventListener("click", () => this.setTab("cli"));
      $("ask-choices").replaceChildren(b);
      return;
    }
    if (!open) return;
    $("ask-q").textContent = this.question || "선택하세요";
    $("ask-choices").replaceChildren(
      ...this.choices.map((c, i) => {
        const b = document.createElement("button");
        b.innerHTML = `<span class="n">${i + 1}</span>`;
        b.append(c.label);
        b.addEventListener("click", async () => {
          for (const x of $("ask-choices").children) x.disabled = true;
          try {
            await api("/api/keys", { id: this.id, keys: c.keys });
          } catch (e) {
            toast(`보내지 못했습니다: ${e.message}`);
            for (const x of $("ask-choices").children) x.disabled = false;
          }
        });
        return b;
      }),
    );
  }

  renderCli() {
    const b = this.term.buffer.active;
    const from = Math.max(0, b.length - 400);
    const lines = [];
    for (let y = from; y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? "");
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    const body = $("d-body");
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    $("cli").textContent = lines.join("\n");
    if (atBottom) body.scrollTop = body.scrollHeight;
  }

  setTab(tab) {
    this.tab = tab;
    $("tab-turn").setAttribute("aria-selected", String(tab === "turn"));
    $("tab-cli").setAttribute("aria-selected", String(tab === "cli"));
    $("turn").hidden = tab !== "turn";
    $("cli").hidden = tab !== "cli";
    if (tab === "cli") {
      this.renderCli();
      $("d-body").scrollTop = $("d-body").scrollHeight;
    } else this.loadTurnSoon(0);
  }

  // ----- last turn -----

  loadTurnSoon(ms) {
    clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => this.loadTurn(), ms);
  }

  async loadTurn() {
    if (this.tab !== "turn" || this.ended) return;
    try {
      const t = await api(`/api/turn?id=${encodeURIComponent(this.id)}`);
      const key = JSON.stringify(t);
      if (key !== this.turnKey) {
        this.turnKey = key;
        this.renderTurn(t);
      }
    } catch (e) {
      if (!this.turnKey) $("turn").innerHTML = `<p class="note">아직 대화가 없습니다.</p>`;
    }
  }

  renderTurn(t) {
    const body = $("d-body");
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    const root = $("turn");
    root.replaceChildren();
    const sec = (label) => {
      const d = document.createElement("div");
      d.className = "sec";
      if (label) d.innerHTML = `<p class="label">${label}</p>`;
      root.append(d);
      return d;
    };
    if (t.prompt) {
      const p = document.createElement("p");
      p.className = "prompt";
      p.textContent = t.prompt;
      p.addEventListener("click", () => p.classList.toggle("open"));
      sec("내 지시").append(p);
    }
    if (t.tools?.length) {
      const ul = document.createElement("ul");
      ul.className = "steps";
      const shown = t.tools.slice(-6);
      if (t.tools.length > shown.length) {
        const li = document.createElement("li");
        li.className = "more";
        li.textContent = `앞의 단계 ${t.tools.length - shown.length}개`;
        ul.append(li);
      }
      for (const tool of shown) {
        const li = document.createElement("li");
        if (tool.error) li.className = "err";
        li.innerHTML = `<span class="t"></span><span class="d"></span>`;
        li.querySelector(".t").textContent = tool.name;
        li.querySelector(".d").textContent = tool.error ? `실패: ${tool.error}` : tool.detail;
        ul.append(li);
      }
      sec(`진행 단계 ${t.tools.length}`).append(ul);
    }
    const text = (t.texts ?? []).join("\n\n").trim();
    const ans = document.createElement("div");
    ans.className = "answer";
    if (text) ans.innerHTML = markdown(text);
    else ans.innerHTML = `<p class="note">${this.session?.status === "working" ? "답변을 쓰는 중입니다" : "답변이 아직 없습니다"}</p>`;
    sec(text ? "AI 답변" : "").append(ans);
    if (atBottom) body.scrollTop = body.scrollHeight;
  }
}

/** Small, safe Markdown: escape everything, then code blocks, headings, lists, bold, inline code. */
export function markdown(src) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const out = [];
  const blocks = src.split(/(```[\s\S]*?(?:```|$))/);
  for (const block of blocks) {
    if (block.startsWith("```")) {
      out.push(`<pre><code>${esc(block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "").replace(/\n$/, ""))}</code></pre>`);
      continue;
    }
    for (const para of block.split(/\n{2,}/)) {
      const lines = para.split("\n").filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`).join("")}</ul>`);
      } else if (lines.length === 1 && /^#{1,6}\s/.test(lines[0])) {
        out.push(`<h3>${inline(lines[0].replace(/^#+\s*/, ""))}</h3>`);
      } else {
        out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
      }
    }
  }
  return out.join("");
}

// ---------- Composer ----------

const input = $("input");
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight + 2}px`;
});

$("send").addEventListener("click", async () => {
  const text = input.value.replace(/\s+$/, "");
  if (!text.trim() || !detail) return;
  $("send").disabled = true;
  try {
    await api("/api/send", { id: detail.id, text });
    input.value = "";
    input.dispatchEvent(new Event("input"));
    detail.setTab(detail.session?.has_turn ? "turn" : "cli");
  } catch (e) {
    toast(`보내지 못했습니다: ${e.message}`);
  } finally {
    $("send").disabled = detail?.choices.length > 0 || detail?.ended;
  }
});

// Esc stops the agent's current turn. Two taps, so a stray touch never stops work.
let stopArmed = null;
$("stop").addEventListener("click", async () => {
  const btn = $("stop");
  if (!stopArmed) {
    btn.classList.add("armed");
    btn.textContent = "한 번 더 눌러 중지";
    stopArmed = setTimeout(disarm, 3000);
    return;
  }
  disarm();
  try {
    await api("/api/keys", { id: detail.id, keys: ["\x1b"] });
    toast("중지 신호를 보냈습니다");
  } catch (e) {
    toast(`보내지 못했습니다: ${e.message}`);
  }
});
function disarm() {
  clearTimeout(stopArmed);
  stopArmed = null;
  $("stop").classList.remove("armed");
  $("stop").textContent = "중지";
}

$("tab-turn").addEventListener("click", () => detail?.setTab("turn"));
$("tab-cli").addEventListener("click", () => detail?.setTab("cli"));
$("back").addEventListener("click", () => {
  if (history.length > 1 && location.hash) history.back();
  else location.hash = "";
});

// ---------- Routing ----------

function route() {
  if (!$("login-view").hidden) return;
  const id = decodeURIComponent(location.hash.slice(1));
  detail?.close();
  detail = null;
  disarm();
  $("list-view").hidden = !!id;
  $("detail-view").hidden = !id;
  if (id) {
    input.value = "";
    input.disabled = $("send").disabled = $("stop").disabled = false;
    $("ask").hidden = $("hint").hidden = true;
    $("turn").replaceChildren();
    $("cli").textContent = "";
    detail = new Detail(id);
  }
}
window.addEventListener("hashchange", route);

poll().then(route);
