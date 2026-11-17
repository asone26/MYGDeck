import { invoke } from "@tauri-apps/api/core";
import { L } from "./i18n.js";

let pool = false;
/** True when at least one free connection has a model: the question paths can answer. */
export const poolReady = () => pool;
export async function refreshPool() {
  pool = await invoke("ai_ready").catch(() => false);
}

/** Presets fill the form; the key is the only thing the user has to type (spec 4.5). */
const PRESETS = [
  { name: "OpenAI", kind: "openai", base_url: "https://api.openai.com/v1" },
  { name: "Anthropic", kind: "anthropic", base_url: "https://api.anthropic.com/v1" },
  { name: "Gemini", kind: "openai", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", free: true },
  { name: "OpenRouter", kind: "openai", base_url: "https://openrouter.ai/api/v1" },
  { name: L("Tavily (검색)", "Tavily (Search)"), kind: "search", base_url: "https://api.tavily.com", free: true },
  { name: "Groq", kind: "openai", base_url: "https://api.groq.com/openai/v1", free: true },
];

/** One place to add, test and remove AI connections. Keys go straight to the OS keychain and are never shown again. */
export async function openConnections(overlay) {
  overlay.innerHTML = `<div class="qo conn-box">
    <div class="qo-title">${L("AI 연결 · API 키는 OS 키체인에만 저장됩니다", "AI Connections · API keys are stored in the OS keychain")}</div>
    <ul class="cn-list"></ul>
    <form class="cn-form">
      <select name="preset"><option value="">${L("직접 입력", "Custom")}</option>${PRESETS.map((p, i) => `<option value="${i}">${p.name}</option>`).join("")}</select>
      <input name="name" placeholder="${L("이름", "Name")}" spellcheck="false" required>
      <select name="kind"><option value="openai">${L("OpenAI 호환", "OpenAI-compatible")}</option><option value="anthropic">Anthropic</option><option value="search">${L("웹 검색 (Tavily)", "Web Search (Tavily)")}</option></select>
      <input name="base_url" placeholder="${L("주소 (https://…/v1)", "Base URL (https://…/v1)")}" spellcheck="false" required>
      <input name="model" placeholder="${L("모델 (선택)", "Model (optional)")}" spellcheck="false">
      <input name="key" type="password" placeholder="${L("API 키 (로컬은 비워둠)", "API key (empty for local)")}" autocomplete="off">
      <label><input name="free" type="checkbox"> ${L("무료/로컬", "Free/Local")}</label>
      <button>${L("저장", "Save")}</button><span class="cn-msg"></span>
    </form></div>`;
  const $ = (s) => overlay.querySelector(s);
  const form = $(".cn-form");
  const msg = (t) => ($(".cn-msg").textContent = t);

  async function draw() {
    const list = await invoke("ai_list");
    await refreshPool();
    const ul = $(".cn-list");
    ul.textContent = "";
    if (!list.length) ul.innerHTML = `<li class="muted">${pool ? L("연결이 없어 질문은 Claude 구독(haiku)으로 답합니다. 무료 API를 추가하면 그쪽을 먼저 씁니다.", "No API configured; questions fall back to Claude CLI (haiku). Free APIs are tried first when added.") : L("아직 연결이 없습니다. 아래에서 추가하세요.", "No connections yet. Add one below.")}</li>`;
    for (const c of list) {
      const li = document.createElement("li");
      li.innerHTML = `<b></b> <span class="muted"></span><span class="sp"></span><button class="t">${L("테스트", "Test")}</button><button class="e">${L("수정", "Edit")}</button><button class="d">${L("삭제", "Delete")}</button><span class="res"></span>`;
      li.querySelector("b").textContent = c.name;
      li.querySelector(".muted").textContent = `${c.kind} · ${c.base_url}${c.model ? " · " + c.model : ""}${c.free ? L(" · 무료", " · free") : ""} · ${c.has_key ? L("키 저장됨", "key saved") : L("키 없음", "no key")}`;
      const res = li.querySelector(".res");
      li.querySelector(".t").onclick = async () => {
        res.textContent = L("확인 중…", "Testing…");
        res.textContent = await invoke("ai_test", { id: c.id }).catch((e) => `✗ ${e}`);
      };
      li.querySelector(".e").onclick = () => {
        for (const k of ["name", "kind", "base_url", "model"]) form.elements[k].value = c[k];
        form.elements.free.checked = c.free;
        form.elements.key.placeholder = c.has_key ? L("비워두면 기존 키 유지", "Leave empty to keep existing key") : "API key";
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
      form.elements.key.placeholder = L("API 키 (로컬은 비워둠)", "API key (empty for local)");
      msg(L("저장됨", "Saved"));
      draw();
    } catch (err) {
      msg(String(err));
    }
  };
  draw();
}
