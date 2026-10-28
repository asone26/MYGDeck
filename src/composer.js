import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { poolReady } from "./connections.js";
import { ROUTE_CHIP, nextRoute, routeInput } from "./logic.js";

/** Input helper under the CLI (spec 3.2 ⑤). Everything typed here ends up in the CLI unchanged. */
export class Composer {
  constructor(card, el) {
    this.card = card;
    this.el = el;
    const a = card.adapter;
    el.innerHTML = `<select class="model" title="모델 선택"></select><select class="effort" title="Effort 선택"></select>
      <span class="route" hidden></span><div class="cbox"><textarea rows="1" spellcheck="false"></textarea><ul class="slash" hidden></ul></div>
      <button class="stop" title="작업 중지 (Ctrl+Q)" hidden>■ 중지</button>`;
    this.stopBtn = el.querySelector(".stop");
    this.stopBtn.onclick = () => card.interrupt();
    this.ta = el.querySelector("textarea");
    this.ta.placeholder = `무엇을 할까요?`;
    this.ta.title = "Enter 전송 · Shift+Enter 줄바꿈 · / 명령 목록 · 파일을 끌어다 놓으면 @파일 · 이미지 붙여넣기(Ctrl+V)";
    this.slash = el.querySelector(".slash");
    this.sel = 0;

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
        .then((path) => this.insert(path))
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
    if (e.key === "Tab" && !e.shiftKey && !this.ta.value && this.last) {
      e.preventDefault();
      return this.resend();
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    }
  }

  update() {
    this.ta.style.height = "auto";
    this.ta.style.height = Math.min(this.ta.scrollHeight, 140) + "px";
    this.ta.style.overflowY = this.ta.scrollHeight > 140 ? "auto" : "hidden";
    const v = this.ta.value;
    const cmds = this.card.adapter?.commands ?? [];
    if (/^\/\S*$/.test(v) && cmds.length) this.showSlash(cmds.filter((c) => c.startsWith(v)));
    else this.slash.hidden = true;
  }

  showSlash(items) {
    this.slash.textContent = "";
    items.forEach((c, i) => {
      const li = document.createElement("li");
      li.textContent = c;
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
    const li = this.slash.children[this.sel];
    if (li) this.ta.value = li.textContent + " ";
    this.slash.hidden = true;
    this.update();
    this.ta.focus();
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
    const r = routeInput(text);
    // Search and ?? go to the free pool when one is set up (4.5); without it they go to the agent.
    const pooled = ["ask", "search"].includes(r.route);
    const route = r.route === "cli" ? "cli" : pooled && poolReady() ? "ask" : this.reachable().includes(r.route) ? r.route : "code";
    this.last = { text: r.route === "ask" ? text : r.text, route, shown: r.route };
    this.dispatch(route, this.last.text);
    this.ta.value = "";
    this.update();
  }

  dispatch(route, text) {
    const card = this.card;
    const chip = this.el.querySelector(".route");
    chip.textContent = ROUTE_CHIP[this.last.shown] + (this.last.shown !== route && route !== "cli" ? ` → ${ROUTE_CHIP[route]}` : "");
    chip.hidden = route === "cli";
    chip.title = "Tab: 다른 경로로 다시 보내기";
    if (route === "ask") {
      chip.textContent = "💬 free pool…";
      invoke("ai_ask", { prompt: text, search: this.last.shown === "search" })
        .then((a) => {
          chip.textContent = `💬 ${a.via}`;
          card.showAnswer(text, a.text, a.via, a);
        })
        .catch((err) => {
          chip.textContent = "💬 실패";
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
    this.card.interrupt();
    this.last = { ...l, route: next, shown: next };
    setTimeout(() => this.dispatch(next, l.text), 300);
  }

  focus() {
    this.ta.focus();
  }

  setBusy(busy) {
    this.stopBtn.hidden = !busy;
  }
}
