import { createHash } from "node:crypto";

export const digest = (text) => createHash("sha256").update(text).digest("hex");

export function redact(text) {
  return String(text)
    // A key still being printed (or whose end is past the observed window) has no END marker yet.
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED KEY]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED TOKEN]")
    .replace(/((?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1[REDACTED]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[REDACTED ID]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]");
}

// Spinner frames, elapsed timers and box drawing change on every TUI repaint without carrying meaning.
const spinner = /[⠁-⣿✻✽✶✳✢·•◐◓◑◒⏺⎿]/g;
const timers = /\(\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+(?:\.\d+)?s\b[^)]*\)|\b\d+(?:\.\d+)?s\s*·|esc to interrupt|ctrl\+c to interrupt/gi;
const frame = /^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬▔▁▏▕-]*$/;

export function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function condenseLine(line) {
  return line.replace(spinner, " ").replace(timers, " ").replace(/[│┃║]/g, " ").replace(/\s+/g, " ").trim();
}

export function condense(text) {
  const result = [];
  for (const raw of String(text).split("\n")) {
    const line = condenseLine(raw);
    if (!line || frame.test(line)) continue;
    if (result.at(-1) === line) continue;
    result.push(line);
  }
  return result;
}

// Returns only lines the reader has not already received, keeping the remembered window bounded.
export class DeltaMemory {
  seen = new Map();
  delta(key, lines, window = 400) {
    const known = this.seen.get(key) ?? new Set();
    const fresh = lines.filter((line) => !known.has(line));
    for (const line of fresh) known.add(line);
    while (known.size > window) known.delete(known.values().next().value);
    this.seen.set(key, known);
    return fresh;
  }
  forget(key) { this.seen.delete(key); }
}

export function tail(text, limit) {
  return text.length <= limit ? text : `…${text.slice(-(limit - 1))}`;
}

const yesNo = /(?:\[[yY]\/[nN]\]|\[[nN]\/[yY]\]|\([yY]\/[nN]\)|\([nN]\/[yY]\))\s*[:?]?\s*$/;
// Native Codex and Claude Code approval menus; the highlighted first option is the approval.
const menus = [
  /(?:Would you like to run the following command|Would you like to make the following edits|Allow command\?|Do you want to (?:proceed|make this edit|create|run)|Do you trust)/i,
];
const menuOption = /^(?:[›❯>]\s*)?1\.\s+Yes\b/;

function anchorOf(lines) {
  const question = lines.join("\n");
  return { question, anchor: digest(question), line: lines.at(-1) };
}

// Detects a native confirmation on the visible screen. The anchor covers only the question region,
// so spinners and timers elsewhere do not invalidate a pending human decision.
export function detectPrompt(text) {
  const lines = condense(text);
  const last = lines.slice(-4);
  const index = last.findLastIndex((line) => yesNo.test(line));
  if (index !== -1 && index === last.length - 1) {
    return { kind: "yes-no", data: "y\r", ...anchorOf(last.slice(Math.max(0, index - 1), index + 1)) };
  }
  const start = lines.findLastIndex((line) => menus.some((pattern) => pattern.test(line)));
  if (start === -1 || lines.length - start > 30) return null;
  const region = lines.slice(start);
  const option = region.findIndex((line) => menuOption.test(line));
  // The selected option must still be the approval; a moved selection changes the anchor and needs a new decision.
  if (option === -1 || !/^[›❯>]/.test(region[option])) return null;
  const end = region.findLastIndex((line) => /^(?:[›❯>]\s*)?\d+\.\s/.test(line));
  return { kind: "menu", data: "\r", ...anchorOf(region.slice(0, end + 1)) };
}
