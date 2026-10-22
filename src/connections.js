import { invoke } from "@tauri-apps/api/core";

let pool = false;
/** True when at least one free connection has a model: the question paths can answer. */
export const poolReady = () => pool;
export async function refreshPool() {
  await invoke("ai_detect").catch(() => {});
  pool = (await invoke("ai_list").catch(() => [])).some((c) => c.free && c.model);
}

/** Presets fill the form; the key is the only thing the user has to type (spec 4.5). */
const PRESETS = [
  { name: "Ollama (로컬)", kind: "openai", base_url: "http://localhost:11434/v1", free: true },
  { name: "OpenAI", kind: "openai", base_url: "https://api.openai.com/v1" },
  { name: "Anthropic", kind: "anthropic", base_url: "https://api.anthropic.com/v1" },
  { name: "Gemini", kind: "openai", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", free: true },
  { name: "OpenRouter", kind: "openai", base_url: "https://openrouter.ai/api/v1" },
  { name: "Groq", kind: "openai", base_url: "https://api.groq.com/openai/v1", free: true },
];

/** One place to add, test and remove AI connections. Keys go straight to the OS keychain and are never shown again. */
export async function openConnections(overlay) {
  overlay.innerHTML = `<div class="qo conn-box">
    <div class="qo-title">AI 연결 · API 키는 OS 키체인에만 저장됩니다</div>
    <ul class="cn-list"></ul>
    <form class="cn-form">
      <select name="preset"><option value="">직접 입력</option>${PRESETS.map((p, i) => `<option value="${i}">${p.name}</option>`).join("")}</select>
      <input name="name" placeholder="이름" spellcheck="false" required>
      <select name="kind"><option value="openai">OpenAI 호환</option><option value="anthropic">Anthropic</option></select>
      <input name="base_url" placeholder="주소 (https://…/v1)" spellcheck="false" required>
      <input name="model" placeholder="모델 (선택)" spellcheck="false">
      <input name="key" type="password" placeholder="API 키 (로컬은 비워둠)" autocomplete="off">
      <label><input name="free" type="checkbox"> 무료/로컬</label>
      <button>저장</button><span class="cn-msg"></span>
    </form></div>`;
  const $ = (s) => overlay.querySelector(s);
  const form = $(".cn-form");
  const msg = (t) => ($(".cn-msg").textContent = t);

  async function draw() {
    const list = await invoke("ai_list");
    pool = list.some((c) => c.free && c.model);
    const ul = $(".cn-list");
    ul.textContent = "";
    if (!list.length) ul.innerHTML = `<li class="muted">아직 연결이 없습니다. 아래에서 추가하세요.</li>`;
    for (const c of list) {
      const li = document.createElement("li");
      li.innerHTML = `<b></b> <span class="muted"></span><span class="sp"></span><button class="t">테스트</button><button class="e">수정</button><button class="d">삭제</button><span class="res"></span>`;
      li.querySelector("b").textContent = c.name;
      li.querySelector(".muted").textContent = `${c.kind} · ${c.base_url}${c.model ? " · " + c.model : ""}${c.free ? " · 무료" : ""} · ${c.has_key ? "키 저장됨" : "키 없음"}`;
      const res = li.querySelector(".res");
      li.querySelector(".t").onclick = async () => {
        res.textContent = "확인 중…";
        res.textContent = await invoke("ai_test", { id: c.id }).catch((e) => `✗ ${e}`);
      };
      li.querySelector(".e").onclick = () => {
        for (const k of ["name", "kind", "base_url", "model"]) form.elements[k].value = c[k];
        form.elements.free.checked = c.free;
        form.elements.key.placeholder = c.has_key ? "비워두면 기존 키 유지" : "API 키";
        form.dataset.id = c.id;
        form.elements.name.focus();
      };
      li.querySelector(".d").onclick = async () => {
        await invoke("ai_delete", { id: c.id });
        draw();
      };
      ul.append(li);
    }
  }

  form.elements.preset.onchange = (e) => {
    const p = PRESETS[e.target.value];
    if (!p) return;
    form.elements.name.value = p.name.replace(/ \(.*\)/, "");
    form.elements.kind.value = p.kind;
    form.elements.base_url.value = p.base_url;
    form.elements.free.checked = !!p.free;
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const conn = { id: form.dataset.id || f.name.value.trim().toLowerCase().replace(/\s+/g, "-"), name: f.name.value.trim(), kind: f.kind.value, base_url: f.base_url.value.trim(), model: f.model.value.trim(), free: f.free.checked };
    try {
      await invoke("ai_save", { conn, key: f.key.value || null });
      form.reset();
      form.dataset.id = "";
      form.elements.key.placeholder = "API 키 (로컬은 비워둠)";
      msg("저장됨");
      draw();
    } catch (err) {
      msg(String(err));
    }
  };
  draw();
}
