import { marked } from "marked";
import DOMPurify from "dompurify";
import { permissionLine } from "./logic.js";

const STATE = {
  idle: ["💬", "준비됨"],
  working: ["⏳", "진행 중"],
  waiting: ["⏸", "대기"],
  done: ["✅", "완료"],
  failed: ["❌", "실패"],
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
 * Summary card over the CLI (spec 3.2 ④-1), top to bottom:
 * what happened → can it be trusted → where are we → what next (always last).
 * Agent text is set with textContent; only the answer markdown is rendered, sanitized.
 */
export function renderSummary(card, box) {
  const st = card.status;
  const s = card.summary;
  box.textContent = "";
  const [icon, label] = STATE[st] ?? ["", ""];
  const head = el("div", "s-head");
  head.append(el("span", "s-state", `${icon} ${label}`));
  if (st === "working" && card.turnStart) head.append(el("span", "s-time", minutes(card.turnStart)));
  const limit = card.adapter?.context_limit;
  if (card.rotating) head.append(el("span", "s-time", "· 새 세션으로 이어가는 중"));
  else if (limit && card.contextTokens) head.append(el("span", "s-time", `· 컨텍스트 ${Math.round((card.contextTokens / limit) * 100)}%`));
  box.append(head);
  // Permission prompts get their own buttons; any other CLI menu must be answered in the CLI, on request.
  if (card.menuOpen && st !== "waiting") {
    const menu = el("div", "s-next");
    menu.append(el("span", "", "CLI에서 선택이 필요합니다."), button("CLI 열기 (Alt+C)", () => card.toggleView(), "ok"));
    box.append(menu);
  }

  if (st === "idle") {
    box.append(el("div", "s-line", "아래 입력창에 지시를 입력하세요."));
    box.append(el("div", "s-what", "작업이 시작되면 진행 상황이, 끝나면 결과·다음 할 일이 여기에 표시됩니다."));
  } else if (st === "working") {
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
  } else if (st === "exited") {
    box.append(el("div", "s-line", card.statusText));
  } else if (s) {
    if (s.ask) box.append(el("div", "s-ask", `요청: ${s.ask}`));
    const line = el("div", "s-line clickable", s.line);
    line.title = "눌러서 AI 답변 보기 (Enter)";
    line.onclick = () => card.toggleAnswer();
    box.append(line);
    if (s.what) box.append(el("div", "s-what", s.what));
    if (s.cause) box.append(el("div", "s-cause", `원인: ${s.cause}`));
    if (s.big) box.append(el("div", "s-big", s.big));
    if (s.next) {
      const next = el("div", "s-next");
      next.append(el("span", "", `다음: "${s.next}"`), button("보내기", () => card.sendToAgent(s.next), "ok"));
      box.append(next);
    }
  }

  const acts = el("div", "s-acts");
  if (card.turn?.texts?.length && st !== "working") acts.append(button(card.answerOpen ? "답변 접기" : "답변 보기", () => card.toggleAnswer()));
  acts.append(button("CLI 보기 (Alt+C)", () => card.toggleView()));
  box.append(acts);

  if (card.answerOpen && card.turn?.texts?.length) box.append(answer(card.turn.texts));

  if (card.history.length) box.append(el("div", "s-hist-title", "이전 작업"));
  for (const h of card.history) {
    const d = el("details", "s-hist");
    d.open = !!h.open;
    d.ontoggle = () => (h.open = d.open);
    const s = h.summary;
    d.append(el("summary", "", `${STATE[s.state]?.[0] ?? ""} ${s.ask ? `${s.ask} → ` : ""}${s.line}`));
    if (s.cause) d.append(el("div", "s-cause", `원인: ${s.cause}`));
    if (h.turn?.texts?.length) d.append(answer(h.turn.texts));
    box.append(d);
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
  const s = card.summary;
  if (card.status === "working") return [card.statusText, ...card.turnTools.slice(-2)];
  if (card.status === "waiting") return [card.statusText, permissionLine(card.lastTool?.tool, card.lastTool?.detail)];
  if (s && (card.status === "done" || card.status === "failed")) {
    return [s.line, s.cause ? `원인: ${s.cause}` : "", s.next ? `다음: ${s.next}` : ""].filter(Boolean);
  }
  return null;
}
