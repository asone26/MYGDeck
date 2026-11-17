const LANG_KEY = "mygdeck.lang";

export function getLang() {
  try {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(LANG_KEY) : null;
    if (saved === "ko" || saved === "en") return saved;
  } catch {}
  if (typeof window === "undefined") return "ko";
  return navigator.language?.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export const isEn = () => getLang() === "en";
export const L = (ko, en) => (isEn() ? en : ko);

export function setLang(lang) {
  const next = lang === "en" ? "en" : "ko";
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {}
  if (typeof document !== "undefined") document.documentElement.lang = next;
  return next;
}

export function applyStaticI18n() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = getLang();
  if (!isEn()) return;
  const setAttr = (id, attr, val) => {
    const el = document.getElementById(id);
    if (el) el.setAttribute(attr, val);
  };
  setAttr("add-btn", "title", "Add project (Ctrl+')");
  setAttr("add-btn", "aria-label", "Add project");
  setAttr("keys-btn", "title", "Keyboard shortcuts");
  setAttr("keys-btn", "aria-label", "Keyboard shortcuts");
  setAttr("theme-btn", "aria-label", "Switch theme");
  setAttr("conn-btn", "title", "AI Connections · API Keys");
  setAttr("conn-btn", "aria-label", "AI Connections");

  const empty = document.getElementById("empty");
  if (!empty) return;
  const h1 = empty.querySelector("h1");
  const ps = empty.querySelectorAll("p");
  const addFirst = document.getElementById("add-first");
  if (h1) h1.textContent = "Multiple projects in one window";
  if (ps[0]) ps[0].textContent = "Each project runs its own agent CLI; cards light up when they need you.";
  if (addFirst) addFirst.innerHTML = `Add project folder <kbd>Ctrl+'</kbd>`;
  if (ps[1]) ps[1].textContent = "Added projects are saved in mygdeck.json and reopened on next launch.";
}
