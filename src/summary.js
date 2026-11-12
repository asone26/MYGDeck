import { marked } from "marked";
import DOMPurify from "dompurify";
import { keyLabel, permissionLine, replySuggestions, suggestsClear, timeline } from "./logic.js";
import { statusIcon } from "./icons.js";

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
  for (const h of card.history ?? []) {
    const past = el("div", "s-past");
    if (h.ask) past.append(el("div", "s-ask", h.ask));
    if (h.texts.length) past.append(answer(h.texts));
    box.append(past);
  }
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
  if (card.turnAsk && st !== "exited") box.append(el("div", "s-ask", card.turnAsk));

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
    if (replies.length || fresh) {
      const row = el("div", "s-next s-replies");
      for (const r of replies) row.append(button(r.label, () => card.sendToAgent(r.text)));
      if (fresh) row.append(button(`새 대화 (${card.adapter?.clear_cmd || "다시 시작"})`, () => card.freshSession(), "fresh"));
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
    if (item.kind === "text") return wrap.append(answer([item.text]));
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

function answer(texts) {
  const ans = el("div", "s-answer md");
  ans.innerHTML = DOMPurify.sanitize(marked.parse(texts.join("\n\n")));
  ans.addEventListener("click", (e) => e.target.closest("a") && e.preventDefault());
  return ans;
}

/** Short lines for compact cards, the side column and the overview. */
export function summaryLines(card) {
  if (card.status === "working") return [card.statusText, ...card.turnTools.slice(-2)];
  if (card.status === "waiting") return [card.statusText, permissionLine(card.lastTool?.tool, card.lastTool?.detail)];
  return null;
}
