/** Input helper under the CLI (spec 3.2 ⑤). Everything typed here ends up in the CLI unchanged. */
export class Composer {
  constructor(card, el) {
    this.card = card;
    const a = card.adapter;
    el.innerHTML = `<span class="ptag"></span><select class="model" title="모델 선택"></select>
      <div class="cbox"><textarea rows="1" spellcheck="false"></textarea><ul class="slash" hidden></ul></div>
      <button class="stop" title="작업 중지 (Alt+X)" hidden>■ 중지</button>
      <button class="send" title="전송 (Enter)">↵</button>`;
    this.stopBtn = el.querySelector(".stop");
    this.stopBtn.onclick = () => card.interrupt();
    el.querySelector(".ptag").textContent = card.name;
    this.ta = el.querySelector("textarea");
    this.ta.placeholder = `${card.name}에게 지시 · / 명령`;
    this.ta.title = "Enter 전송 · Shift+Enter 줄바꿈 · / 명령 목록 · 파일을 끌어다 놓으면 @파일";
    this.slash = el.querySelector(".slash");
    this.sel = 0;

    const select = el.querySelector(".model");
    if (a?.model_cmd && a.models.length) {
      select.append(new Option("모델", ""), ...a.models.map((m) => new Option(m, m)));
      select.onchange = () => select.value && card.sendToAgent(a.model_cmd.replace("{model}", select.value));
    } else {
      select.hidden = true;
    }

    this.ta.addEventListener("keydown", (e) => this.onKey(e));
    this.ta.addEventListener("input", () => this.update());
    el.querySelector(".send").onclick = () => this.send();
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

  send() {
    const text = this.ta.value.replace(/\s+$/, "");
    if (!text.trim()) return;
    this.card.sendToAgent(text);
    this.ta.value = "";
    this.update();
  }

  focus() {
    this.ta.focus();
  }

  setBusy(busy) {
    this.stopBtn.hidden = !busy;
  }
}
