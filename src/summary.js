import { marked } from "marked";
import DOMPurify from "dompurify";
import { permissionLine } from "./logic.js";

const STATE = {
  working: ["⏳", "진행 중"],
  waiting: ["⏸", "대기"],
  done: ["✅", "완료"],
  failed: ["❌", "실패"],
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
  box.append(head);

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
  } else if (s) {
    const line = el("div", "s-line clickable", s.line);
    line.title = "눌러서 AI 답변 보기 (Enter)";
    line.onclick = () => card.toggleAnswer();
    box.append(line);
    if (s.what) box.append(el("div", "s-what", s.what));
    if (s.proof) box.append(el("div", s.proof.ok ? "s-proof ok" : "s-proof warn", `근거: ${s.proof.text}`));
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

  if (card.answerOpen && card.turn?.texts?.length) {
    const ans = el("div", "s-answer md");
    ans.innerHTML = DOMPurify.sanitize(marked.parse(card.turn.texts.join("\n\n")));
    ans.addEventListener("click", (e) => e.target.closest("a") && e.preventDefault());
    box.append(ans);
  }
}

/** Short lines for compact cards, the side column and the overview. */
export function summaryLines(card) {
  const s = card.summary;
  if (card.status === "working") return [card.statusText, ...card.turnTools.slice(-2)];
  if (card.status === "waiting") return [card.statusText, permissionLine(card.lastTool?.tool, card.lastTool?.detail)];
  if (s && (card.status === "done" || card.status === "failed")) {
    return [s.line, s.cause ? `원인: ${s.cause}` : s.proof ? `근거: ${s.proof.text}` : "", s.next ? `다음: ${s.next}` : ""].filter(Boolean);
  }
  return null;
}
