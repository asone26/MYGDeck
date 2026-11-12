// Gather the phone page into cloud/public for Cloudflare Pages (the same files the daemon serves).
// Run from the repo root: `node cloud/build.mjs`, then deploy with wrangler (docs/mobile.md).
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "cloud", "public");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = {
  "index.html": "src/mobile/index.html",
  "app.js": "src/mobile/app.js",
  "app.css": "src/mobile/app.css",
  "manifest.webmanifest": "src/mobile/manifest.webmanifest",
  "logic.js": "src/logic.js",
  "xterm.js": "node_modules/@xterm/xterm/lib/xterm.js",
  "icon.png": "src-tauri/icons/128x128@2x.png",
};
for (const [to, from] of Object.entries(files)) cpSync(join(root, from), join(out, to));
console.log(`cloud/public: ${Object.keys(files).length} files`);
