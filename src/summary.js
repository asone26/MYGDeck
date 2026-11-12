import { marked } from "marked";
import DOMPurify from "dompurify";
import { keyLabel, permissionLine, replySuggestions } from "./logic.js";

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

function minutes(since) {
  const m = Math.floor((Date.now() - since) / 60000);
  return m < 1 ? "방금 시작" : `${m}분째`;
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
  const [icon, label] = STATE[st] ?? ["", ""];
  const head = el("div", "s-head");
  if (st === "done") head.append(el("span", "s-state", `${icon} ${label}`)); // only "done" is worth a headline
  if (st === "working" && card.turnStart) head.append(el("span", "s-time", minutes(card.turnStart)));
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

  if (st === "working") {
    box.append(el("div", "s-line", card.statusText));
    const steps = el("ul", "s-steps");
    for (const t of card.turnTools.slice(-6)) steps.append(el("li", "", t));
    box.append(steps);
  } else if (st === "waiting") {
    box.append(el("div", "s-line", card.statusText));
    const next = el("div", "s-next");
    next.append(el("span", "", `다음: ${permissionLine(card.lastTool?.tool, card.lastTool?.detail)}`));
    next.append(
      button("허용", () => card.answerPermission(true), "ok"),
      button("거부", () => card.answerPermission(false)),
    );
    box.append(next);
  } else if (card.turn?.texts?.length && st !== "exited") {
    box.append(answer(card.turn.texts));
    // The answer asks the user something: one click answers it (A2).
    const replies = st === "done" && !card.menuOpen ? replySuggestions(card.turn.texts) : [];
    if (replies.length) {
      const row = el("div", "s-next s-replies");
      for (const r of replies) row.append(button(r.label, () => card.sendToAgent(r.text)));
      box.append(row);
    }
  } else if (card.statusText !== label) {
    box.append(el("div", "s-line", card.statusText));
  }
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
