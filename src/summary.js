import { marked } from "marked";
import DOMPurify from "dompurify";
import { permissionLine } from "./logic.js";

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
  box.textContent = "";
  const [icon, label] = STATE[st] ?? ["", ""];
  const head = el("div", "s-head");
  head.append(el("span", "s-state", `${icon} ${label}`));
  if (st === "working" && card.turnStart) head.append(el("span", "s-time", minutes(card.turnStart)));
  const limit = card.adapter?.context_limit;
  if (card.rotating) head.append(el("span", "s-time", "· 새 세션으로 이어가는 중"));
  else if (limit && card.contextTokens) head.append(el("span", "s-time", `· 컨텍스트 ${Math.round((card.contextTokens / limit) * 100)}%`));
  const cli = button("CLI 보기 (Alt+C)", () => card.toggleView());
  cli.classList.add("s-cli");
  head.append(cli);
  box.append(head);
  // Permission prompts get their own buttons; any other CLI menu must be answered in the CLI, on request.
  if (card.menuOpen && st !== "waiting") {
    const menu = el("div", "s-next");
    menu.append(el("span", "", "CLI에서 선택이 필요합니다."), button("CLI 열기 (Alt+C)", () => card.toggleView(), "ok"));
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
  } else {
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
