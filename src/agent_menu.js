import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { ICONS, icon } from "./icons.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Render the bottom-left agent picker button inside the card's composer. */
export function renderAgentPick(card) {
  const pick = card.pick;
  closeAgentMenu(card);
  card.$(".composer").prepend(pick);
  const curLabel = card.adapter ? `${card.adapter.name}${card.adapter.detected ? "" : " (미설치)"}` : (card.cfg.command ? "custom" : "shell");
  pick.innerHTML = `<span class="agent-lbl"></span>${icon(ICONS.ChevronDown, "agent-chev")}`;
  pick.querySelector(".agent-lbl").textContent = curLabel;
  pick.disabled = !card.adapter;
}

/** Open the floating menu to renew the session, switch agents, or manage git worktrees. */
export function openAgentMenu(card) {
  if (!card.adapter) return;
  closeAgentMenu(card);
  const pop = document.createElement("div");
  pop.className = "agent-pop";
  pop.setAttribute("role", "menu");
  pop.style.setProperty("--pc", card.color);

  const head = document.createElement("div");
  head.className = "agent-pop-head";
  head.innerHTML = `<span class="agent-pop-dot"></span><span class="agent-pop-name"></span><span class="agent-pop-tag">현재</span>`;
  head.querySelector(".agent-pop-name").textContent = `${card.adapter.name}${card.adapter.detected ? "" : " (미설치)"}`;
  pop.append(head);

  const addItem = ({ ic, label, sub, value, badge, badgeOff, disabled, danger }) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `agent-item${danger ? " danger" : ""}`;
    b.setAttribute("role", "menuitem");
    if (disabled) b.disabled = true;
    b.innerHTML = `${icon(ic)}<span class="agent-item-text"><span class="agent-item-lbl"></span>${sub ? `<span class="agent-item-sub"></span>` : ""}</span>${badge ? `<span class="agent-pop-badge${badgeOff ? " off" : ""}"></span>` : ""}`;
    b.querySelector(".agent-item-lbl").textContent = label;
    if (sub) b.querySelector(".agent-item-sub").textContent = sub;
    if (badge) b.querySelector(".agent-pop-badge").textContent = badge;
    b.onclick = () => {
      closeAgentMenu(card);
      onAgentPick(card, value);
    };
    pop.append(b);
  };
  const addSep = () => {
    const s = document.createElement("div");
    s.className = "agent-pop-sep";
    pop.append(s);
  };

  addItem({ ic: ICONS.RotateCw, label: "새 세션으로 이어가기", sub: "진행 내역 저장 후 새 대화 시작", value: "@renew" });
  const others = card.app.adapters.filter((a) => a.name !== card.adapter?.name);
  if (others.length) {
    addSep();
    for (const a of others) {
      addItem({
        ic: ICONS.ArrowRight,
        label: a.name,
        value: a.name,
        badge: a.detected ? "전환" : "미설치",
        badgeOff: !a.detected,
        disabled: !a.detected,
      });
    }
  }
  addSep();
  addItem({ ic: ICONS.GitBranch, label: "worktree로 하나 더 열기", value: "@worktree" });
  if (/-wt\d+$/.test(card.root)) {
    addItem({ ic: ICONS.GitMerge, label: "원래 폴더에 합치기", value: "@wt-merge" });
    addItem({ ic: ICONS.X, label: "이 worktree 버리기", value: "@wt-remove", danger: true });
  }

  document.body.append(pop);
  const r = card.pick.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const openUp = r.top - pr.height - 6 >= 8 || r.bottom + pr.height + 6 > window.innerHeight - 8;
  const top = openUp ? Math.max(8, r.top - pr.height - 6) : Math.min(window.innerHeight - pr.height - 8, r.bottom + 6);
  const left = Math.min(Math.max(8, r.left), window.innerWidth - pr.width - 8);
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;

  card.agentPop = pop;
  card.pick.classList.add("open");
  card.pick.setAttribute("aria-expanded", "true");

  const onPointerDown = (e) => { if (!pop.contains(e.target) && !card.pick.contains(e.target)) closeAgentMenu(card); };
  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeAgentMenu(card); card.pick.focus(); return; }
    const items = [...pop.querySelectorAll(".agent-item:not(:disabled)")];
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(cur + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(cur - 1 + items.length) % items.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
  };
  const onClose = () => closeAgentMenu(card);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onClose);
  window.addEventListener("scroll", onClose, true);
  card._agentMenuOff = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onClose);
    window.removeEventListener("scroll", onClose, true);
  };
}

export function closeAgentMenu(card) {
  card._agentMenuOff?.();
  card._agentMenuOff = null;
  card.agentPop?.remove();
  card.agentPop = null;
  card.pick?.classList.remove("open");
  card.pick?.setAttribute("aria-expanded", "false");
}

export function onAgentPick(card, value) {
  if (!value) return;
  if (value === "@worktree") return openWorktree(card);
  if (value === "@wt-merge") return mergeWorktree(card);
  if (value === "@wt-remove") return removeWorktree(card);
  const next = value === "@renew" ? card.adapter : card.app.adapters.find((a) => a.name === value);
  if (!next || card.rotating) return;
  if (next === card.adapter) {
    card.rotate(next, "사용자가 새 세션을 요청했습니다.");
  } else {
    card.nextAdapter = next;
    card.renew(false);
  }
}

/** A second copy of this project in a git worktree, as its own card with its own agent (B4). */
export async function openWorktree(card) {
  try {
    const path = await invoke("git_worktree_add", { root: card.root });
    card.app.addCard({
      path,
      agent: card.adapter?.name,
      model: card.cfg.model,
      effort: card.cfg.effort,
      worktree_setup: card.cfg.worktree_setup,
      post_turn_cmd: card.cfg.post_turn_cmd,
    });
    if (card.cfg.worktree_setup) {
      invoke("run_shell_cmd", { root: path, cmd: card.cfg.worktree_setup }).then((res) => {
        if (!res.ok) message(`worktree 초기화 명령 실패 (${res.code}):\n${res.output}`, { kind: "warning" });
      }).catch((e) => message(`worktree 초기화 실패: ${e}`, { kind: "warning" }));
    }
  } catch (e) {
    message(`worktree를 만들지 못했습니다: ${e}`, { kind: "error" });
  }
}

/** Merge this worktree's commits into the main folder's branch. Conflicts are refused, not left half-done. */
export async function mergeWorktree(card) {
  try {
    await invoke("git_worktree_merge", { root: card.root });
    message("원래 폴더에 합쳤습니다. 이 worktree는 이제 버려도 됩니다.", { kind: "info" });
  } catch (e) {
    const msg = String(e);
    if (/겹쳐서|conflict/i.test(msg)) {
      const delegate = await ask(`합치지 못했습니다:\n${msg}\n\n에이전트에게 원래 브랜치와의 충돌 해결을 요청할까요?`, { title: "병합 충돌", kind: "warning", okLabel: "에이전트에 요청", cancelLabel: "닫기" });
      if (delegate) card.composer.insert(`원래 폴더 브랜치와 worktree 병합 중 충돌이 발생했습니다. 변경 내용을 확인하고 충돌이 없도록 정리해줘:\n\`\`\`\n${msg.slice(0, 1200)}\n\`\`\`\n`);
    } else {
      message(`합치지 못했습니다: ${msg}`, { kind: "error" });
    }
  }
}

/** Close the card (its agent holds the folder open), then remove the worktree. */
export async function removeWorktree(card) {
  const ok = await ask(`${card.name}: 카드를 닫고 이 worktree 폴더를 지웁니다. 커밋하지 않은 변경이 있으면 지우지 않습니다.`, { title: "worktree 버리기", kind: "warning", okLabel: "버리기", cancelLabel: "취소" });
  if (!ok) return;
  await card.app.closeCard(card);
  if (card.app.cards.includes(card)) return;
  let err;
  for (let i = 0; i < 6; i++) {
    try {
      const branchGone = await invoke("git_worktree_remove", { root: card.root });
      if (!branchGone) message("폴더는 지웠습니다. 합치지 않은 저장점이 있어 브랜치는 남겨 두었습니다.", { kind: "info" });
      return;
    } catch (e) {
      err = e;
      await sleep(500);
    }
  }
  message(`${err}`, { kind: "error" });
}
