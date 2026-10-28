import { failure } from "./store.mjs";

// Key presses the caller named explicitly: one step is a key or chord (Ctrl/Alt/Shift + base key) or literal text.
// Named keys reach tmux by name, so it encodes them for the pane's current mode (application cursor keys, modifier
// parameters); characters and their Ctrl/Alt chords are the bytes a terminal sends. A chord a terminal cannot send
// distinctly (Ctrl+Enter, Shift+Escape, Ctrl+Shift+letter, ...) is refused rather than sent as a different key.
export const maxSteps = 50;
const modifiers = { ctrl: "Ctrl", control: "Ctrl", alt: "Alt", option: "Alt", meta: "Alt", shift: "Shift" };
const order = ["Ctrl", "Alt", "Shift"];
const names = {
  enter: "Enter", return: "Enter", escape: "Escape", esc: "Escape", tab: "Tab", space: "Space", backspace: "Backspace",
  delete: "Delete", del: "Delete", insert: "Insert", ins: "Insert", home: "Home", end: "End",
  pageup: "PageUp", pgup: "PageUp", pagedown: "PageDown", pgdn: "PageDown",
  up: "Up", down: "Down", left: "Left", right: "Right", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right",
};
for (let i = 1; i <= 12; i++) names[`f${i}`] = `F${i}`;
// Keys whose encoding tmux derives from the pane mode; every Ctrl/Alt/Shift combination of them is distinct.
const tmuxKeys = {
  Delete: "DC", Insert: "IC", Home: "Home", End: "End", PageUp: "PPage", PageDown: "NPage", Up: "Up", Down: "Down", Left: "Left", Right: "Right",
};
for (let i = 1; i <= 12; i++) tmuxKeys[`F${i}`] = `F${i}`;
// Ctrl with these symbols yields a C0 control byte, as in xterm.
const controlBytes = { "@": 0x00, "[": 0x1b, "\\": 0x1c, "]": 0x1d, "^": 0x1e, "_": 0x1f, "/": 0x1f, "?": 0x7f };
const control = /[\x00-\x1f\x7f-\x9f]/;
const invalid = (message) => failure(400, message);

// Returns { label, name } for a tmux key name or { label, bytes } for raw terminal input.
function chord(value) {
  if (typeof value !== "string" || !value) throw invalid("A key step needs a key name");
  let parts = [...value].length === 1 ? [value] : value.split("+").map((part) => part.trim());
  // "Ctrl++" names the plus key.
  if (parts.length > 2 && parts.at(-1) === "" && parts.at(-2) === "") parts = [...parts.slice(0, -2), "+"];
  const base = parts.pop();
  const held = new Set();
  for (const part of parts) {
    const modifier = modifiers[part.toLowerCase()];
    if (!modifier) throw invalid(`Unknown modifier "${part}" in ${value}; use Ctrl, Alt or Shift`);
    if (held.has(modifier)) throw invalid(`${modifier} appears twice in ${value}`);
    held.add(modifier);
  }
  const ctrl = held.has("Ctrl"), alt = held.has("Alt"), shift = held.has("Shift");
  const label = (key) => [...order.filter((modifier) => held.has(modifier)), key].join("+");
  const refuse = (key) => invalid(`${label(key)} has no distinct terminal encoding and cannot be sent`);
  if ([...base].length === 1 && base !== " ") {
    if (control.test(base)) throw invalid(`Name the key instead of sending control character U+${base.codePointAt(0).toString(16).padStart(4, "0")}`);
    const letter = /^[a-z]$/i.test(base);
    if (!held.size) return { label: base, bytes: Buffer.from(base) };
    // In a chord a letter names the key; Shift is explicit, as on the keyboard.
    const key = letter ? base.toUpperCase() : base;
    if (shift && !letter) throw invalid(`${label(key)} depends on the keyboard layout; name the shifted character itself`);
    if (shift && ctrl) throw refuse(key);
    let bytes;
    if (ctrl) {
      const byte = letter ? key.charCodeAt(0) & 0x1f : controlBytes[key];
      if (byte === undefined) throw refuse(key);
      bytes = Buffer.from([byte]);
    } else bytes = Buffer.from(shift ? key : letter ? key.toLowerCase() : key);
    // Shift alone just types the capital letter.
    if (!ctrl && !alt) return { label: key, bytes };
    return { label: label(key), bytes: alt ? Buffer.concat([Buffer.from([0x1b]), bytes]) : bytes };
  }
  const key = base === " " ? "Space" : names[base.toLowerCase().replace(/[\s_-]/g, "")];
  if (!key) throw invalid(`Unknown key "${base}" in ${value}`);
  const meta = alt ? "M-" : "";
  switch (key) {
    case "Enter": case "Escape": case "Backspace":
      if (ctrl || shift) throw refuse(key);
      return { label: label(key), name: `${meta}${key === "Backspace" ? "BSpace" : key}` };
    case "Tab":
      if (ctrl) throw refuse(key);
      return { label: label(key), name: `${meta}${shift ? "BTab" : "Tab"}` };
    case "Space":
      if (shift) throw refuse(key);
      return { label: label(key), bytes: Buffer.from([...(alt ? [0x1b] : []), ctrl ? 0x00 : 0x20]) };
    default:
      return { label: label(key), name: `${ctrl ? "C-" : ""}${meta}${shift ? "S-" : ""}${tmuxKeys[key]}` };
  }
}

// Validates caller steps and returns their canonical form, so identical sequences share one standing grant.
// A single character without modifiers becomes text: typing it is the same either way.
export function parseKeys(steps) {
  if (!Array.isArray(steps)) throw invalid("Key steps must be a list");
  if (steps.length > maxSteps) throw invalid(`At most ${maxSteps} key steps can be sent at once`);
  return steps.map((step) => {
    if (step?.type === "text") {
      if (typeof step.value !== "string" || !step.value) throw invalid("A text step needs text");
      if (step.value.length > 1000) throw invalid("A text step is limited to 1000 characters");
      if (control.test(step.value)) throw invalid("Text steps cannot contain control characters; name the keys instead (for example Enter or Tab)");
      return { type: "text", value: step.value };
    }
    if (step?.type !== "key") throw invalid("A step is either a key or text");
    const { label, bytes } = chord(step.value);
    return bytes && label === bytes.toString() ? { type: "text", value: label } : { type: "key", value: label };
  });
}
export const describeKeys = (steps) => steps.map((step) => step.type === "text" ? JSON.stringify(step.value) : step.value).join(" → ");
// One canonical step as tmux input: a key name for send-keys, or bytes for send-keys -H.
export function encodeStep(step) {
  if (step.type === "text") return { bytes: Buffer.from(step.value) };
  const { name, bytes } = chord(step.value);
  return name ? { name } : { bytes };
}
