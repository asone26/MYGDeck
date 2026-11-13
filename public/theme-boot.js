// Runs before the page paints (classic script in <head>), so a light-theme user never sees a dark flash.
// main.js applies the same choice again and owns the theme switch.
try {
  const pref = localStorage.getItem("mygdeck.theme");
  const light = pref === "light" || (pref === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
} catch {}
