import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { poolReady } from "./connections.js";
import { DEFAULT_SNIPPETS, ROUTE_CHIP, fuzzyFilter, keyLabel, mentionFor, mentionToken, nextRoute, routeInput } from "./logic.js";
import { ICONS, icon } from "./icons.js";

/** Input helper under the CLI (spec 3.2 ⑤). Everything typed here ends up in the CLI unchanged. */
export class Composer {
  constructor(card, el) {
    this.card = card;
    this.el = el;
    const a = card.adapter;
    // One box: pasted-image previews on top, then [model][effort] input [send].
    el.innerHTML = `<div class="cbox"><div class="thumbs"></div>
      <select class="model" title="모델 선택"></select><select class="effort" title="Effort 선택"></select>
      <textarea rows="1" spellcheck="false"></textarea>
      <button class="send" title="보내기 (Enter)" aria-label="보내기" disabled>${icon(ICONS.ArrowUp)}</button><ul class="slash" hidden></ul></div>
      <span class="route" hidden></span><button class="queue" hidden></button><button class="stop" title="${keyLabel("작업 중지 (Ctrl+Q)")}" hidden>${icon(ICONS.Square)}<span class="lbl">중지</span></button>`;
    this.queueBtn = el.querySelector(".queue");
    this.queueBtn.onclick = () => card.clearQueue();
    this.renderQueue(); // rebuilt on agent switch: keep showing what is queued
    this.stopBtn = el.querySelector(".stop");
    this.stopBtn.onclick = () => card.interrupt();
    this.sendBtn = el.querySelector(".send");
    this.sendBtn.onclick = () => this.send();
    this.ta = el.querySelector("textarea");
    this.ta.placeholder = `무엇을 할까요?`;
    this.ta.title = keyLabel("Enter 전송 · Shift+Enter 줄바꿈 · / 명령 목록 · 파일을 끌어다 놓으면 @파일 · 이미지 붙여넣기(Ctrl+V)");
    this.slash = el.querySelector(".slash");
    this.thumbs = el.querySelector(".thumbs");
    this.sel = 0;
    this.history = [];
    this.histIdx = -1;
    this.histDraft = "";
    this.menuItems = [];
    this.menuMode = "slash";
    this.mentionSpan = null;

    const select = el.querySelector(".model");
    if (a?.model_cmd && a.models.length) {
      select.append(new Option("모델", ""), ...a.models.map((m) => new Option(m, m)));
      select.value = a.base_model; // matches the launch flags
      select.onchange =() => select.value && (card.userModel = true) && card.sendToAgent(a.model_cmd.replace("{model}", select.value));
    } else {
      select.hidden = true;
    }
    const effort = el.querySelector(".effort");
    if (a?.effort_cmd && a.efforts?.length) {
      effort.append(new Option("Effort", ""), ...a.efforts.map((e) => new Option(e, e)));
      effort.value = /--effort (\S+)/.exec(a.launch)?.[1] ?? "";
      effort.onchange =() => effort.value && card.sendToAgent(a.effort_cmd.replace("{effort}", effort.value));
    } else {
      effort.hidden = true;
    }

    this.ta.addEventListener("keydown", (e) => this.onKey(e));
    this.ta.addEventListener("input", () => this.update());
    this.ta.addEventListener("paste", (e) => {
      const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
      if (!file) return; // plain text pastes as usual
      e.preventDefault();
      file.arrayBuffer()
        .then((buf) => invoke("save_paste", { bytes: Array.from(new Uint8Array(buf)), ext: file.type.split("/")[1].replace("jpeg", "jpg") }))
        .then((path) => {
          this.thumbs.append(this.thumb(URL.createObjectURL(file), path));
          this.insert(path);
        })
        .catch((err) => message(`이미지 붙여넣기 실패: ${err}`, { kind: "error" }));
    });
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      const text = e.dataTransfer.getData("text/plain");
      if (text) this.insert(text);
    });
  }

  onKey(e) {
    if (!this.slash.hidden) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        return this.move(e.key === "ArrowDown" ? 1 : -1);
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        return this.pick();
      }
      if (e.key === "Escape") {
        this.slash.hidden = true;
        return;
      }
    }
    if (e.key === "ArrowUp" && this.history.length && this.ta.selectionStart === this.ta.selectionEnd && !this.ta.value.slice(0, this.ta.selectionStart).includes("\n")) {
      e.preventDefault();
      if (this.histIdx === -1) this.histDraft = this.ta.value;
      this.histIdx = Math.min(this.histIdx + 1, this.history.length - 1);
      this.ta.value = this.history[this.history.length - 1 - this.histIdx];
      this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
      return this.update();
    }
    if (e.key === "ArrowDown" && this.histIdx >= 0 && this.ta.selectionStart === this.ta.selectionEnd && !this.ta.value.slice(this.ta.selectionEnd).includes("\n")) {
      e.preventDefault();
      this.histIdx--;
      this.ta.value = this.histIdx < 0 ? this.histDraft : this.history[this.history.length - 1 - this.histIdx];
      this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
      return this.update();
    }
    if (e.key === "ArrowRight" && !this.ta.value && !this.busy && this.ghost) {
      e.preventDefault();
      this.ta.value = this.ghost;
      this.ta.setSelectionRange(this.ghost.length, this.ghost.length);
      return this.update();
    }
    if (e.key === "Tab" && !e.shiftKey && !this.ta.value && this.last) {
      e.preventDefault();
      return this.resend();
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    }
  }

  async update() {
    this.ta.style.height = "auto";
    // border-box: scrollHeight leaves out the border, so add it back or the box shrinks on first input.
    const border = this.ta.offsetHeight - this.ta.clientHeight;
    this.ta.style.height = Math.min(this.ta.scrollHeight + border, 140) + "px";
    this.ta.style.overflowY = this.ta.scrollHeight > 140 ? "auto" : "hidden";
    const v = this.ta.value;
    this.sendBtn.disabled = !v.trim();
    // A preview lives as long as its path is still in the box (deleted or sent → gone).
    for (const t of [...this.thumbs.children]) {
      if (!v.includes(t.dataset.path)) {
        URL.revokeObjectURL(t.dataset.src);
        t.remove();
      }
    }
    const m = mentionToken(v, this.ta.selectionStart);
    if (m) {
      this.mentionSpan = m;
      const files = await this.card.fileList();
      if (this.ta.value !== v) return; // input changed while loading
      const hits = fuzzyFilter(files, m.query).slice(0, 12);
      return this.showSlash(
        hits.map((path) => ({ label: path, hint: "@파일", value: mentionFor(this.card.adapter?.mention, path) })),
        "mention",
      );
    }
    this.mentionSpan = null;
    if (/^\/\S*$/.test(v)) {
      const cmds = (this.card.adapter?.commands ?? []).map((c) => ({ label: c, hint: "명령", value: c + " " }));
      const seen = new Set(cmds.map((c) => c.label));
      const snips = DEFAULT_SNIPPETS.filter((s) => !seen.has(s.cmd)).map((s) => ({ label: s.cmd, hint: s.hint, value: s.prompt }));
      const all = [...cmds, ...snips].filter((x) => x.label.startsWith(v));
      this.showSlash(all, "slash");
    } else this.slash.hidden = true;
  }

  showSlash(items, mode = "slash") {
    this.menuMode = mode;
    this.menuItems = items;
    this.slash.textContent = "";
    items.forEach((item, i) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = item.label;
      li.append(name);
      if (item.hint) {
        const hint = document.createElement("small");
        hint.className = "slash-hint";
        hint.textContent = item.hint;
        li.append(hint);
      }
      if (i === 0) li.className = "on";
      li.onmousedown = (e) => {
        e.preventDefault();
        this.sel = i;
        this.pick();
      };
      this.slash.append(li);
    });
    this.sel = 0;
    this.slash.hidden = !items.length;
  }

  move(d) {
    const lis = [...this.slash.children];
    if (!lis.length) return;
    lis[this.sel]?.classList.remove("on");
    this.sel = (this.sel + d + lis.length) % lis.length;
    lis[this.sel].classList.add("on");
    lis[this.sel].scrollIntoView({ block: "nearest" });
  }

  pick() {
    const item = this.menuItems[this.sel];
    if (item) {
      if (this.menuMode === "mention" && this.mentionSpan) {
        const { start, end } = this.mentionSpan;
        const val = this.ta.value;
        this.ta.value = val.slice(0, start) + item.value + " " + val.slice(end).replace(/^\s*/, "");
        const pos = start + item.value.length + 1;
        this.ta.setSelectionRange(pos, pos);
      } else {
        this.ta.value = item.value;
      }
    }
    this.slash.hidden = true;
    this.update();
    this.ta.focus();
  }

  /** Preview of a pasted image: click to enlarge, × to drop it (and its path) from the input. */
  thumb(src, path) {
    const t = document.createElement("div");
    t.className = "thumb";
    Object.assign(t.dataset, { src, path });
    t.innerHTML = `<img alt="붙여넣은 이미지"><button class="tx" title="이미지 빼기" aria-label="이미지 빼기">${icon(ICONS.X)}</button>`;
    const img = t.querySelector("img");
    img.src = src;
    img.title = `${path}
클릭하면 크게 보기`;
    img.onclick = () => showImage(src);
    t.querySelector(".tx").onclick = () => {
      this.ta.value = this.ta.value.split(path).join("").replace(/ {2,}/g, " ");
      this.update();
      this.ta.focus();
    };
    return t;
  }

  insert(text) {
    const t = this.ta;
    const [a, b] = [t.selectionStart, t.selectionEnd];
    const pre = t.value.slice(0, a);
    const piece = (pre && !/\s$/.test(pre) ? " " : "") + text + " ";
    t.value = pre + piece + t.value.slice(b);
    t.selectionStart = t.selectionEnd = a + piece.length;
    t.focus();
    this.update();
  }

  /** Paths the deck can reach today: the agent, plus a model switch if the adapter has one (spec 4.3). */
  reachable() {
    const a = this.card.adapter;
    const list = ["code"];
    if (a?.model_cmd && a.deep_model && !this.card.userModel) list.push("deep");
    if (poolReady()) list.push("ask");
    return list;
  }

  send() {
    const text = this.ta.value.replace(/\s+$/, "");
    if (!text.trim()) return;
    // The Enter after the text would pick the highlighted menu option (e.g. "No, exit" on the trust prompt).
    if (this.card.menuOpen && this.card.menuChoices.length) {
      message("CLI 선택 창이 열려 있습니다. 위의 버튼으로 먼저 고르세요.", { kind: "warning" });
      return;
    }
    const r = routeInput(text);
    // Search and ?? go to the free pool when one is set up (4.5); without it they go to the agent.
    const pooled = ["ask", "search"].includes(r.route);
    const route = r.route === "cli" ? "cli" : pooled && poolReady() ? "ask" : this.reachable().includes(r.route) ? r.route : "code";
    // raw + imgs: what the box held, so a stop can put it back (restore()).
    const item = { text: r.route === "ask" ? text : r.text, route, shown: r.route, raw: text, imgs: [...this.thumbs.children] };
    this.thumbs.textContent = ""; // detach without revoking: the previews come back on restore
    const busy = this.card.status === "working" || this.card.status === "waiting";
    // Mid-turn input would land in the running turn (or pick a menu option): hold it for the next turn.
    // Pool questions never touch the agent, so they go now.
    if (busy && route !== "ask" && this.card.canQueue) {
      this.card.queue.push(item);
      this.renderQueue();
    } else {
      this.setLast(item);
      this.dispatch(route, item.text);
    }
    if (this.history.at(-1) !== text) {
      this.history.push(text);
      if (this.history.length > 30) this.history.shift();
    }
    this.histIdx = -1;
    this.ta.value = "";
    this.update();
  }

  dispatchQueued(item) {
    this.setLast(item);
    this.dispatch(item.route, item.text);
  }

  setLast(item) {
    // The previous prompt's previews can no longer be restored: free them.
    for (const t of this.last?.imgs ?? []) if (!t.isConnected) URL.revokeObjectURL(t.dataset.src);
    this.last = item;
  }

  /** After a stop: put the interrupted prompt (and its image previews) back in the box, unless the box is in use. */
  restore() {
    const l = this.last;
    if (!l || l.route === "ask" || this.ta.value.trim()) return;
    this.ta.value = l.raw ?? l.text;
    this.thumbs.append(...(l.imgs ?? []));
    this.update();
    this.ta.focus();
    this.ta.selectionStart = this.ta.selectionEnd = this.ta.value.length;
  }

  renderQueue() {
    const q = this.card.queue;
    this.queueBtn.hidden = !q.length;
    this.queueBtn.textContent = `다음 ${q.length}`;
    this.queueBtn.title = `작업이 끝나면 차례로 보냅니다:\n${q.map((x, i) => `${i + 1}. ${x.text.slice(0, 80)}`).join("\n")}\n\n클릭: 모두 취소`;
  }

  dispatch(route, text) {
    const card = this.card;
    const chip = this.el.querySelector(".route");
    chip.textContent = ROUTE_CHIP[this.last.shown] + (this.last.shown !== route && route !== "cli" ? ` → ${ROUTE_CHIP[route]}` : "");
    chip.hidden = route === "cli";
    chip.title = "Tab: 다른 경로로 다시 보내기";
    if (route === "ask") {
      chip.textContent = "ask · free pool…";
      invoke("ai_ask", { prompt: text, search: this.last.shown === "search" })
        .then((a) => {
          chip.textContent = `ask · ${a.via}`;
          card.showAnswer(text, a.text, a.via, a);
        })
        .catch((err) => {
          chip.textContent = "ask · 실패";
          card.showAnswer(text, `**답변 실패:** ${err}`, "");
        });
    } else if (route === "deep") {
      const a = card.adapter;
      card.sendToAgent(a.model_cmd.replace("{model}", a.deep_model));
      card.revertModel = true;
      setTimeout(() => card.sendToAgent(text), 600);
    } else card.sendToAgent(text);
  }

  /** Tab on an empty box: the last input again, down the other path (stops the first attempt). */
  resend() {
    const l = this.last;
    const next = nextRoute(l.route, this.reachable());
    if (next === l.route) return;
    this.card.interrupt(false);
    this.last = { ...l, route: next, shown: next };
    setTimeout(() => this.dispatch(next, l.text), 300);
  }

  focus() {
    this.ta.focus();
  }

  setBusy(busy) {
    this.stopBtn.hidden = !busy;
    this.busy = busy;
    this.placeholder();
  }

  /** The CLI's suggested next prompt, shown like the CLI does: grey text in the empty box, → takes it. */
  setGhost(text) {
    if ((text || null) === (this.ghost ?? null)) return;
    this.ghost = text || null;
    this.placeholder();
  }

  placeholder() {
    const ghost = !this.busy && this.ghost;
    this.ta.placeholder = ghost || (this.busy && this.card.canQueue ? "작업이 끝나면 보낼 다음 지시" : "무엇을 할까요?");
    this.ta.classList.toggle("ghost", !!ghost);
    this.ta.title = keyLabel(`${ghost ? "→ 추천 문구 입력 · " : ""}Enter 전송 · Shift+Enter 줄바꿈 · / 명령 목록 · 파일을 끌어다 놓으면 @파일 · 이미지 붙여넣기(Ctrl+V)`);
  }
}

/** Full-size view of a pasted image; click or Esc closes it. */
function showImage(src) {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img alt="붙여넣은 이미지 크게 보기">`;
  box.querySelector("img").src = src;
  const close = () => {
    box.remove();
    removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  box.onclick = close;
  addEventListener("keydown", onKey, true);
  document.body.append(box);
}
