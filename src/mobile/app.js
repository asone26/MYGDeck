// Phone dashboard: the deck's agents from a phone (served by the session daemon, src-tauri/src/mobile.rs).
// The terminal is parsed by xterm.js without being drawn, so menus are read exactly as the deck reads them.
import { MENU, basename, koMessage, menuChoices, menuQuestion, permissionLine, projectColor } from "/logic.js";

const $ = (id) => document.getElementById(id);
// A finished turn nobody has read yet ranks right after a question: both wait for the user.
const RANK = { waiting: 0, unread: 1, working: 2, starting: 3, done: 4, idle: 5 };
const LABEL = { waiting: "응답 필요", unread: "새 답변", working: "작업 중", starting: "시작 중", done: "완료", idle: "출력 없음" };

/** Per-phone conveniences (unread marks, drafts, CLI view). Storage may be off: then they just reset. */
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

let sessions = [];
let colors = new Map();
let authFailed = false;
let pollTimer = null;
const seenWaiting = new Set();
let prevStatus = store.get("mg.prev", {});
const unread = new Set(store.get("mg.unread", []));
const drafts = store.get("mg.drafts", {});
let lastOk = Date.now();
let offline = false;

/** Server and network errors in words a person can act on. */
function errText(e) {
  const m = e?.message || String(e);
  if (m === "offline") return "PC와 연결이 끊겼습니다";
  if (m === "unauthorized") return "PC가 접속을 거부했습니다";
  if (m === "login") return "다시 로그인해야 합니다";
  if (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(m)) return "네트워크에 연결할 수 없습니다";
  const h = m.match(/^HTTP (\d+)/);
  if (h) return `서버 오류 (${h[1]})`;
  return m;
}

function since(ms) {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return sec < 60 ? `${sec}초 전` : ago(sec);
}

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
  b.className = "banner" + (kind === "auth" || kind === "open-failed" || kind === "offline" ? " bad" : "");
  b.innerHTML = {
    // The PC refused the relay's token: the Worker's DASH_TOKEN and the PC's token differ.
    auth: "PC가 접속을 거부했습니다. PC와 중계 서버의 대시보드 토큰이 다릅니다. PC에서 <code>mygdeck-cli mobile token | npx wrangler secret put DASH_TOKEN</code>을 다시 실행하세요.",
    offline: `<b>PC와 연결이 끊겼습니다.</b> 아래는 ${since(lastOk)} 상태입니다. PC가 켜져 있고 MYG Deck이 열려 있는지 확인하세요. 다시 연결하는 중…`,
    opening: "PC에서 MYG Deck을 여는 중입니다. 프로젝트가 뜰 때까지 잠시 기다리세요.",
    "open-failed": "PC에서 MYG Deck이 열리지 않았습니다. PC 화면을 확인해 주세요.",
  }[kind];
}

/** The banner sits under the top bar of whichever view is showing. */
function placeBanner() {
  const view = $("detail-view").hidden ? $("list-view") : $("detail-view");
  view.querySelector(".bar").after($("banner"));
}

/** Offline: say so on every view and dim what is now an old picture (it would otherwise look live). */
function setOnline(ok) {
  if (ok) {
    lastOk = Date.now();
    if (offline) {
      offline = false;
      document.body.classList.remove("stale");
      if (!openingSince) showBanner(null);
    }
    return;
  }
  offline = true;
  document.body.classList.add("stale");
  showBanner("offline");
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
    if (e.message !== "offline") toast(errText(e));
  }
}

// ---------- Daily password (Cloudflare Pages relay) ----------

function showLogin() {
  detail?.close();
  detail = null;
  $("list-view").hidden = $("detail-view").hidden = $("add-view").hidden = true;
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
    $("login-error").textContent = errText(err);
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

/** Status for sorting and labels: a finished turn the user has not opened yet counts as "unread". */
const shown = (s) => (s.status === "done" && unread.has(s.id) ? "unread" : s.status);

function statusLine(s) {
  if (s.status === "waiting") return koMessage(s.text) || "선택지에 답해 주세요";
  if (s.status === "working") return s.text && s.text !== "작업 중" ? s.text : "작업 중";
  if (s.status === "done") return unread.has(s.id) ? "답변을 확인하고 다음 지시를 보내세요" : `${ago(s.idle_secs)} 완료 · 다음 지시를 기다립니다`;
  return s.idle_secs != null ? `마지막 출력 ${ago(s.idle_secs)}` : "";
}

/** A turn that ended while the user was not looking at that project is unread until it is opened. */
function trackUnread() {
  const viewing = document.visibilityState === "visible" ? detail?.id : null;
  for (const s of sessions) {
    const was = prevStatus[s.id];
    if (s.status === "done" && was && was !== "done" && s.id !== viewing) unread.add(s.id);
    if (s.status !== "done" || s.id === viewing) unread.delete(s.id);
  }
  for (const id of unread) if (!sessions.some((s) => s.id === id)) unread.delete(id);
  prevStatus = Object.fromEntries(sessions.map((s) => [s.id, s.status]));
  store.set("mg.prev", prevStatus);
  store.set("mg.unread", [...unread]);
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
  const sorted = [...sessions].sort((a, b) => (RANK[shown(a)] ?? 9) - (RANK[shown(b)] ?? 9));
  ul.replaceChildren(
    ...sorted.map((s) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "proj";
      btn.dataset.status = shown(s);
      btn.style.setProperty("--pc", colors.get(s.id));
      btn.innerHTML = `<span class="bar-c"></span><span class="main"><span class="name"></span><br><span class="line"></span></span><span class="st"><span class="pulse"></span></span>`;
      btn.querySelector(".name").textContent = nameOf(s);
      btn.querySelector(".line").textContent = statusLine(s);
      btn.querySelector(".st").append(LABEL[shown(s)] ?? s.status);
      btn.addEventListener("click", () => (location.hash = encodeURIComponent(s.id)));
      li.append(btn);
      return li;
    }),
  );
  $("empty").hidden = sessions.length > 0 || authFailed || !!openingSince;
  const waiting = sessions.filter((s) => s.status === "waiting").length;
  const working = sessions.filter((s) => s.status === "working").length;
  const fresh = sessions.filter((s) => shown(s) === "unread").length;
  const parts = [];
  if (waiting) parts.push(`<b>응답 필요 ${waiting}</b>`);
  if (fresh) parts.push(`<b class="fresh">새 답변 ${fresh}</b>`);
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
    setOnline(true);
    initPush();
    await ensureDeck();
    // A buzz when a project starts waiting for an answer (Android; iOS ignores it).
    for (const s of sessions) {
      if (s.status === "waiting" && !seenWaiting.has(s.id)) navigator.vibrate?.(120);
    }
    seenWaiting.clear();
    for (const s of sessions) if (s.status === "waiting") seenWaiting.add(s.id);
    trackUnread();
    assignColors();
    renderList();
    detail?.onList();
    watchAdding();
  } catch (e) {
    if (!authFailed) setOnline(false);
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
    this.askTimer = null;
    this.ended = false;
    this.pending = null; // an instruction sent from here that the transcript does not show yet
    this.lastTurn = null;
    this.promptOpen = false;
    this.stepsOpen = false;
    unread.delete(id);
    store.set("mg.unread", [...unread]);
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
    clearTimeout(this.askTimer);
  }

  end() {
    this.ended = true;
    clearTimeout(this.pullTimer);
    $("d-status").textContent = "세션이 끝났습니다";
    $("d-status").dataset.status = "";
    $("input").disabled = true;
    $("stop").hidden = true;
    disarm();
    $("ask").hidden = $("hint").hidden = true;
    syncSend();
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
    const extra = s.status === "working" && s.text && s.text !== "작업 중" ? " · " + s.text : s.status === "done" ? " · 다음 지시를 기다립니다" : "";
    st.append(`${LABEL[s.status] ?? s.status}${extra}`);
    // Stop (Esc) only means something while a turn runs; on a menu it would silently refuse.
    const canStop = s.status === "working";
    if (!canStop) disarm();
    $("stop").hidden = !canStop;
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
    clearTimeout(this.askTimer);
    const open = this.choices.length > 0 && !this.ended;
    // The agent says it waits but no menu was read off the screen: point at the raw CLI.
    const blind = !open && !this.ended && this.session?.status === "waiting";
    $("ask").hidden = !open && !blind;
    const input = $("input");
    // Until the screen is read, a waiting agent may have a menu open: typing would pick an option.
    input.disabled = open || this.ended || (blind && !this.screenRead);
    input.placeholder = open ? "" : "에이전트에게 지시";
    $("hint").hidden = !open;
    syncSend();
    // Headline in plain words (what allowing does); the CLI's own wording goes below it, quieter.
    const tool = this.session?.tool;
    const waiting = this.session?.status === "waiting";
    const head = !waiting ? "" : tool?.tool ? permissionLine(tool.tool, tool.detail) : koMessage(this.session?.text) || "";
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
          const all = [...$("ask-choices").children];
          for (const x of all) x.disabled = true;
          try {
            await api("/api/keys", { id: this.id, keys: c.keys });
            // Say it went; the menu leaves the screen a moment later. If the same menu is still
            // there after a few seconds, offer the buttons again rather than leave them dead.
            b.classList.add("sent");
            b.querySelector(".n").textContent = "✓";
            $("ask-q").textContent = `${i + 1}번을 보냈습니다. 에이전트 화면이 바뀌기를 기다리는 중…`;
            this.askTimer = setTimeout(() => this.renderAsk(), 5000);
          } catch (e) {
            toast(`보내지 못했습니다: ${errText(e)}`);
            for (const x of all) x.disabled = false;
          }
        });
        return b;
      }),
    );
  }

  renderCli() {
    const pre = $("cli");
    // Rewriting the text would drop what the user is selecting to copy; catch up once they let go.
    const sel = getSelection();
    if (sel && !sel.isCollapsed && pre.contains(sel.anchorNode)) {
      this.cliDirty = true;
      return;
    }
    this.cliDirty = false;
    const b = this.term.buffer.active;
    const from = Math.max(0, b.length - 400);
    const lines = [];
    for (let y = from; y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? "");
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    const text = lines.join("\n");
    if (text === pre.textContent) return;
    const body = $("d-body");
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    pre.textContent = text;
    if (atBottom) body.scrollTop = body.scrollHeight;
  }

  setTab(tab) {
    this.tab = tab;
    $("tab-turn").setAttribute("aria-selected", String(tab === "turn"));
    $("tab-cli").setAttribute("aria-selected", String(tab === "cli"));
    $("turn").hidden = tab !== "turn";
    $("cli").hidden = tab !== "cli";
    $("cli-tools").hidden = tab !== "cli";
    if (tab === "cli") {
      this.renderCli();
      $("d-body").scrollTop = $("d-body").scrollHeight;
    } else this.loadTurnSoon(0);
  }

  /** Sent from this phone: show it at once as the newest instruction, until the transcript has it. */
  sent(text) {
    clearTimeout(this.pendingTimer);
    this.pending = text;
    // A transcript that never shows it (another agent's format, a lost turn) must not hide answers for good.
    this.pendingTimer = setTimeout(() => {
      this.pending = null;
      if (this.lastTurn) this.renderTurn(this.lastTurn);
    }, 90_000);
    if (this.session?.has_turn) {
      this.setTab("turn");
      this.renderTurn(this.lastTurn ?? {});
    } else {
      this.setTab("cli");
      toast("보냈습니다");
    }
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
      if (!this.turnKey && !this.pending) $("turn").innerHTML = `<p class="note">아직 대화가 없습니다.</p>`;
    }
  }

  renderTurn(t) {
    this.lastTurn = t;
    const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
    if (this.pending && t.prompt && flat(t.prompt).startsWith(flat(this.pending).slice(0, 60))) {
      this.pending = null;
      clearTimeout(this.pendingTimer);
    }
    const view = this.pending ? { prompt: this.pending, pending: true } : t;
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
    if (view.prompt) {
      const box = sec(view.pending ? "내 지시 · 보냄 ✓" : "내 지시");
      const p = document.createElement("p");
      p.className = "prompt" + (this.promptOpen ? " open" : "");
      p.textContent = view.prompt;
      box.append(p);
      // The clamp to four lines needs a visible way out, not a tap on plain text.
      requestAnimationFrame(() => {
        if (!this.promptOpen && p.scrollHeight <= p.clientHeight + 2) return;
        const more = document.createElement("button");
        more.className = "more-btn";
        more.type = "button";
        more.textContent = this.promptOpen ? "접기" : "전체 보기";
        more.addEventListener("click", () => {
          this.promptOpen = !this.promptOpen;
          p.classList.toggle("open", this.promptOpen);
          more.textContent = this.promptOpen ? "접기" : "전체 보기";
        });
        box.append(more);
      });
    }
    if (view.tools?.length) {
      const ul = document.createElement("ul");
      ul.className = "steps";
      const steps = this.stepsOpen ? view.tools : view.tools.slice(-6);
      if (view.tools.length > steps.length) {
        const li = document.createElement("li");
        const more = document.createElement("button");
        more.className = "more-btn";
        more.type = "button";
        more.textContent = `앞의 단계 ${view.tools.length - steps.length}개 더 보기`;
        more.addEventListener("click", () => {
          this.stepsOpen = true;
          this.renderTurn(this.lastTurn);
        });
        li.append(more);
        ul.append(li);
      }
      for (const tool of steps) {
        const li = document.createElement("li");
        if (tool.error) li.className = "err";
        li.innerHTML = `<span class="t"></span><span class="d"></span>`;
        li.querySelector(".t").textContent = tool.name;
        li.querySelector(".d").textContent = tool.error ? `실패: ${tool.error}` : tool.detail;
        ul.append(li);
      }
      sec(`진행 단계 ${view.tools.length}`).append(ul);
    }
    const text = (view.texts ?? []).join("\n\n").trim();
    const ans = document.createElement("div");
    ans.className = "answer";
    if (text) ans.innerHTML = markdown(text);
    else {
      const note = view.pending
        ? "에이전트에게 전달했습니다. 곧 작업을 시작합니다"
        : this.session?.status === "working"
          ? "답변을 쓰는 중입니다"
          : "답변이 아직 없습니다";
      ans.innerHTML = `<p class="note">${note}</p>`;
    }
    sec(text ? "AI 답변" : "").append(ans);
    if (atBottom || view.pending) body.scrollTop = body.scrollHeight;
  }
}

/**
 * Small, safe Markdown: everything is escaped, then code blocks, headings, ordered and bulleted lists
 * (one nested level), tables, links, bold and inline code are rebuilt.
 */
export function markdown(src) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const bold = (h) => h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?])/g;
  const rich = (s) => {
    let out = "";
    let last = 0;
    for (const m of s.matchAll(LINK)) {
      const url = m[2] || m[3];
      out += bold(esc(s.slice(last, m.index)));
      out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(m[1] || url)}</a>`;
      last = m.index + m[0].length;
    }
    return out + bold(esc(s.slice(last)));
  };
  const inline = (s) =>
    s
      .split(/(`[^`\n]+`)/)
      .map((part) => (/^`[^`]+`$/.test(part) ? `<code>${esc(part.slice(1, -1))}</code>` : rich(part)))
      .join("");

  const ITEM = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/;
  const ROW = /^\s*\|.*\|\s*$/;
  const kind = (l) => (/^#{1,6}\s/.test(l) ? "h" : ROW.test(l) ? "table" : ITEM.test(l) ? "list" : "text");

  /** A run of list lines: the shallowest ones are the items, deeper ones a list inside the item above. */
  const list = (lines) => {
    const items = lines.map((l) => {
      const m = l.match(ITEM);
      return { indent: m[1].replace(/\t/g, "  ").length, num: m[3], text: m[4] };
    });
    const top = Math.min(...items.map((x) => x.indent));
    const open = (x) => (x.num ? (x.num === "1" ? "<ol>" : `<ol start="${Number(x.num)}">`) : "<ul>");
    const close = (x) => (x.num ? "</ol>" : "</ul>");
    const first = items.find((x) => x.indent === top);
    let html = open(first);
    let item = false; // an <li> is open
    let sub = null; // the first item of the nested list that is open
    for (const x of items) {
      if (x.indent > top && item) {
        if (!sub) html += open((sub = x));
        html += `<li>${inline(x.text)}</li>`;
        continue;
      }
      if (sub) html += close(sub);
      sub = null;
      if (item) html += "</li>";
      html += `<li>${inline(x.text)}`;
      item = true;
    }
    if (sub) html += close(sub);
    return html + "</li>" + close(first);
  };

  const table = (lines) => {
    const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const rule = (l) => cells(l).every((c) => /^:?-{2,}:?$/.test(c));
    const head = lines.length > 1 && rule(lines[1]);
    const rows = lines.filter((l) => !rule(l));
    const tr = (l, cell) => `<tr>${cells(l).map((c) => `<${cell}>${inline(c)}</${cell}>`).join("")}</tr>`;
    const thead = head ? `<thead>${tr(rows[0], "th")}</thead>` : "";
    const tbody = (head ? rows.slice(1) : rows).map((l) => tr(l, "td")).join("");
    return `<div class="tbl"><table>${thead}<tbody>${tbody}</tbody></table></div>`;
  };

  const out = [];
  const blocks = src.split(/(```[\s\S]*?(?:```|$))/);
  for (const block of blocks) {
    if (block.startsWith("```")) {
      out.push(`<pre><code>${esc(block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "").replace(/\n$/, ""))}</code></pre>`);
      continue;
    }
    for (const para of block.split(/\n{2,}/)) {
      const lines = para.split("\n").filter((l) => l.trim());
      // Runs of one kind of line: a heading, list or table can start right under a line of text.
      let i = 0;
      while (i < lines.length) {
        const k = kind(lines[i]);
        let j = i + 1;
        if (k !== "h") while (j < lines.length && kind(lines[j]) === k) j++;
        const run = lines.slice(i, j);
        if (k === "h") out.push(`<h3>${inline(run[0].replace(/^#+\s*/, ""))}</h3>`);
        else if (k === "list") out.push(list(run));
        else if (k === "table" && run.length > 1) out.push(table(run));
        else out.push(`<p>${run.map(inline).join("<br>")}</p>`);
        i = j;
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
  // A draft survives leaving the project, a reload and a sign-in that ran out.
  if (detail) {
    if (input.value) drafts[detail.id] = input.value;
    else delete drafts[detail.id];
    store.set("mg.drafts", drafts);
  }
  syncSend();
});

let sending = false;

/** Send is live only when there is something to send and the agent can take it. */
function syncSend() {
  $("send").disabled = !detail || detail.ended || detail.choices.length > 0 || input.disabled || !input.value.trim() || sending;
}

$("send").addEventListener("click", async () => {
  const text = input.value.replace(/\s+$/, "");
  if (!text.trim() || !detail) return;
  const d = detail;
  sending = true;
  syncSend();
  try {
    await api("/api/send", { id: d.id, text });
    delete drafts[d.id];
    store.set("mg.drafts", drafts);
    if (detail === d) {
      input.value = "";
      input.dispatchEvent(new Event("input"));
      d.sent(text);
    }
  } catch (e) {
    toast(`보내지 못했습니다: ${errText(e)}`);
  } finally {
    sending = false;
    syncSend();
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
    toast(`보내지 못했습니다: ${errText(e)}`);
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
const goList = () => {
  if (history.length > 1 && location.hash) history.back();
  else location.hash = "";
};
$("back").addEventListener("click", goList);
$("add-back").addEventListener("click", goList);

// ---------- CLI view: wrap and text size (kept per phone) ----------

const cliPref = store.get("mg.cli", { wrap: false, size: 12 });
function applyCli() {
  $("cli").classList.toggle("wrap", cliPref.wrap);
  $("cli").style.fontSize = `${cliPref.size}px`;
  $("cli-wrap").setAttribute("aria-pressed", String(cliPref.wrap));
  $("cli-smaller").disabled = cliPref.size <= 9;
  $("cli-bigger").disabled = cliPref.size >= 16;
  store.set("mg.cli", cliPref);
}
$("cli-wrap").addEventListener("click", () => {
  cliPref.wrap = !cliPref.wrap;
  applyCli();
});
$("cli-smaller").addEventListener("click", () => {
  cliPref.size = Math.max(9, cliPref.size - 1);
  applyCli();
});
$("cli-bigger").addEventListener("click", () => {
  cliPref.size = Math.min(16, cliPref.size + 1);
  applyCli();
});
applyCli();
document.addEventListener("selectionchange", () => {
  if (detail?.cliDirty && getSelection()?.isCollapsed) detail.renderCli();
});

// ---------- Add a project (a folder on the PC) ----------

const samePath = (a, b) => {
  const n = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
};
const sessionAt = (path) => sessions.find((s) => samePath(s.cwd, path));
const noteRow = (text) => Object.assign(document.createElement("li"), { className: "note", textContent: text });

let browse = { path: "", parent: null, dirs: [] };
let browsed = false;
let adding = null; // { path, since }

async function openDir(path) {
  $("dirs").replaceChildren(noteRow("폴더를 읽는 중…"));
  try {
    browse = await api(`/api/dirs?path=${encodeURIComponent(path || "")}`);
    browsed = true;
  } catch (e) {
    $("dirs").replaceChildren(noteRow(`폴더를 읽지 못했습니다: ${errText(e)}`));
    return;
  }
  $("add-filter").value = "";
  renderDirs();
  $("dirs").scrollTop = 0;
}

function renderDirs() {
  const atRoot = !browse.path;
  $("add-path").textContent = atRoot ? "시작할 폴더를 고르세요" : browse.path;
  $("add-path").classList.toggle("path", !atRoot);
  $("add-foot").hidden = atRoot;
  $("add-search").hidden = atRoot || browse.dirs.length < 8;
  syncAddHere();
  const q = $("add-filter").value.trim().toLowerCase();
  const rows = [];
  if (!atRoot) rows.push(dirRow({ name: browse.parent ? "상위 폴더" : "처음 목록", sub: browse.parent || "", up: true }, () => openDir(browse.parent || "")));
  const dirs = browse.dirs.filter((d) => !q || d.name.toLowerCase().includes(q));
  for (const d of dirs) {
    const open = sessionAt(d.path);
    const sub = open ? "덱에 열려 있음" : atRoot ? d.path : d.project ? "프로젝트" : "";
    rows.push(dirRow({ ...d, sub, open: !!open }, () => openDir(d.path), d.project || open ? () => startProject(d.path) : null));
  }
  if (!dirs.length) rows.push(noteRow(q ? "맞는 폴더가 없습니다" : "하위 폴더가 없습니다"));
  $("dirs").replaceChildren(...rows);
}

function dirRow(d, onOpen, onStart) {
  const li = document.createElement("li");
  li.className = "dir" + (d.up ? " up" : "");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "dir-open";
  b.innerHTML = `<span class="ic" aria-hidden="true">${d.up ? "↑" : "›"}</span><span class="main"><span class="name"></span><span class="line"></span></span>`;
  b.querySelector(".name").textContent = d.name;
  b.querySelector(".line").textContent = d.sub || "";
  b.querySelector(".line").hidden = !d.sub;
  b.addEventListener("click", onOpen);
  li.append(b);
  if (onStart) {
    const s = document.createElement("button");
    s.type = "button";
    s.className = "dir-start";
    s.textContent = d.open ? "보기" : "시작";
    s.setAttribute("aria-label", `${d.name} ${s.textContent}`);
    s.disabled = !!adding;
    s.addEventListener("click", onStart);
    li.append(s);
  }
  return li;
}

function syncAddHere() {
  const open = browse.path && sessionAt(browse.path);
  $("add-here").disabled = !!adding;
  $("add-here").textContent = adding ? "PC에서 여는 중…" : open ? "이 프로젝트 보기" : "이 폴더로 시작";
}

/** Ask the deck on the PC to add the folder; the phone moves to it once its agent shows up. */
async function startProject(path) {
  const open = sessionAt(path);
  if (open) return location.replace(`#${encodeURIComponent(open.id)}`);
  if (adding) return;
  adding = { path, since: Date.now() };
  renderDirs();
  try {
    await api("/api/add", { path });
    poll();
  } catch (e) {
    adding = null;
    renderDirs();
    toast(`시작하지 못했습니다: ${errText(e)}`);
  }
}

function watchAdding() {
  if (!adding) return;
  const s = sessionAt(adding.path);
  if (s) {
    adding = null;
    if (location.hash === "#add") location.replace(`#${encodeURIComponent(s.id)}`);
  } else if (Date.now() - adding.since > 45_000) {
    adding = null;
    toast("프로젝트가 열리지 않았습니다. PC 화면을 확인하세요");
  }
  if (!$("add-view").hidden) renderDirs();
}

$("add-open").addEventListener("click", () => (location.hash = "add"));
$("add-here").addEventListener("click", () => browse.path && startProject(browse.path));
$("add-filter").addEventListener("input", renderDirs);

// ---------- Push notifications (through the relay; the PC's own page has none) ----------

let pushTried = false;
let pushReg = null;
let pushKey = "";

const b64uBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

function setPushUi(on) {
  const b = $("push");
  b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", on ? "알림 끄기" : "알림 켜기");
  b.title = on ? "알림 켜짐" : "알림 꺼짐";
}

async function initPush() {
  if (pushTried) return;
  pushTried = true;
  try {
    const r = await fetch("/push/key", { cache: "no-store" });
    if (!r.ok) return; // not set up on the relay, or the PC's own page
    pushKey = (await r.json()).key;
  } catch {
    return;
  }
  $("push").hidden = false;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return setPushUi(false);
  pushReg = await navigator.serviceWorker.register("/sw.js").catch(() => null);
  const sub = await pushReg?.pushManager.getSubscription().catch(() => null);
  const on = !!sub && Notification.permission === "granted";
  setPushUi(on);
  // Tell the relay again on every visit: its copy may be gone, or the browser may have rotated it.
  if (on) api("/push/subscribe", sub.toJSON()).catch(() => {});
}

$("push").addEventListener("click", async () => {
  if (!pushReg) {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    return toast(ios && !standalone ? "iPhone은 공유 → 홈 화면에 추가한 뒤, 홈 화면의 MYG Deck에서 알림을 켤 수 있습니다" : "이 브라우저는 알림을 지원하지 않습니다");
  }
  const btn = $("push");
  btn.disabled = true;
  try {
    const sub = await pushReg.pushManager.getSubscription();
    if (sub && btn.getAttribute("aria-pressed") === "true") {
      await api("/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
      setPushUi(false);
      return toast("알림을 껐습니다");
    }
    if ((await Notification.requestPermission()) !== "granted") {
      return toast("알림이 차단되어 있습니다. 브라우저 설정에서 이 사이트의 알림을 허용하세요");
    }
    const next = sub ?? (await pushReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(pushKey) }));
    await api("/push/subscribe", next.toJSON());
    setPushUi(true);
    toast("응답이 필요하거나 작업이 끝나면 알려 드립니다");
  } catch (e) {
    toast(`알림을 켜지 못했습니다: ${errText(e)}`);
  } finally {
    btn.disabled = false;
  }
});

// A notification tapped while the page is open: go to that project.
navigator.serviceWorker?.addEventListener("message", (e) => {
  const url = e.data?.open;
  if (typeof url === "string") location.hash = new URL(url, location.href).hash;
});

// ---------- Routing ----------

function route() {
  if (!$("login-view").hidden) return;
  const hash = location.hash.slice(1);
  const id = hash === "add" ? "" : decodeURIComponent(hash);
  detail?.close();
  detail = null;
  disarm();
  $("list-view").hidden = hash !== "";
  $("detail-view").hidden = !id;
  $("add-view").hidden = hash !== "add";
  placeBanner();
  if (hash === "add") {
    if (browsed) renderDirs();
    else openDir("");
  }
  if (id) {
    input.value = drafts[id] ?? "";
    input.disabled = false;
    $("stop").hidden = true;
    $("ask").hidden = $("hint").hidden = true;
    $("turn").replaceChildren();
    $("cli").textContent = "";
    detail = new Detail(id);
    input.dispatchEvent(new Event("input"));
  }
}
window.addEventListener("hashchange", route);

placeBanner();
poll().then(route);
