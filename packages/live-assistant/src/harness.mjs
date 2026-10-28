import { accessSync, statSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { foundryCredential, audience } from "./foundry.mjs";

// Harnesses are the CLIs already installed and configured in the user's shell. The assistant never writes
// their configuration, model routes or credentials; it starts them with its own environment in a chosen directory.
// `rc` harnesses are launched through an interactive bash, so ~/.bashrc edits apply to every new session.
const hookScript = fileURLToPath(new URL("./hook.mjs", import.meta.url));
const q = (text) => `'${text.replaceAll("'", "'\\''")}'`;
// A stable command line keeps Codex hook trust valid across sessions; the session is identified through env.
export const hookCommand = `${q(process.execPath)} ${q(hookScript)}`;

export function claudeSettings() {
  return { hooks: { PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand, timeout: 86400 }] }] } };
}

export function codexHookArgs() {
  return ["-c", `hooks.PermissionRequest=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(hookCommand)},timeout=86400}]}]`];
}

// `dshToken` adds a short-lived Entra token as FOUNDRY_TOKEN for DSH profiles that read it; the token only lives in
// the process environment of that session (never argv or disk).
export function defaultAdapters({
  hooks = process.env.LIVE_ASSISTANT_HOOKS !== "0", dshProfile = "dsh-tui", dshToken = false, subscription, credential,
} = {}) {
  const dsh = { argv: ["dsh", "--profile", dshProfile], rc: true };
  if (dshToken) {
    credential ??= foundryCredential(subscription);
    dsh.env = async () => ({ FOUNDRY_TOKEN: (await credential.getToken(audience)).token });
  }
  return {
    // An interactive non-login bash reads ~/.bashrc itself, like a desktop terminal on Ubuntu.
    shell: { argv: ["/bin/bash", "-i"] },
    claude: { argv: ["claude", ...(hooks ? ["--settings", JSON.stringify(claudeSettings())] : [])], hooks, rc: true },
    codex: { argv: ["codex", ...(hooks ? codexHookArgs() : [])], hooks, rc: true },
    copilot: { argv: ["copilot"], rc: true },
    dsh,
  };
}

// The environment harnesses inherit: the assistant's own, minus its login password and what `npm run` injected.
export function harnessEnvironment(env = process.env) {
  const npm = Boolean(env.npm_lifecycle_event);
  const result = Object.fromEntries(Object.entries(env).filter(([name]) => name !== "LIVE_ASSISTANT_PASSWORD"
    && (!npm || !(/^npm_/i.test(name) || ["INIT_CWD", "NODE", "COLOR"].includes(name)))));
  if (npm && env.PATH) {
    // npm prepends node_modules/.bin directories (and node-gyp-bin) for the script; drop that prefix only.
    const entries = env.PATH.split(delimiter);
    let start = 0;
    while (start < entries.length && (/[\\/]node_modules[\\/]\.bin$/.test(entries[start]) || /node-gyp-bin$/.test(entries[start]))) start++;
    result.PATH = entries.slice(start).join(delimiter);
  }
  return result;
}

export function findExecutable(command, path = process.env.PATH ?? "") {
  const usable = (file) => {
    try { accessSync(file, constants.X_OK); return statSync(file).isFile(); }
    catch { return false; }
  };
  if (isAbsolute(command) || command.includes(sep)) return usable(command) ? command : null;
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const file = join(directory, command);
    if (usable(file)) return file;
  }
  return null;
}
