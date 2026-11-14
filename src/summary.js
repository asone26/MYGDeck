import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { keyLabel, permissionLine, replySuggestions, suggestsClear, timeline } from "./logic.js";
import { statusIcon } from "./icons.js";

let hljsLoad = null;
const loadHljs = () => (hljsLoad ??= import("highlight.js/lib/common").then((m) => m.default));

const STATE = {
  idle: ["💬", "준비됨"],
  working: ["⏳", "진행 중"],
  waiting: ["⏸", "대기"],
  done: ["✅", "완료"],
  exited: ["⏹", "종료됨"],
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(label, onClick, cls = "") {
  const b = el("button", cls, label);
  b.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return b;
}

export function elapsed(since) {
  const sec = Math.floor((Date.now() - since) / 1000);
  if (sec < 60) return "방금";
  const [m, s] = [Math.floor(sec / 60), sec % 60];
  return s ? `${m}분 ${s}초` : `${m}분`;
}

/**
 * GUI view over the CLI (spec 3.2 ④-1): state, the user's request, live steps, permission buttons,
 * and when the turn ends the agent's own answer as-is (no generated summary).
 * Agent text is set with textContent; only the answer markdown is rendered, sanitized.
 */
export function renderSummary(card, box) {
  const st = card.status;
  // Rebuilding resets the scroll: stay at the bottom if the user was there, else keep their place in the history.
  const top = box.scrollTop;
  const atBottom = box.scrollHeight - top - box.clientHeight < 40;
  box.textContent = "";
  const hist = card.history ?? [];
  if (hist.length >= 2) {
    const outline = el("div", "s-outline");
    hist.forEach((h, idx) => {
      const label = h.ask ? `${idx + 1}. ${h.ask.slice(0, 22)}${h.ask.length > 22 ? "…" : ""}` : `${idx + 1}턴`;
      const b = button(label, () => box.querySelector(`.s-past[data-turn="${idx}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }), "s-jump");
      b.title = h.ask || "";
      outline.append(b);
    });
    if (card.turnAsk) {
      outline.append(button("현재", () => box.querySelector(".s-ask.cur")?.scrollIntoView({ behavior: "smooth", block: "start" }), "s-jump cur"));
    }
    box.append(outline);
  }
  hist.forEach((h, idx) => {
    const past = el("div", "s-past");
    past.dataset.turn = idx;
    if (h.ask) past.append(el("div", "s-ask", h.ask));
    if (h.texts.length) past.append(answer(h.texts, card));
    if (h.texts.length || h.checkpoint) {
      const bar = el("div", "s-past-bar");
      if (h.texts.length) {
        const cb = button("복사", async () => {
          await navigator.clipboard.writeText(h.texts.join("\n\n")).catch(() => {});
          cb.textContent = "복사됨 ✓";
          setTimeout(() => { if (cb.isConnected) cb.textContent = "복사"; }, 1200);
        });
        bar.append(cb);
      }
      if (h.checkpoint) {
        bar.append(button("이 턴 직전으로 복구", () => card.restoreCheckpoint(h.checkpoint), "s-restore"));
      }
      past.append(bar);
    }
    box.append(past);
  });
  renderCurrent(card, box, st);
  box.scrollTop = atBottom ? box.scrollHeight : top;
}

function renderCurrent(card, box, st) {
  const [, label] = STATE[st] ?? ["", ""];
  const head = el("div", "s-head");
  if (st === "done") {
    // only "done" is worth a headline
    const h = el("span", "s-state");
    h.innerHTML = statusIcon("done");
    h.append(label);
    head.append(h);
  }
  if (st === "working" && card.turnStart) head.append(el("span", "s-time s-elapsed", elapsed(card.turnStart)));
  if (card.rotating) head.append(el("span", "s-time", "· 새 세션으로 이어가는 중"));
  box.append(head);
  // Permission prompts get their own buttons; any other CLI menu must be answered in the CLI, on request.
  if (card.menuOpen && st !== "waiting") {
    const menu = el("div", "s-next");
    const choices = card.menuChoices ?? [];
    if (choices.length) {
      menu.append(el("span", "s-q", card.menuQuestion || "선택하세요:"));
      // One key per write: the CLI may not split arrows + Enter sent as one chunk.
      for (const c of choices) menu.append(button(c.label, () => c.keys.forEach((k, i) => setTimeout(() => card.agent.write(k), i * 60))));
      menu.append(button("취소", () => card.agent.write("\x1b")));
    } else {
      menu.append(el("span", "", "CLI에서 선택이 필요합니다."), button(keyLabel("CLI 열기 (Ctrl+.)"), () => card.toggleView(), "ok"));
    }
    box.append(menu);
  }

  // The user's own instruction stays on top while it runs and after it ends.
  if (card.turnAsk && st !== "exited") box.append(el("div", "s-ask cur", card.turnAsk));

  // While the agent runs: what the CLI shows, in its order (texts, tool runs with failures, the to-do list).
  const running = st === "working" || st === "waiting";
  if (running) {
    const todo = todos(card.live?.todos);
    if (todo) box.append(todo);
    // Without a transcript (agents other than Claude Code) the hooks' tool list is all there is.
    const flow = card.live
      ? timeline(card.live, st === "working" ? card.turnTools.at(-1) : null)
      : card.turnTools.length ? [{ kind: "tools", items: card.turnTools.map((text) => ({ text, error: null, full: null })) }] : [];
    if (flow.length) box.append(flowEl(card, flow, true));
    else box.append(el("div", "s-line", card.statusText));
  }
  if (st === "waiting") {
    const next = el("div", "s-next");
    next.append(el("span", "", `다음: ${permissionLine(card.lastTool?.tool, card.lastTool?.detail)}`));
    next.append(
      button("허용", () => card.answerPermission(true), "ok"),
      button("세션 항상 허용", () => card.answerPermission("always")),
      button("거부", () => card.answerPermission(false)),
    );
    box.append(next);
  } else if (running) {
    // shown above
  } else if (card.turn?.texts?.length && st !== "exited") {
    const ans = flowEl(card, timeline(card.turn), false);
    // The view is rebuilt often (and the transcript is read twice): the answer rises in once per turn.
    if (st === "done" && card.revealedSeq !== card.turnSeq) {
      card.revealedSeq = card.turnSeq;
      ans.classList.add("enter");
      head.classList.add("enter");
    }
    box.append(ans);
    // The answer asks the user something: one click answers it (A2).
    const replies = st === "done" && !card.menuOpen ? replySuggestions(card.turn.texts) : [];
    // The answer recommends starting over (/clear): one click does it.
    const fresh = st === "done" && !card.menuOpen && suggestsClear(card.turn.texts);
    const others = st === "done" && !card.menuOpen ? (card.app?.cards ?? []).filter((c) => c !== card) : [];
    const canRestore = st === "done" && !card.menuOpen && !!card.turnCheckpoint;
    if (replies.length || fresh || others.length || canRestore) {
      const row = el("div", "s-next s-replies");
      for (const r of replies) row.append(button(r.label, () => card.sendToAgent(r.text)));
      if (fresh) row.append(button(`새 대화 (${card.adapter?.clear_cmd || "다시 시작"})`, () => card.freshSession(), "fresh"));
      if (canRestore) {
        const rb = button("되돌리기", () => card.restoreCheckpoint(), "s-restore");
        rb.title = "이 턴 직전 체크포인트로 되돌리기";
        row.append(rb);
      }
      if ((card.explorer?.status?.size ?? 0) > 0) {
        row.append(
          button("테스트 실행", () => card.quickRun()),
          button("변경 리뷰 요청", () => card.sendToAgent("방금 변경한 코드에서 엣지케이스나 버그가 없는지 점검해줘.")),
          button("지금 커밋", () => card.explorer.commit()),
        );
      }
      const copyBtn = button("답변 복사", async () => {
        await navigator.clipboard.writeText(card.turn.texts.join("\n\n")).catch(() => {});
        copyBtn.textContent = "복사됨 ✓";
        setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = "답변 복사"; }, 1400);
      });
      const expBtn = button("대화 내보내기", () => {
        const md = exportMarkdown(card);
        const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `${card.name}-chat.md`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
      row.append(copyBtn, expBtn);
      if (others.length) {
        const sel = el("select", "s-relay");
        sel.title = "이 답변을 다른 프로젝트 카드 입력창으로 전달";
        sel.append(new Option("다른 카드에 전달…", ""));
        for (const c of others) sel.append(new Option(`→ ${c.name}`, c.id));
        sel.onchange = () => {
          const target = others.find((c) => c.id === sel.value);
          sel.value = "";
          if (!target) return;
          const body = card.turn.texts.join("\n\n").slice(0, 2000);
          target.composer.insert(`[${card.name} 작업 결과]\n${body}\n`);
          card.app.setActive(card.app.cards.indexOf(target));
        };
        row.append(sel);
      }
      box.append(row);
    }
  } else if (card.statusText !== label) {
    box.append(el("div", "s-line", card.statusText));
  }
}

/** Texts as markdown; tool runs as compact lists. The live run stays open, finished ones fold (the user can unfold). */
function flowEl(card, flow, live) {
  const wrap = el("div", "s-flow");
  flow.forEach((item, i) => {
    if (item.kind === "text") return wrap.append(answer([item.text], card));
    const now = live && i === flow.length - 1;
    const list = el("ul", now ? "s-steps now" : "s-steps");
    for (const s of item.items) {
      const li = el("li", s.error ? "fail" : "", s.text);
      if (s.error) {
        li.append(el("div", "s-err", s.error));
        li.title = s.full;
      }
      list.append(li);
    }
    if (now) return wrap.append(list);
    const fails = item.items.filter((s) => s.error).length;
    const fold = el("details", fails ? "s-tools has-fail" : "s-tools");
    fold.open = card.openTools.has(i);
    fold.ontoggle = () => (fold.open ? card.openTools.add(i) : card.openTools.delete(i));
    fold.append(el("summary", "", `도구 ${item.items.length}개${fails ? ` · 실패 ${fails}` : ""}  ·  ${item.items.at(-1).text}`), list);
    wrap.append(fold);
  });
  return wrap;
}

/** The agent's to-do list as the CLI draws it: done, doing (its "-ing" form), to do. */
function todos(list) {
  if (!list?.length) return null;
  const done = list.filter((t) => t.status === "completed").length;
  const box = el("div", "s-todo");
  box.append(el("div", "s-todo-head", `할 일 ${done}/${list.length}`));
  const ul = el("ul");
  for (const t of list) ul.append(el("li", t.status, t.status === "in_progress" ? t.active || t.content : t.content));
  box.append(ul);
  return box;
}

const FILE_REF_RE = /^(?:[\w.-]+\/)*[\w.-]+\.[a-z0-9]{1,8}(?::\d+(?::\d+)?|#L\d+(?:-\d+)?)?$/i;

function answer(texts, card = null) {
  const ans = el("div", "s-answer md");
  ans.innerHTML = DOMPurify.sanitize(marked.parse(texts.join("\n\n")));
  ans.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(a.href)) openUrl(a.href).catch(() => {});
  });
  if (card?.viewer) {
    for (const code of ans.querySelectorAll("code")) {
      if (code.closest("pre")) continue;
      const raw = code.textContent.trim();
      if (!FILE_REF_RE.test(raw) || raw.startsWith("http")) continue;
      const rel = raw.replace(/(?::\d+(?::\d+)?|#L\d+(?:-\d+)?)$/, "");
      const m = raw.match(/(?::(\d+)|#L(\d+))/);
      const line = m ? Number(m[1] || m[2]) : null;
      code.classList.add("s-file");
      code.title = "클릭하면 코드 뷰어로 열기";
      code.onclick = (e) => {
        e.stopPropagation();
        card.viewer.open(rel, "code", line);
      };
    }
  }
  for (const pre of ans.querySelectorAll("pre")) {
    const codeEl = pre.querySelector("code");
    const langMatch = codeEl?.className.match(/language-([\w-]+)/);
    if (codeEl && langMatch) {
      loadHljs().then((hljs) => {
        if (codeEl.isConnected && hljs.getLanguage(langMatch[1])) {
          codeEl.innerHTML = hljs.highlight(codeEl.textContent, { language: langMatch[1], ignoreIllegals: true }).value;
          codeEl.classList.add("hljs");
        }
      });
    }
    const actions = el("div", "code-acts");
    const btn = el("button", "code-copy", "복사");
    btn.type = "button";
    btn.onclick = async () => {
      const code = codeEl?.textContent ?? pre.textContent ?? "";
      await navigator.clipboard.writeText(code).catch(() => {});
      btn.textContent = "복사됨";
      setTimeout(() => { if (btn.isConnected) btn.textContent = "복사"; }, 1400);
    };
    actions.append(btn);
    if (card?.composer) {
      const quote = el("button", "code-quote", "인용");
      quote.type = "button";
      quote.title = "입력창에 코드 블록 넣기";
      quote.onclick = () => {
        const code = codeEl?.textContent ?? pre.textContent ?? "";
        card.composer.insert(`\n\`\`\`\n${code.trimEnd()}\n\`\`\`\n`);
      };
      actions.append(quote);
    }
    pre.append(actions);
  }
  return ans;
}

/** Export a card's conversation history + current turn as Markdown. */
export function exportMarkdown(card) {
  const sections = [`# ${card.name} (${card.root})`];
  for (const h of card.history ?? []) {
    if (h.ask) sections.push(`## 요청\n${h.ask}`);
    if (h.texts?.length) sections.push(`## 답변\n${h.texts.join("\n\n")}`);
  }
  if (card.turnAsk) sections.push(`## 요청\n${card.turnAsk}`);
  const cur = card.turn?.texts ?? card.live?.flow?.filter((x) => x.kind === "text").map((x) => x.text) ?? [];
  if (cur.length) sections.push(`## 답변\n${cur.join("\n\n")}`);
  return sections.join("\n\n");
}

/** Short lines for compact cards, the side column and the overview. */
export function summaryLines(card) {
  if (card.status === "working") return [card.statusText, ...card.turnTools.slice(-2)];
  if (card.status === "waiting") return [card.statusText, permissionLine(card.lastTool?.tool, card.lastTool?.detail)];
  return null;
}
