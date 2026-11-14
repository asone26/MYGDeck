// Lucide icons (https://github.com/lucide-icons/lucide, ISC) as inline SVG strings for innerHTML templates.
// Named imports keep the bundle to the icons used here.
import { ArrowRight, ArrowUp, Bell, BellOff, ChevronDown, CircleCheck, CircleX, FileText, FolderTree, GitBranch, GitMerge, Hand, Keyboard, KeyRound, LayoutList, Loader, LoaderCircle, Moon, PanelBottom, Pin, Play, Plus, Power, RotateCw, Square, SquareTerminal, Sun, X } from "lucide";

export const ICONS = { ArrowRight, ArrowUp, Bell, BellOff, ChevronDown, CircleCheck, CircleX, FileText, FolderTree, GitBranch, GitMerge, Hand, Keyboard, KeyRound, LayoutList, Loader, LoaderCircle, Moon, PanelBottom, Pin, Play, Plus, Power, RotateCw, Square, SquareTerminal, Sun, X };

// Card status → icon for the card header badge and overview tiles (idle shows nothing).
const STATUS = { starting: LoaderCircle, working: Loader, waiting: Hand, done: CircleCheck, failed: CircleX, exited: Power };

const esc = (v) => String(v).replace(/"/g, "&quot;");

/** Badge markup for a card status ("" when the status needs no badge). */
export function statusIcon(status) {
  return STATUS[status] ? icon(STATUS[status], `st-${status}`) : "";
}

/** `<svg>` markup for a Lucide icon node; sized by CSS (.ic, 1em by default). */
export function icon(node, cls = "") {
  const parts = node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(" ")}/>`);
  return `<svg class="ic ${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${parts.join("")}</svg>`;
}
