import { invoke } from "@tauri-apps/api/core";
import { ICONS, icon } from "./icons.js";
import { L, getLang, setLang } from "./i18n.js";
import { keyLabel } from "./logic.js";

const KEYS_STORE = "mygdeck.keys";
export const loadKeyOverrides = () => {
  try {
    return JSON.parse(localStorage.getItem(KEYS_STORE) || "{}");
  } catch {
    return {};
  }
};

export function openBroadcast(app, showOverlay, closeOverlay) {
  if (!app.cards.length) return;
  const overlay = showOverlay("broadcast");
  const box = document.createElement("div");
  box.className = "qo mod-box";
  box.innerHTML = `<div class="keys-head"><span class="qo-title">${L("여러 프로젝트에 동시 지시 (브로드캐스트)", "Broadcast Prompt")}</span><button class="keys-close" aria-label="${L("닫기", "Close")}">${icon(ICONS.X)}</button></div>
    <div class="mod-list"></div>
    <textarea class="mod-ta" rows="4" placeholder="${L("선택한 모든 카드에 동시에 보낼 지시를 입력하세요…", "Enter prompt to send to all selected cards…")}"></textarea>
    <div class="mod-foot"><button class="mod-send">${L("선택한 카드에 전송", "Send to selected")}</button></div>`;
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

export function openProjectSettings(card, save, showOverlay, closeOverlay) {
  const overlay = showOverlay("proj-settings");
  const box = document.createElement("div");
  box.className = "qo mod-box";
  box.innerHTML = `<div class="keys-head"><span class="qo-title">${card.name} · ${L("자동화 및 알림 설정", "Automation & Notifications")}</span><button class="keys-close" aria-label="${L("닫기", "Close")}">${icon(ICONS.X)}</button></div>
    <label class="mod-field"><span>${L("Worktree 생성 시 실행할 명령 (예: <code>npm ci</code>)", "Setup command on new worktree (e.g. <code>npm ci</code>)")}</span><input class="qo-in f-wt" placeholder="${L("비워 두면 .env 파일만 자동 복사", "Leave empty to copy .env files only")}"></label>
    <label class="mod-field"><span>${L("턴 종료 후 자동 검증 명령 (예: <code>npm test</code>)", "Post-turn verify command (e.g. <code>npm test</code>)")}</span><input class="qo-in f-pt" placeholder="${L("비워 두면 실행 안 함", "Leave empty to disable")}"></label>
    <label class="mod-chk"><input type="checkbox" class="f-mute"> <span>${L("이 프로젝트의 OS 알림 음소거", "Mute OS notifications for this project")}</span></label>
    <div class="mod-foot"><button class="mod-send">${L("저장", "Save")}</button></div>`;
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
    card.syncMute?.();
    save();
    closeOverlay();
  };
  overlay.replaceChildren(box);
  wt.focus();
}

export function openMobileGuide(showOverlay, closeOverlay) {
  const overlay = showOverlay("mobile-guide");
  const url = "https://mygdeck.<your-subdomain>.workers.dev";
  const box = document.createElement("div");
  box.className = "qo mod-box";
  box.innerHTML = `<div class="keys-head"><span class="qo-title">${L("모바일 대시보드 연결 안내", "Mobile Dashboard Guide")}</span><button class="keys-close" aria-label="${L("닫기", "Close")}">${icon(ICONS.X)}</button></div>
    <p class="mod-p">${L("PC 데몬을 Cloudflare 터널로 연결해 휴대폰에서 상태 확인·승인·지시 전송을 할 수 있습니다.", "Connect your PC daemon via Cloudflare Tunnel to monitor status, approve prompts, and send tasks from your phone.")}</p>
    <div class="mod-row"><code>${url}</code><button class="mod-copy">${L("주소 복사", "Copy URL")}</button></div>
    <ol class="mod-steps">
      <li>${L("터미널에서 <code>mygdeck-cli mobile on --url &lt;worker-url&gt;</code> 실행 (<code>docs/mobile.md</code> 참고)", "Run <code>mygdeck-cli mobile on --url &lt;worker-url&gt;</code> in your terminal (see <code>docs/mobile.md</code>)")}</li>
      <li>${L("휴대폰 브라우저에서 위 주소를 열고 홈 화면에 추가(PWA)", "Open your Worker URL on mobile and Add to Home Screen (PWA)")}</li>
      <li>${L("종료할 때는 <code>mygdeck-cli mobile off</code>", "Run <code>mygdeck-cli mobile off</code> to stop")}</li>
    </ol>`;
  box.querySelector(".keys-close").onclick = closeOverlay;
  box.querySelector(".mod-copy").onclick = async (e) => {
    await navigator.clipboard.writeText(url).catch(() => {});
    e.target.textContent = L("복사됨", "Copied");
  };
  overlay.replaceChildren(box);
}

export function openFind(app) {
  let bar = document.getElementById("find-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "find-bar";
    bar.className = "find-bar";
    bar.innerHTML = `<div class="find-row"><input class="find-in" placeholder="${L("전체 대화 · 화면 검색…", "Find in chats & view…")}" spellcheck="false"><button class="find-prev" title="${L("이전 (Shift+Enter)", "Previous (Shift+Enter)")}">▲</button><button class="find-next" title="${L("다음 (Enter)", "Next (Enter)")}">▼</button><button class="find-x" title="${L("닫기 (Esc)", "Close (Esc)")}">✕</button></div><div class="find-hits" hidden></div>`;
    document.body.append(bar);
    const input = bar.querySelector(".find-in");
    const hitsBox = bar.querySelector(".find-hits");
    const run = (back = false) => {
      const q = input.value;
      if (!q) return;
      const cur = app.cards[app.active];
      const hitTerm = cur && (!cur.guiShown ? cur.agent?.findNext(q, back) : cur.shell && !cur.$(".shell")?.hidden ? cur.shell.findNext(q, back) : false);
      if (!hitTerm) window.find(q, false, back, true, false, false, false);
    };
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
        b.innerHTML = `<b>${h.c.name}</b><span>${h.cur ? L("현재 턴", "Current turn") : L(`${h.ti + 1}턴`, `Turn ${h.ti + 1}`)} · ${h.snippet.replace(/</g, "&lt;")}</span>`;
        b.onclick = () => {
          app.setActive(h.ci);
          const sel = h.cur ? ".s-ask.cur" : `.s-past[data-turn="${h.ti}"]`;
          requestAnimationFrame(() => h.c.el.querySelector(sel)?.scrollIntoView({ behavior: "smooth", block: "start" }));
        };
        hitsBox.append(b);
      }
    };
    const closeFind = () => {
      bar.hidden = true;
      for (const c of app.cards) { c.agent?.findNext(""); c.shell?.findNext(""); }
      app.cards[app.active]?.focusDefault();
    };
    input.oninput = renderHits;
    input.onkeydown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeFind(); }
      else if (e.key === "Enter") { e.preventDefault(); run(e.shiftKey); }
    };
    bar.querySelector(".find-prev").onclick = () => run(true);
    bar.querySelector(".find-next").onclick = () => run(false);
    bar.querySelector(".find-x").onclick = closeFind;
  }
  bar.hidden = false;
  const input = bar.querySelector(".find-in");
  input.focus();
  input.select();
}

/** Ctrl+Shift+F: search text inside project files and open in the code viewer. */
export function openCodeSearch(app, toggleOverlay, closeOverlay) {
  const c = app.cards[app.active];
  if (!c) return;
  const overlay = toggleOverlay("codesearch");
  if (!overlay) return;
  overlay.innerHTML = `<div class="qo pal"><input class="qo-in" placeholder="${L(`${c.name} 코드 내 텍스트 검색…`, `Search text in ${c.name}…`)}" spellcheck="false"><ul class="qo-list"></ul></div>`;
  const input = overlay.querySelector("input");
  const list = overlay.querySelector("ul");
  let hits = [];
  let sel = 0;
  let timer = null;
  const open = () => {
    const h = hits[sel];
    closeOverlay();
    if (h) c.viewer.open(h.path, "code", h.line);
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

export async function openDoctor(toggleOverlay) {
  const overlay = toggleOverlay("doctor");
  if (!overlay) return;
  const box = document.createElement("div");
  box.className = "qo pal";
  box.innerHTML = `<div class="qo-title">${L("환경 진단 (Doctor)", "Environment Diagnostics (Doctor)")}</div><div class="doc-list"><div class="muted">${L("점검 중…", "Checking…")}</div></div>`;
  overlay.replaceChildren(box);
  const items = await invoke("doctor_check").catch(() => []);
  const list = box.querySelector(".doc-list");
  list.textContent = "";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = `doc-row ${it.ok ? "ok" : "bad"}`;
    row.innerHTML = `<b>${it.ok ? "✓" : "✕"} ${it.name}</b><span></span>`;
    row.querySelector("span").textContent = it.detail;
    list.append(row);
  }
}

export function openDeckSettings(ctx, toggleOverlay, closeOverlay) {
  const overlay = toggleOverlay("deck-settings");
  if (!overlay) return;
  const box = document.createElement("div");
  box.className = "qo pal";
  const soundOn = localStorage.getItem("mygdeck-sound") !== "off";
  const ov = loadKeyOverrides();
  const langLabel = getLang() === "en" ? "English" : "한국어";
  box.innerHTML = `<div class="qo-title">${L("통합 설정", "Settings")}</div>
    <div class="ds-grid">
      <label><span>${L("언어 (Language)", "Language")}</span><button type="button" class="ds-lang">${langLabel}</button></label>
      <label><span>${L("테마", "Theme")}</span><button type="button" class="ds-theme">${L("전환", "Switch")} (${document.documentElement.dataset.theme || "dark"})</button></label>
      <label><span>${L("글자 크기", "Font size")} (${ctx.getFontSize()}px)</span><span><button type="button" class="ds-fminus">-</button> <button type="button" class="ds-fplus">+</button></span></label>
      <label><span>${L("알림 효과음", "Notification sound")}</span><button type="button" class="ds-sound">${soundOn ? L("켜짐", "On") : L("꺼짐", "Off")}</button></label>
      <label><span>${L("커맨드 팔레트 단축키", "Command palette shortcut")}</span><button type="button" class="ds-remap" data-act="palette">${keyLabel(`Ctrl+${ov.palette || "K"}`)}</button></label>
      <label><span>${L("파일 빠른 열기 단축키", "Quick open shortcut")}</span><button type="button" class="ds-remap" data-act="quick">${keyLabel(`Ctrl+${ov.quick || "P"}`)}</button></label>
      <label><span>${L("전체 단축키 목록", "All shortcuts")}</span><button type="button" class="ds-keys">${L("보기", "View")}</button></label>
    </div>`;
  box.querySelector(".ds-lang").onclick = () => {
    setLang(getLang() === "en" ? "ko" : "en");
    location.reload();
  };
  box.querySelector(".ds-theme").onclick = (e) => { ctx.cycleTheme(); e.target.textContent = `${L("전환", "Switch")} (${document.documentElement.dataset.theme || "dark"})`; };
  box.querySelector(".ds-fminus").onclick = () => { ctx.applyFontSize(ctx.getFontSize() - 1); box.querySelector(".ds-fminus").closest("label").firstElementChild.textContent = `${L("글자 크기", "Font size")} (${ctx.getFontSize()}px)`; };
  box.querySelector(".ds-fplus").onclick = () => { ctx.applyFontSize(ctx.getFontSize() + 1); box.querySelector(".ds-fplus").closest("label").firstElementChild.textContent = `${L("글자 크기", "Font size")} (${ctx.getFontSize()}px)`; };
  box.querySelector(".ds-sound").onclick = (e) => {
    const next = localStorage.getItem("mygdeck-sound") === "off" ? "on" : "off";
    localStorage.setItem("mygdeck-sound", next);
    e.target.textContent = next === "on" ? L("켜짐", "On") : L("꺼짐", "Off");
  };
  for (const rb of box.querySelectorAll(".ds-remap")) {
    rb.onclick = () => {
      const ch = window.prompt(L("새 키 문자를 입력하세요 (A-Z, 기본값 복원은 빈칸):", "Enter new key letter (A-Z, empty to reset):"), "")?.trim().toUpperCase();
      if (ch === undefined) return;
      const cur = loadKeyOverrides();
      if (!ch) delete cur[rb.dataset.act];
      else if (/^[A-Z]$/.test(ch)) cur[rb.dataset.act] = ch;
      localStorage.setItem(KEYS_STORE, JSON.stringify(cur));
      rb.textContent = keyLabel(`Ctrl+${cur[rb.dataset.act] || (rb.dataset.act === "palette" ? "K" : "P")}`);
    };
  }
  box.querySelector(".ds-keys").onclick = () => { closeOverlay(); openShortcuts(toggleOverlay, closeOverlay); };
  overlay.replaceChildren(box);
}

export function openShortcuts(toggleOverlay, closeOverlay) {
  const overlay = toggleOverlay("shortcuts");
  if (!overlay) return;
  const items = [
    ["Ctrl+K", L("커맨드 팔레트 열기", "Open command palette")],
    ["Ctrl+F", L("화면 내 텍스트 검색", "Find in view")],
    ["Ctrl+Shift+F", L("프로젝트 코드 내용 검색", "Search in project files")],
    ["Ctrl+Space", L("다음 대기 프로젝트로 이동", "Jump to next waiting project")],
    ["Ctrl+0", L("전체 보기 열기 / 닫기", "Toggle overview grid")],
    ["Ctrl+1~9", L("해당 번호 프로젝트로 이동", "Switch to project #")],
    ["Ctrl+PgUp / PgDn", L("이전 / 다음 프로젝트", "Previous / Next project")],
    ["Ctrl+'", L("프로젝트 폴더 추가", "Add project folder")],
    ["Ctrl+P", L("파일 빠른 열기", "Quick open file")],
    ["Ctrl+.", L("CLI / GUI 화면 전환", "Toggle GUI / CLI view")],
    ["Ctrl+`", L("하단 터미널 열기 / 닫기", "Toggle bottom shell")],
    ["Ctrl+;", L("탐색기 · 뷰어 열기 / 닫기", "Toggle spec panel")],
    ["Ctrl+I", L("선택한 코드 위치 입력창에 넣기", "Insert selection into composer")],
    ["Ctrl++ / -", L("카드 크기 조절", "Adjust card density")],
    ["Ctrl+Tab", L("카드 내 포커스 전환", "Cycle focus within card")],
    ["Ctrl+Q", L("실행 중인 에이전트 중단", "Stop running agent")],
    ["Ctrl+F4", L("현재 프로젝트 닫기", "Close current project")],
    ["Esc", L("팝업 닫기", "Close overlay")],
  ];
  const box = document.createElement("div");
  box.className = "qo keys-box";
  box.innerHTML = `<div class="keys-head"><span class="qo-title">${L("키보드 단축키", "Keyboard Shortcuts")}</span><button class="keys-close" aria-label="${L("닫기", "Close")}">${icon(ICONS.X)}</button></div><div class="keys-grid"></div>`;
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
