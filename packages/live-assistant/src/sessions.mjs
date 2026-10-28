import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join, resolve, sep, basename, dirname } from "node:path";
import { writeFileSync, realpathSync, readFileSync, rmSync, chmodSync, mkdirSync, statSync, lstatSync } from "node:fs";
import { open, link, rm, realpath, stat } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { z } from "zod";
import { JsonStore, Serial, EventLog, failure } from "./store.mjs";
import { digest, redact, detectPrompt } from "./text.mjs";
import { findExecutable, harnessEnvironment } from "./harness.mjs";
import { parseKeys, describeKeys, encodeStep } from "./keys.mjs";

const execute = promisify(execFile);
const size = z.number().int().min(2).max(500);
// Byte-level safety for one delivery; the browser splits larger pastes.
const input = z.string().min(1).max(1_000_000);
const operationId = z.string().uuid();
// Preset tab colors (the page maps each to a palette value); a tab without one stays neutral.
export const tabColors = ["blue", "teal", "green", "yellow", "orange", "red", "purple", "gray"];
const tabLabel = z.strictObject({ color: z.enum(tabColors).nullable().optional(), note: z.string().trim().max(40).optional() });
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const decode = (text) => Buffer.from(text.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))), "latin1");
// An idle server (exit-empty off) answers lookups with "no current target".
const missing = /no server running|no sessions|no current target|error connecting|can't find (session|pane|window)|no such file/i;
const finished = new Set(["delivered", "rejected", "superseded", "uncertain", "terminal"]);
const sessionBound = new Set(["input", "keys", "prompt", "permission", "cancel", "close", "verify"]);
// Proposals that write to the terminal: a human taking over the keyboard makes them stale.
const terminalInput = ["input", "keys", "prompt"];
// Terminal-generated traffic: mouse motion/wheel (SGR and legacy encodings), focus changes and query replies.
// It is forwarded to the PTY but is not a human decision, so it never claims the keyboard or supersedes proposals.
const report = /\x1b\[<(\d+);\d+;\d+[Mm]|\x1b\[M([\s\S])[\s\S]{2}|\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[[?>=]?[\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/gy;
// `clicks` also counts button reports, which only matters where no process can act on them.
export function passiveInput(data, { clicks = false } = {}) {
  report.lastIndex = 0;
  let match, end = 0;
  while ((match = report.exec(data))) {
    const code = match[1] !== undefined ? Number(match[1]) : match[2] !== undefined ? match[2].charCodeAt(0) - 32 : null;
    // Button presses and releases are deliberate clicks; only motion (bit 32) and wheel (64-67) are passive.
    if (!clicks && code !== null && !(code & 32) && !(code & 64)) return false;
    end = report.lastIndex;
  }
  return end > 0 && end === data.length;
}

// Soft-wrapped rows are rejoined into the logical line the program printed, so a long line (and any secret in it)
// is condensed and redacted as one. A range starting inside a wrapped line starts at that line's first row.
function logicalLines(buffer, start, end) {
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  const lines = [];
  for (let i = start; i < end; i++) {
    const line = buffer.getLine(i);
    const continued = i + 1 < end && buffer.getLine(i + 1)?.isWrapped;
    const text = line?.translateToString(!continued) ?? "";
    if (line?.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}
function processTree(pid) {
  const result = [];
  const visit = (id) => {
    try {
      const stat = readFileSync(`/proc/${id}/stat`, "utf8").split(") ").at(-1).split(" ");
      if (stat[0] !== "Z") result.push({ id, startedAt: stat[19] });
      const children = readFileSync(`/proc/${id}/task/${id}/children`, "utf8").trim();
      for (const child of children ? children.split(" ").map(Number) : []) visit(child);
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
  };
  visit(pid);
  return result;
}
function stillRunning(process) {
  try {
    const stat = readFileSync(`/proc/${process.id}/stat`, "utf8").split(") ").at(-1).split(" ");
    return stat[0] !== "Z" && stat[19] === process.startedAt;
  } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; return false; }
}

// Native terminal sessions plus the proposal store. `revision` is the authorization epoch: it changes when
// the human acts on a session (typing, revoke, wait, termination), never because the program printed output.
export class Sessions extends EventEmitter {
  lanes = new Map();
  views = new Map();
  watching = new Map();
  owners = new Map();
  promptTimers = new Map();
  verifiers = new Map();
  hooks = new Map();
  bursts = new Map();
  // Clients whose page focus is in a session's terminal, and the screen confirmation last handed to it.
  attention = new Map();
  handed = new Map();
  closed = false;
  // `env` is what every session inherits; `roots` bound the directories sessions may start in (the workspace is always allowed).
  constructor({ directory, workspace, adapters, verifyTimeout = 600000, env = harnessEnvironment(), roots = [] }) {
    super();
    this.directory = resolve(directory);
    this.env = env;
    Object.assign(this, Sessions.places(workspace, roots), { adapters, verifyTimeout });
    this.events = new EventLog(join(this.directory, "events.jsonl"));
    this.store = new JsonStore(join(this.directory, "sessions.json"), { version: 2, sessions: [], proposals: [], operations: [], nextNumber: 1 });
    if (this.store.value.version === 1) this.migrate();
    if (this.store.value.version !== 2 || !Array.isArray(this.store.value.sessions) || !Array.isArray(this.store.value.proposals)) throw new Error("Unsupported session state");
    this.socket = join(this.directory, "tmux.sock");
    this.hookSocket = join(this.directory, "hook.sock");
    this.config = join(this.directory, "tmux.conf");
    // The server keeps running without sessions so it is always started with the minimal environment below,
    // never with a session's environment (which may carry a short-lived token).
    writeFileSync(this.config, "set -g exit-empty off\nset -g remain-on-exit on\nset -g history-limit 2000\nset -g status off\nset -g mouse on\nset -g default-terminal xterm-256color\n", { mode: 0o600 });
  }
  // Real paths of the workspace and the allowed roots; throws before anything changes when one is unavailable.
  static places(workspace, roots) {
    const real = (path, label) => {
      try { return realpathSync(path); }
      catch (error) { throw failure(400, `${label} ${path} is unavailable: ${error.code}`); }
    };
    const home = real(workspace, "Workspace");
    return { workspace: home, roots: [...new Set([home, ...roots.map((root) => real(root, "Allowed session root"))])] };
  }
  // Settings apply to what starts next: running sessions keep their directory, harness command and hooks.
  configure({ workspace, roots, adapters, verifyTimeout }) {
    Object.assign(this, Sessions.places(workspace, roots), { adapters, verifyTimeout });
    this.harnessCache = null;
  }
  migrate() {
    const old = this.store.value;
    for (const entry of old.audit ?? []) this.events.append({ migrated: true, ...entry });
    this.store.value = {
      version: 2, proposals: [], operations: old.operations ?? [], nextNumber: 1,
      sessions: old.sessions.map(({ grant, pending, initialInput, ...session }) => ({ ...session, grants: [] })),
    };
  }
  lane(id) {
    let lane = this.lanes.get(id);
    if (!lane) this.lanes.set(id, lane = new Serial());
    return lane;
  }
  async tmux(args, env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TERM: "xterm-256color" }) {
    try {
      return (await execute("tmux", ["-S", this.socket, "-f", this.config, ...args], {
        timeout: 10000, maxBuffer: 4 * 1024 * 1024, env,
      })).stdout;
    } catch (cause) {
      const error = new Error(`Terminal supervisor command failed: ${redact(cause.stderr?.trim() || cause.message)}`, { cause });
      error.code = "supervisor-failed";
      throw error;
    }
  }
  get(id) {
    const session = this.store.value.sessions.find((row) => row.id === id);
    if (!session) throw failure(404, "Unknown session");
    return session;
  }
  proposal(id) {
    // Numbers cycle, so a number names the latest proposal that used it.
    const proposal = this.store.value.proposals.find((row) => row.id === id) ?? this.store.value.proposals.findLast((row) => row.number === id);
    if (!proposal) throw failure(404, "Unknown proposal");
    return proposal;
  }
  currentRun(session) { return session.runs?.find((run) => run.id === session.currentRunId) ?? null; }
  observable(id) { return Boolean(this.views.get(id)?.alive); }
  ownerOf(id) { return this.owners.get(id) ?? null; }
  // Installed harnesses are looked up on the inherited PATH; a missing CLI is listed but cannot start.
  harnesses() {
    if (this.harnessCache && Date.now() - this.harnessCache.at < 3000) return structuredClone(this.harnessCache.list);
    const list = Object.entries(this.adapters).map(([name, adapter]) => {
      const path = findExecutable(adapter.argv[0], this.env.PATH ?? "");
      return { name, command: adapter.argv[0], available: Boolean(path), path };
    });
    this.harnessCache = { at: Date.now(), list };
    return structuredClone(list);
  }
  requireHarness(harness) {
    const entry = this.harnesses().find((row) => row.name === harness);
    if (!entry) throw failure(400, "Unknown harness");
    if (!entry.available) throw failure(409, `${harness} is not installed: \`${entry.command}\` was not found on PATH`);
  }
  defaultCwd(harness) { return join(this.workspace, `${harness}-work`); }
  // Resolves and creates a session directory; both the requested path and its real path must be inside a root.
  inside(path) { return this.roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)); }
  resolveCwd(harness, cwd) {
    const target = cwd ? resolve(this.workspace, cwd) : this.defaultCwd(harness);
    const inside = (path) => this.inside(path);
    const denied = () => failure(403, `Directory ${target} is outside the allowed roots: ${this.roots.join(", ")}`);
    if (!inside(target)) throw denied();
    // Missing levels are created one at a time below the deepest existing ancestor, each real path checked first,
    // so a symlink inside a root can never make mkdir create directories outside it.
    const missing = [];
    let existing = target;
    while (!lstatSync(existing, { throwIfNoEntry: false })) { missing.unshift(basename(existing)); existing = dirname(existing); }
    const real = (path) => {
      try { return realpathSync(path); }
      catch (error) { throw failure(400, `${target} cannot be resolved: ${error.code}`); }
    };
    let current = real(existing);
    if (!inside(current)) throw denied();
    for (const name of missing) {
      try { mkdirSync(join(current, name), { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw failure(400, `Cannot create ${target}: ${error.code}`); }
      current = real(join(current, name));
      if (!inside(current)) throw denied();
    }
    if (!statSync(current).isDirectory()) throw failure(400, `${target} is not a directory`);
    return current;
  }
  // The directory the session works in now: the pane's current path (a shell may have cd'ed), else its start directory.
  async currentDirectory(id) {
    const session = this.get(id);
    let path = session.cwd ?? this.workspace;
    if (session.state === "running") {
      const current = (await this.tmux(["display-message", "-p", "-t", id, "#{pane_current_path}"]).catch(() => "")).trim();
      if (current) path = current;
    }
    const real = await realpath(path).catch(() => { throw failure(409, `Working directory ${path} no longer exists`); });
    if (!this.inside(real)) throw failure(403, `Working directory ${real} is outside the allowed roots: ${this.roots.join(", ")}`);
    return real;
  }
  // Streams an upload into the session's current directory. An existing name is an error, never overwritten:
  // the bytes land in a hidden temporary file first and are published with link(), which refuses to replace.
  async upload(id, name, source, limit) {
    if (typeof name !== "string" || !name || Buffer.byteLength(name) > 255 || name === "." || name === ".." || /[/\\\0]/.test(name)) {
      throw failure(400, "File name must be a plain name without directories");
    }
    const directory = await this.currentDirectory(id);
    const target = join(directory, name);
    const exists = () => failure(409, `${target} already exists; rename or remove it first`);
    if (await stat(target).then(() => true, () => false)) throw exists();
    const temporary = join(directory, `.live-upload-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    let bytes = 0;
    try {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > limit) throw failure(413, `Upload exceeds the ${limit}-byte limit`);
        await file.write(chunk);
      }
      await file.close();
      await link(temporary, target).catch((error) => { throw error.code === "EEXIST" ? exists() : error; });
    } finally {
      await file.close().catch(() => {});
      await rm(temporary, { force: true });
    }
    const session = this.get(id);
    this.log("file-uploaded", session, { path: target, bytes });
    return { path: target, name, bytes, sessionId: id, sessionName: session.name };
  }
  // A regular file to download, named relative to the session's current directory and inside the allowed roots.
  async downloadable(id, path) {
    if (typeof path !== "string" || !path.trim() || path.includes("\0")) throw failure(400, "Give a file path");
    const target = resolve(await this.currentDirectory(id), path.trim());
    const real = await realpath(target).catch(() => { throw failure(404, `${target} does not exist`); });
    if (!this.inside(real)) throw failure(403, `${real} is outside the allowed roots: ${this.roots.join(", ")}`);
    const info = await stat(real);
    if (!info.isFile()) throw failure(400, `${real} is not a regular file`);
    return { path: real, name: basename(real), size: info.size };
  }
  list() {
    return structuredClone(this.store.value.sessions.filter((session) => !session.closed).map(({ runs, termination, ...session }) => ({
      ...session, currentRun: this.currentRun({ runs, currentRunId: session.currentRunId }),
      verification: session.verification ? {
        ...session.verification,
        state: session.verification.inputEpoch !== session.inputEpoch
          || session.verification.runId !== (session.currentRunId ?? session.processRunId) ? "stale" : session.verification.state,
      } : null,
    })));
  }
  // Quiet proposals wait for a human who is already looking at that terminal, so they are not shown or announced.
  pending() {
    return structuredClone(this.store.value.proposals.filter((proposal) => (proposal.state === "pending" && !proposal.quiet) || proposal.state === "approved"));
  }
  // Pending proposals including those hidden while their terminal has focus; a numbered decision may still name them.
  waiting() {
    return structuredClone(this.store.value.proposals.filter((proposal) => proposal.state === "pending"));
  }
  proposalById(id) {
    const proposal = this.store.value.proposals.find((row) => row.id === id);
    return proposal ? structuredClone(proposal) : null;
  }
  proposalByNumber(number) {
    const proposal = this.store.value.proposals.findLast((row) => row.number === number);
    return proposal ? structuredClone(proposal) : null;
  }
  log(kind, session, extra = {}) {
    try { this.events.append({ kind, sessionId: session?.id ?? null, revision: session?.revision ?? null, ...extra }); }
    catch (error) { this.emit("fault", new Error(`Event log write failed: ${error.message}`)); }
  }
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    // Decided proposals and old receipts stay in events.jsonl; the snapshot keeps what decisions and retries need.
    const proposals = this.store.value.proposals;
    const done = proposals.filter((proposal) => finished.has(proposal.state));
    if (done.length > 200) {
      const drop = new Set(done.slice(0, done.length - 200));
      this.store.value.proposals = proposals.filter((proposal) => !drop.has(proposal));
    }
    if (this.store.value.operations.length > 2000) this.store.value.operations = this.store.value.operations.slice(-2000);
    for (const session of this.store.value.sessions) {
      if ((session.runs?.length ?? 0) > 100) session.runs = session.runs.filter((run, index) => index >= session.runs.length - 100 || run.id === session.currentRunId);
    }
    this.store.save();
  }
  saveSoon() {
    this.saveTimer ??= setTimeout(() => { try { this.save(); } catch (error) { this.emit("fault", error); } }, 500);
    this.saveTimer.unref?.();
  }
  changed() { this.emit("state"); }
  recordInput(session, data, source, op, control = "append") {
    session.inputEpoch = (session.inputEpoch ?? 0) + 1;
    const previous = this.currentRun(session);
    if (previous) previous.state = "superseded";
    const run = {
      id: randomUUID(), sessionId: session.id, processRunId: session.processRunId,
      previousRunId: previous?.id ?? null, control, source,
      inputHash: digest(data), preview: redact(data).slice(0, 256),
      state: "input-prepared", startedAt: Date.now(), lastInputOperationId: op,
      verification: null,
    };
    session.runs ??= [];
    session.runs.push(run);
    session.currentRunId = run.id;
    return run;
  }

  // Lifecycle and observation.
  async initialize() {
    const restarted = [];
    for (const session of this.store.value.sessions) {
      session.processRunId ??= randomUUID();
      session.inputEpoch ??= 0;
      session.runs ??= [];
      session.grants ??= [];
      session.initialInput = null;
      const run = this.currentRun(session);
      if (run && !["cancelled", "verification-passed", "verification-failed", "superseded"].includes(run.state)) run.state = "unknown";
      if (["starting", "running", "unknown"].includes(session.state)) {
        session.revision++;
        restarted.push(session);
      }
    }
    for (const proposal of this.store.value.proposals) {
      if (proposal.state === "approved") { proposal.state = "uncertain"; proposal.reason = "Web backend restarted before delivery was confirmed"; }
      else if (proposal.state === "pending" && proposal.sessionId) { proposal.state = "superseded"; proposal.reason = "Web backend restarted"; }
    }
    for (const operation of this.store.value.operations) {
      if (operation.kind === "verification" && operation.state === "prepared") {
        operation.state = "uncertain";
        operation.result = { state: "unknown", runId: operation.runId, reason: "Web backend restarted; verification was not replayed" };
      }
    }
    await this.reconcileAll();
    for (const session of restarted) if (session.state === "running") await this.watch(session);
    this.save();
    await this.listenHooks();
    this.poll = setInterval(() => { void this.reconcileAll().catch((error) => this.emit("fault", error)); }, 1000);
    this.poll.unref();
  }
  // One tmux query reconciles every session; state changes are applied inside each session's own lane.
  async reconcileAll() {
    if (this.reconciling || this.closed) return;
    this.reconciling = true;
    try {
      // A session still starting is checked by its own creation; the pane list below would be stale for it.
      const running = this.store.value.sessions.filter((row) => ["running", "unknown"].includes(row.state));
      if (!running.length) return;
      let panes = new Map();
      try {
        const text = await this.tmux(["list-panes", "-a", "-F", "#{session_name}|#{pane_dead}|#{pane_dead_status}|#{pane_pid}"]);
        panes = new Map(text.trim().split("\n").filter(Boolean).map((line) => { const [id, ...rest] = line.split("|"); return [id, rest]; }));
      } catch (error) { if (!missing.test(error.cause?.stderr ?? "")) throw error; }
      await Promise.all(running.map((session) => this.lane(session.id).run(() => {
        if (!["running", "unknown"].includes(session.state)) return;
        this.applyPane(session, panes.get(session.id));
      })));
    } finally { this.reconciling = false; }
  }
  applyPane(session, pane) {
    if (!pane) {
      session.state = "lost";
      this.endSession(session, "process-lost");
      return;
    }
    const [dead, exitCode, pid] = pane;
    session.pid = Number(pid);
    if (dead === "0") { session.state = "running"; return; }
    session.state = "exited";
    session.exitCode = /^\d+$/.test(exitCode) ? Number(exitCode) : null;
    try {
      const recorded = readFileSync(join(this.directory, `exit-${session.id}.txt`), "utf8").trim();
      if (!/^\d+$/.test(recorded) || Number(recorded) > 255) throw new Error("Invalid recorded harness exit status");
      session.exitCode = Number(recorded);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const run = this.currentRun(session);
    if (run && !["verification-passed", "verification-failed", "cancelled"].includes(run.state)) run.state = "process-exited";
    this.endSession(session, "process-exited", { exitCode: session.exitCode });
  }
  // A finished process ends its proposals, grants and runtime files; nothing is replayed later.
  endSession(session, kind, extra = {}) {
    session.revision++;
    session.grants = [];
    session.initialInput = null;
    this.supersede(session, kind, null);
    this.attention.delete(session.id); this.handed.delete(session.id);
    rmSync(join(this.directory, "runtime", session.id), { recursive: true, force: true });
    this.log(kind, session, extra);
    this.save();
    this.changed();
  }
  supersede(session, reason, kinds = terminalInput) {
    let count = 0;
    for (const proposal of this.store.value.proposals) {
      if (proposal.sessionId !== session.id || proposal.state !== "pending") continue;
      if (kinds && !kinds.includes(proposal.kind)) continue;
      proposal.state = "superseded"; proposal.reason = reason; proposal.decidedAt = Date.now();
      this.hooks.get(proposal.id)?.(null);
      count++;
    }
    return count;
  }
  watch(session) {
    if (this.watching.has(session.id)) return this.watching.get(session.id);
    const pending = this.startObserver(session).finally(() => this.watching.delete(session.id));
    this.watching.set(session.id, pending);
    return pending;
  }
  async startObserver(session) {
    const id = session.id;
    const prior = this.views.get(id);
    if (prior) { prior.close(); await prior.writes; prior.terminal.dispose(); }
    const terminal = new headless.Terminal({ cols: session.cols, rows: session.rows, scrollback: 2000, allowProposedApi: true });
    const serializer = new serialize.SerializeAddon();
    terminal.loadAddon(serializer);
    const child = spawn("tmux", ["-S", this.socket, "-C", "attach-session", "-f", "ignore-size", "-t", id], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm-256color", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const view = {
      terminal, serializer, writes: Promise.resolve(), queuedBytes: 0, observationId: randomUUID(),
      sequence: 0, emitted: 0, lastOutput: Date.now(), alive: true, commands: [],
    };
    const fail = (error) => {
      if (!view.alive) return;
      view.alive = false;
      child.kill("SIGTERM");
      for (const command of view.commands.splice(0)) command.reject(error);
    };
    view.close = () => fail(new Error("Terminal observer closed"));
    // Control-mode commands answer in order with %begin/%end blocks; input uses the same channel as output.
    // A line with several `;`-separated commands answers with one block per command; onEnd receives every block.
    view.command = (line, onEnd, blocks = 1) => new Promise((done, reject) => {
      if (!view.alive) { reject(failure(409, "Terminal observer is unavailable")); return; }
      const results = [];
      for (let i = 0; i < blocks; i++) {
        const last = i === blocks - 1;
        view.commands.push({
          reject,
          done: (content) => { results.push(content); if (last) done(blocks === 1 ? content : results); },
          onEnd: last && onEnd ? (content) => onEnd(blocks === 1 ? content : [...results, content]) : null,
        });
      }
      child.stdin.write(`${line}\n`);
    });
    this.views.set(id, view);
    const decoder = new StringDecoder("utf8");
    let buffered = Buffer.alloc(0);
    let initialized = false, block = null;
    child.stdout.on("data", (chunk) => {
      if (!view.alive || this.closed) return;
      buffered = Buffer.concat([buffered, chunk]);
      let newline;
      while ((newline = buffered.indexOf(10)) !== -1) {
        const line = buffered.subarray(0, newline).toString("latin1");
        buffered = buffered.subarray(newline + 1);
        if (block) {
          if (line === `%end ${block.tag}` || line === `%error ${block.tag}`) {
            const ok = line.startsWith("%end");
            const content = Buffer.from(block.lines.join("\n"), "latin1").toString("utf8");
            const command = block.ours ? view.commands.shift() : null;
            block = null;
            if (!command) continue;
            if (!ok) { command.reject(new Error(`Terminal command failed: ${redact(content.slice(0, 200))}`)); continue; }
            try { command.onEnd?.(content); command.done(content); }
            catch (error) { command.reject(error); }
            continue;
          }
          block.bytes += line.length;
          if (block.bytes > 4 * 1024 * 1024) { fail(new Error("Terminal snapshot exceeded its size limit")); return; }
          block.lines.push(line);
          continue;
        }
        const begin = /^%begin (\d+ \d+ (\d+))$/.exec(line);
        if (begin) { block = { tag: begin[1], ours: begin[2] === "1", lines: [], bytes: 0 }; continue; }
        const match = /^%output %\d+ (.*)$/.exec(line);
        if (!match) continue;
        const data = decoder.write(decode(match[1]));
        if (!initialized || !data) continue;
        const sequence = ++view.sequence;
        view.lastOutput = Date.now();
        const bytes = Buffer.byteLength(data);
        if (view.queuedBytes + bytes > 4 * 1024 * 1024) {
          fail(new Error("Terminal renderer fell behind"));
          this.emit("gap", { sessionId: id });
          return;
        }
        view.queuedBytes += bytes;
        view.writes = view.writes.then(() => new Promise((done) => terminal.write(data, done)));
        void view.writes.then(() => {
          view.queuedBytes -= bytes;
          view.emitted = sequence;
          this.emit("output", { sessionId: id, processRunId: session.processRunId, observationId: view.observationId, sequence, data });
          this.observePrompt(session);
        }).catch((error) => this.emit("fault", error));
      }
      if (buffered.length > 8 * 1024 * 1024) { fail(new Error("Terminal observer line overflow")); this.emit("gap", { sessionId: id }); }
    });
    child.stderr.on("data", () => this.emit("fault", new Error("Terminal observer reported an error")));
    child.on("error", () => fail(new Error("Terminal observer failed to start")));
    child.stdin.on("error", () => fail(new Error("Terminal observer command channel failed")));
    child.on("exit", () => {
      const unexpected = view.alive;
      fail(new Error("Terminal observer exited"));
      if (unexpected && !this.closed && session.state === "running") this.emit("fault", new Error("Terminal observer detached; it reattaches on the next view"));
    });
    const timeout = setTimeout(() => fail(new Error("Terminal snapshot handshake timed out")), 10000);
    try {
      // Capture and cursor metadata come back in one block, so no output is lost or duplicated around the attach.
      await view.command(`capture-pane -p -e -t ${quote(id)} -S -2000 ; display-message -p -t ${quote(id)} '#{cursor_x}|#{cursor_y}|#{alternate_on}'`, ([capture, metadata]) => {
        const lines = capture.split("\n");
        const values = metadata.trim().split("|").map(Number);
        if (values.length !== 3 || values.some((value) => !Number.isInteger(value) || value < 0) || values[2] > 1) throw new Error("Invalid terminal snapshot metadata");
        const [x, y, alternate] = values;
        const data = (alternate ? "\x1b[?1049h" : "") + lines.join("\n").replace(/\n$/, "").replaceAll("\n", "\r\n") + `\x1b[${y + 1};${x + 1}H`;
        view.writes = view.writes.then(() => new Promise((done) => terminal.write(data, done)));
        initialized = true;
      }, 2);
      await view.writes;
    } catch (error) {
      fail(error);
      throw error;
    } finally { clearTimeout(timeout); }
    this.observePrompt(session);
  }
  async snapshot(id) {
    const session = this.get(id);
    if (session.state === "running" && !this.observable(id)) await this.watch(session);
    const view = this.views.get(id);
    let data, observationId = null, sequence = 0;
    if (view) {
      await view.writes;
      data = view.serializer.serialize({ scrollback: 2000 });
      // Output events up to `sequence` are already in this serialization; the client replays only later ones.
      ({ observationId, emitted: sequence } = view);
      // Screen capture and xterm serialization omit tmux's native mouse modes.
      if (session.state === "running") {
        const modes = [["mouse_standard_flag", 1000], ["mouse_button_flag", 1002], ["mouse_all_flag", 1003], ["mouse_utf8_flag", 1005], ["mouse_sgr_flag", 1006], ["keypad_cursor_flag", 1], ["cursor_flag", 25]];
        const flags = (await this.tmux(["display-message", "-p", "-t", id, modes.map(([flag]) => `#{${flag}}`).join("|")])).trim().split("|");
        if (flags.length !== modes.length || flags.some((flag) => flag !== "0" && flag !== "1")) throw new Error("Unexpected native terminal mode state");
        data += modes.map(([, mode]) => `\x1b[?${mode}l`).join("")
          + modes.filter((_, i) => flags[i] === "1").map(([, mode]) => `\x1b[?${mode}h`).join("");
      } else {
        // A killed TUI never switched off mouse and focus reporting; the page must not keep sending reports to nothing.
        data += [1000, 1002, 1003, 1005, 1006, 1004].map((mode) => `\x1b[?${mode}l`).join("");
      }
    } else if (session.state === "exited") {
      data = (await this.tmux(["capture-pane", "-p", "-e", "-t", id, "-S", "-2000"])).replaceAll("\n", "\r\n");
    } else data = "\r\n[The original terminal process is unavailable. No work was replayed.]\r\n";
    return { sessionId: id, revision: session.revision, cols: session.cols, rows: session.rows, data, observationId, sequence, gap: true };
  }
  // Visible screen only; prompts and progress are judged from what the human would see now.
  screen(id) {
    const view = this.views.get(id);
    if (!view) throw failure(409, "Terminal observer is unavailable");
    const buffer = view.terminal.buffer.active;
    return logicalLines(buffer, buffer.viewportY, buffer.viewportY + view.terminal.rows);
  }
  history(id, count = 200) {
    const view = this.views.get(id);
    if (!view) throw failure(409, "Terminal observer is unavailable");
    const buffer = view.terminal.buffer.active;
    return logicalLines(buffer, Math.max(0, buffer.length - count), buffer.length);
  }
  observePrompt(session) {
    if (this.closed) return;
    clearTimeout(this.promptTimers.get(session.id));
    const timer = setTimeout(() => {
      this.promptTimers.delete(session.id);
      void this.lane(session.id).run(() => this.checkPrompt(session)).catch((error) => this.emit("fault", error));
    }, session.initialInput ? 1200 : 300);
    timer.unref();
    this.promptTimers.set(session.id, timer);
  }
  async checkPrompt(session) {
    if (session.state !== "running" || !this.observable(session.id)) return;
    // A native hook that is still waiting is the structured form of what the screen shows.
    if (this.store.value.proposals.some((row) => row.sessionId === session.id && row.kind === "permission" && row.state === "pending")) return;
    const prompt = detectPrompt(this.screen(session.id));
    // A confirmation handed to the terminal stays the human's until it leaves the screen. After a native hook is
    // handed back (`true`), the menu the harness then draws is that same request, not a new confirmation.
    if (this.handed.get(session.id) === true) { if (prompt) this.handed.set(session.id, prompt.anchor); }
    else if (this.handed.has(session.id) && this.handed.get(session.id) !== prompt?.anchor) this.handed.delete(session.id);
    const existing = this.store.value.proposals.find((row) => row.sessionId === session.id && row.kind === "prompt" && row.state === "pending");
    if (existing && existing.anchor === prompt?.anchor) return;
    if (existing) {
      existing.state = "superseded"; existing.decidedAt = Date.now();
      existing.reason = prompt ? "The terminal shows a different confirmation" : "The confirmation is no longer on screen";
      this.log("proposal-superseded", session, { proposalId: existing.id });
    }
    if (prompt) {
      if (this.handed.get(session.id) !== prompt.anchor) {
        const proposal = this.addProposal({
          kind: "prompt", sessionId: session.id, data: prompt.data, anchor: prompt.anchor,
          preview: prompt.question, source: prompt.kind, key: prompt.anchor, quiet: this.attended(session.id),
        });
        await this.applyGrant(session, proposal);
      }
    } else if (session.initialInput && Date.now() - this.views.get(session.id).lastOutput >= 1000) {
      // The user approved this exact initial task together with session creation.
      const { data, proposalId } = session.initialInput;
      session.initialInput = null;
      this.recordInput(session, data, "initial-task", proposalId);
      this.save();
      await this.write(session.id, data);
      this.currentRun(session).state = "input-delivered";
      this.log("initial-input-delivered", session, { proposalId });
    }
    this.save();
    this.changed();
  }

  // Proposals and decisions.
  // Numbers cycle through 1-99 so they stay short to read and say; a number that is still waiting is skipped.
  allocateNumber() {
    const busy = new Set(this.store.value.proposals.filter((row) => ["pending", "approved"].includes(row.state)).map((row) => row.number));
    let number = (Math.max(1, this.store.value.nextNumber) - 1) % 99 + 1;
    for (let i = 0; i < 99 && busy.has(number); i++) number = number % 99 + 1;
    if (busy.has(number)) throw failure(409, "99 proposals are already waiting; decide some of them first");
    this.store.value.nextNumber = number % 99 + 1;
    return number;
  }
  addProposal(fields) {
    const session = fields.sessionId ? this.get(fields.sessionId) : null;
    const proposal = {
      id: randomUUID(), number: this.allocateNumber(), state: "pending", createdAt: Date.now(),
      sessionId: null, harness: session?.harness ?? null, name: session?.name ?? null, data: "", preview: "",
      source: "assistant", control: "append", anchor: null, key: null, runId: session ? (session.currentRunId ?? session.processRunId) : null,
      epoch: session?.revision ?? null, decidedAt: null, reason: null, ...fields,
    };
    proposal.preview = redact(proposal.preview || proposal.data);
    this.store.value.proposals.push(proposal);
    this.log("proposal-created", session, { proposalId: proposal.id, number: proposal.number, proposalKind: proposal.kind });
    return proposal;
  }
  async applyGrant(session, proposal) {
    const grant = session?.grants?.find((row) => row.kind === proposal.kind && row.key === proposal.key);
    if (!grant) {
      // Only proposals that actually wait for the human are announced, and quiet ones only once they surface.
      if (!proposal.quiet) this.emit("proposal", structuredClone(proposal));
      return false;
    }
    proposal.state = "approved"; proposal.decidedAt = Date.now(); proposal.reason = "Standing grant";
    proposal.grantId = grant.id;
    grant.uses = (grant.uses ?? 0) + 1;
    this.log("grant-applied", session, { proposalId: proposal.id, grantId: grant.id });
    this.save();
    await this.deliver(proposal, randomUUID());
    return true;
  }
  // Creates an assistant or caller proposal. `epoch` is the authorization epoch seen before interpretation;
  // a later change is reported on the card instead of discarding the human's request.
  // `focus` asks the page to show a session created by this proposal.
  // `steps` are the key presses of a keys proposal (see keys.mjs).
  propose({ kind, sessionId = null, harness = null, cwd = null, data = "", steps = [], control = "append", source = "assistant", epoch = null, label = null, focus = false }) {
    z.enum(["input", "keys", "create", "cancel", "close", "verify"]).parse(kind);
    return this.lane(sessionId ?? "global").run(async () => {
      let session = null;
      if (sessionId) session = this.get(sessionId);
      if (kind === "input") {
        input.parse(data);
        z.enum(["append", "modify", "continue"]).parse(control);
        if (session.state !== "running") throw failure(409, "Session is not running");
      }
      if (kind === "keys") {
        steps = parseKeys(steps);
        if (!steps.length) throw failure(400, "Name at least one key to press");
        if (session.state !== "running") throw failure(409, "Session is not running");
      }
      if (kind === "create") {
        this.requireHarness(harness);
        cwd = cwd ? resolve(this.workspace, cwd) : this.defaultCwd(harness);
      }
      if (kind === "verify") z.string().trim().min(1).parse(data);
      if (kind !== "create" && !session) throw failure(400, "This proposal requires an exact session");
      const proposal = this.addProposal({
        kind, sessionId, data, control, source, key: kind === "input" ? digest(data) : kind === "keys" ? digest(JSON.stringify(steps)) : null, focus,
        ...(kind === "keys" ? { steps, preview: describeKeys(steps) } : {}),
        ...(kind === "create" ? { harness, name: label ?? harness, cwd, preview: `${data || "（空终端）"}\n目录：${cwd}` } : {}),
        ...(kind === "close" ? { preview: session.state === "running" ? "终止进程并关闭 tab" : "关闭 tab" } : {}),
        changedDuringInterpretation: epoch !== null && session ? epoch !== session.revision : false,
      });
      await this.applyGrant(["input", "keys"].includes(kind) ? session : null, proposal);
      this.save();
      this.changed();
      return structuredClone(proposal);
    });
  }
  // `mode`: "once", "always" (standing grant for identical prompts/inputs) or "terminal" (hand a hook back to the native prompt).
  // `source` ("button" or "voice") is only logged, so a decision's origin can be traced; it is not part of the fingerprint.
  async decide(proposalId, allowed, op, mode = "once", source = null) {
    operationId.parse(op);
    z.boolean().parse(allowed);
    z.enum(["once", "always", "terminal"]).parse(mode);
    z.enum(["button", "voice"]).nullable().parse(source);
    const proposal = this.proposal(proposalId);
    return this.lane(proposal.sessionId ?? "global").run(async () => {
      const fingerprint = JSON.stringify({ proposal: proposal.id, allowed, mode });
      const old = this.store.value.operations.find((entry) => entry.id === op);
      if (old) {
        if (old.fingerprint !== fingerprint) throw failure(409, "Decision ID belongs to different input");
        return old.state;
      }
      if (mode === "terminal" && proposal.kind !== "permission") throw failure(400, "Only native permission requests can be handed back to the terminal");
      if (mode === "always" && !["input", "keys", "prompt", "permission"].includes(proposal.kind)) throw failure(400, "Standing grants apply only to identical input, keys or confirmations");
      if (proposal.state !== "pending") throw failure(409, `Proposal ${proposal.number}. is ${proposal.state}${proposal.reason ? `: ${proposal.reason}` : ""}`);
      const session = proposal.sessionId ? this.get(proposal.sessionId) : null;
      if (session && sessionBound.has(proposal.kind)) {
        if (!["cancel", "close"].includes(proposal.kind) && session.state !== "running") throw failure(409, "Session is not running");
        if (terminalInput.includes(proposal.kind) && proposal.epoch !== session.revision) throw failure(409, "The terminal was taken over after this proposal; review it again");
        if (proposal.kind === "prompt" && allowed && detectPrompt(this.screen(session.id))?.anchor !== proposal.anchor) {
          proposal.state = "superseded"; proposal.reason = "The confirmation is no longer on screen";
          this.save(); this.changed();
          throw failure(409, "The confirmation is no longer on screen");
        }
        if (proposal.kind === "permission" && !this.hooks.has(proposal.id)) throw failure(409, "The native permission request is no longer waiting");
      }
      const operation = { id: op, proposalId: proposal.id, sessionId: proposal.sessionId, fingerprint, state: "prepared" };
      this.store.value.operations.push(operation);
      proposal.decidedAt = Date.now();
      delete proposal.quiet;
      this.log(allowed ? "user-approved" : "user-rejected", session, { proposalId: proposal.id, operationId: op, mode, source });
      if (mode === "terminal") {
        proposal.state = "terminal";
        this.handed.set(session.id, true);
        this.hooks.get(proposal.id)(null);
        operation.state = "terminal";
      } else if (!allowed) {
        proposal.state = "rejected";
        if (proposal.kind === "permission") this.hooks.get(proposal.id)({ behavior: "deny" });
        operation.state = "rejected";
      } else {
        if (mode === "always") {
          session.grants.push({ id: randomUUID(), kind: proposal.kind, key: proposal.key, label: proposal.preview.slice(0, 200), createdAt: Date.now(), uses: 0 });
          this.log("grant-created", session, { proposalId: proposal.id });
        }
        proposal.state = "approved";
        this.save();
        operation.state = await this.deliver(proposal, op);
      }
      this.save();
      this.changed();
      return operation.state;
    });
  }
  // Runs inside the proposal's lane.
  async deliver(proposal, op) {
    const session = proposal.sessionId ? this.get(proposal.sessionId) : null;
    try {
      if (proposal.kind === "input") {
        this.recordInput(session, proposal.data, proposal.source, op, proposal.control);
        this.save();
        await this.write(session.id, proposal.data);
        this.currentRun(session).state = "input-delivered";
      } else if (proposal.kind === "keys") {
        // Keys steer the running task (menus, interrupts, editors) instead of starting a new run.
        session.inputEpoch = (session.inputEpoch ?? 0) + 1;
        this.save();
        await this.press(session.id, proposal.steps);
        const run = this.currentRun(session);
        if (run) run.lastInputOperationId = op;
      } else if (proposal.kind === "prompt") {
        await this.write(session.id, proposal.data);
        const run = this.currentRun(session);
        if (run) run.lastInputOperationId = op;
      } else if (proposal.kind === "permission") {
        this.hooks.get(proposal.id)({ behavior: "allow" });
      } else if (proposal.kind === "create") {
        const created = await this.createSession({ harness: proposal.harness, name: proposal.name, cwd: proposal.cwd }, op);
        proposal.createdSessionId = created.id;
        if (proposal.focus) this.emit("focus", created.id);
        if (proposal.data) {
          const target = this.get(created.id);
          target.initialInput = { data: `${proposal.data}\r`, proposalId: proposal.id };
          this.observePrompt(target);
        }
      } else if (proposal.kind === "cancel") {
        await this.terminateSession(session, op);
      } else if (proposal.kind === "close") {
        await this.closeSession(session, op);
      } else if (proposal.kind === "verify") {
        const verification = this.runVerification(session, proposal.runId, proposal.data, op);
        void verification.completion.catch((error) => this.emit("fault", error));
      }
      proposal.state = "delivered";
      this.log("proposal-delivered", session, { proposalId: proposal.id, operationId: op });
    } catch (error) {
      proposal.state = "uncertain"; proposal.reason = error.message;
      const run = session && this.currentRun(session);
      if (run && proposal.kind === "input") run.state = "unknown";
      this.save();
      this.changed();
      throw error;
    }
    this.save();
    this.changed();
    return "delivered";
  }
  // Color and note only help the human tell tabs apart; they never change what the session may do.
  label(id, fields) {
    return this.lane(id).run(() => {
      const { color, note } = tabLabel.parse(fields);
      const session = this.get(id);
      if (session.closed) throw failure(409, "The tab is already closed");
      if (color !== undefined) session.color = color;
      if (note !== undefined) session.note = note || null;
      this.log("tab-labeled", session, { color: session.color ?? null, note: session.note ?? null });
      this.save();
      this.changed();
    });
  }
  revoke(id, grantId = null) {
    return this.lane(id).run(() => {
      const session = this.get(id);
      session.grants = grantId ? session.grants.filter((grant) => grant.id !== grantId) : [];
      this.log("authorization-revoked", session, { grantId });
      this.save();
      this.changed();
    });
  }
  waitForFeedback(id) {
    return this.lane(id).run(() => {
      const session = this.get(id);
      if (session.state !== "running") throw failure(409, "Session is not running");
      session.revision++;
      session.grants = []; session.initialInput = null;
      this.supersede(session, "Waiting for user feedback", terminalInput);
      const run = this.currentRun(session);
      if (run) run.state = "waiting-for-feedback";
      this.log("waiting-for-user-feedback", session);
      this.save();
      this.observePrompt(session);
      this.changed();
    });
  }

  // Native permission hooks: one request per connection, answered when the human decides.
  async listenHooks() {
    rmSync(this.hookSocket, { force: true });
    this.hookServer = createServer((socket) => {
      socket.setEncoding("utf8");
      let raw = "", proposal = null, answered = false;
      const answer = (decision) => {
        if (answered) return;
        answered = true;
        if (!socket.destroyed) socket.end(`${JSON.stringify(decision ?? {})}\n`);
      };
      socket.on("data", (chunk) => {
        if (proposal || answered) return;
        raw += chunk;
        if (raw.length > 1_000_000) { answer(null); return; }
        const newline = raw.indexOf("\n");
        if (newline === -1) return;
        let request;
        try { request = JSON.parse(raw.slice(0, newline)); } catch { answer(null); return; }
        void this.permission(request, answer).then((created) => { proposal = created; }).catch(() => answer(null));
      });
      socket.on("close", () => {
        if (answered || !proposal) return;
        answered = true;
        this.hooks.delete(proposal.id);
        void this.lane(proposal.sessionId).run(() => {
          if (proposal.state !== "pending") return;
          proposal.state = "superseded"; proposal.reason = "The native permission request ended"; proposal.decidedAt = Date.now();
          this.save(); this.changed();
        }).catch((error) => this.emit("fault", error));
      });
      socket.on("error", () => {});
    });
    this.hookServer.listen(this.hookSocket);
    await new Promise((done, reject) => { this.hookServer.once("listening", done); this.hookServer.once("error", reject); });
    chmodSync(this.hookSocket, 0o600);
  }
  permission({ sessionId, tool, input: toolInput }, answer) {
    z.string().uuid().parse(sessionId);
    return this.lane(sessionId).run(async () => {
      const session = this.get(sessionId);
      if (session.state !== "running" || !(session.hooks ?? this.adapters[session.harness]?.hooks)) throw failure(409, "Session does not accept native hooks");
      const name = z.string().max(200).parse(tool ?? "");
      const command = typeof toolInput?.command === "string" ? toolInput.command : JSON.stringify(toolInput ?? {});
      const preview = `${name}: ${command}${toolInput?.description ? `\n${toolInput.description}` : ""}`;
      const proposal = this.addProposal({
        kind: "permission", sessionId, data: "", preview: redact(preview).slice(0, 4000), source: "native-hook",
        key: digest(JSON.stringify([name, toolInput ?? {}])), tool: name, quiet: this.attended(sessionId),
      });
      this.hooks.set(proposal.id, (decision) => { this.hooks.delete(proposal.id); answer(decision); });
      await this.applyGrant(session, proposal);
      this.save();
      this.changed();
      return proposal;
    });
  }

  // Human terminal control. Typing claims the keyboard and supersedes pending assistant input for that session.
  claim(id, client) {
    return this.lane(id).run(() => this.takeOver(this.get(id), client, "input-owner-claimed"));
  }
  takeOver(session, client, kind) {
    session.revision++;
    session.initialInput = null;
    const superseded = this.supersede(session, "The user took over the terminal", terminalInput);
    const run = this.currentRun(session);
    if (run && !["cancelled", "superseded", "unknown"].includes(run.state)) run.state = "unknown";
    if (this.owners.get(session.id) !== client) {
      this.owners.set(session.id, client);
      this.emit("owner", { sessionId: session.id, client });
    }
    this.log(kind, session, { superseded });
    this.saveSoon();
    this.changed();
  }
  release(client) {
    for (const [id, owner] of this.owners) if (owner === client) { this.owners.delete(id); this.emit("owner", { sessionId: id, client: null }); }
  }
  // Giving the keyboard back only drops ownership; superseded proposals stay superseded and nothing is replayed.
  releaseSession(id, client) {
    return this.lane(id).run(() => {
      const session = this.get(id);
      if (this.owners.get(id) !== client) return;
      this.owners.delete(id);
      this.emit("owner", { sessionId: id, client: null });
      this.log("input-owner-released", session);
    });
  }
  userInput(id, data, client, binary = false) {
    return this.lane(id).run(async () => {
      const session = this.get(id);
      input.parse(data);
      z.boolean().parse(binary);
      if (binary && [...data].some((character) => character.charCodeAt(0) > 255)) throw failure(400, "Binary terminal input must contain only byte values");
      if (session.state !== "running") {
        // A page still showing the ended terminal may report mouse and focus changes; only typing is an error.
        if (passiveInput(data, { clicks: true })) return;
        throw failure(409, "Session is not running");
      }
      // Input changes ownership and supersedes proposals; once state cannot be saved it must not reach the process.
      if (this.store.failed) throw failure(503, "Durable state write failed; terminal input is blocked until the state directory is recovered");
      if (passiveInput(data)) {
        // Another viewer's mouse or focus reports must not reach a terminal someone else is driving.
        const owner = this.owners.get(id);
        if (owner === undefined || owner === client) await this.write(id, data, binary);
        return;
      }
      // Keys typed while the harness asks for confirmation answer its native prompt, so the cards for it end.
      if (this.handToTerminal(session, "The user answered in the terminal")) { this.save(); this.changed(); }
      // After Enter, a confirmation on screen is a new question even if it reads the same.
      if (data.includes("\r")) this.handed.delete(id);
      const pending = this.store.value.proposals.some((row) => row.sessionId === id && row.state === "pending" && terminalInput.includes(row.kind));
      if (this.owners.get(id) !== client || pending || session.initialInput) this.takeOver(session, client, "input-owner-claimed");
      session.inputEpoch = (session.inputEpoch ?? 0) + 1;
      await this.write(id, data, binary);
      this.noteBurst(session, data.length);
    });
  }
  attended(id) { return Boolean(this.attention.get(id)?.size); }
  // Typing answers harness confirmations (screen prompts and native hooks) natively: a hook abstains, a screen
  // confirmation is not raised again while it stays on screen. Nothing is approved or rejected on the human's behalf.
  handToTerminal(session, reason) {
    const handed = [];
    for (const proposal of this.store.value.proposals) {
      if (proposal.sessionId !== session.id || proposal.state !== "pending" || !["prompt", "permission"].includes(proposal.kind)) continue;
      proposal.state = "terminal"; proposal.reason = reason; proposal.decidedAt = Date.now();
      this.handed.set(session.id, proposal.kind === "prompt" ? proposal.anchor : true);
      this.hooks.get(proposal.id)?.(null);
      this.log("proposal-handed-to-terminal", session, { proposalId: proposal.id, reason });
      if (!proposal.quiet) handed.push(structuredClone(proposal));
      delete proposal.quiet;
    }
    for (const proposal of handed) this.emit("handled", proposal);
    return handed.length;
  }
  // Page focus in a terminal means the human is looking at it: its pending harness confirmations are hidden
  // (hooks keep waiting) and new ones start hidden. When the last such page leaves, those still waiting reappear
  // with their number; answering in the terminal ends them instead.
  attend(id, client, on) {
    z.boolean().parse(on);
    return this.lane(id).run(() => {
      const session = this.get(id);
      const clients = this.attention.get(id) ?? new Set();
      const before = clients.size > 0;
      if (on) clients.add(client); else clients.delete(client);
      if (clients.size) this.attention.set(id, clients); else this.attention.delete(id);
      const changed = [];
      for (const proposal of this.store.value.proposals) {
        if (proposal.sessionId !== id || proposal.state !== "pending" || !["prompt", "permission"].includes(proposal.kind)) continue;
        if (on && !proposal.quiet && session.state === "running") { proposal.quiet = true; changed.push(proposal); }
        else if (!on && before && !clients.size && proposal.quiet) { delete proposal.quiet; changed.push(proposal); }
      }
      for (const proposal of changed) {
        this.log(proposal.quiet ? "proposal-hidden-for-terminal" : "proposal-shown-again", session, { proposalId: proposal.id });
        this.emit(proposal.quiet ? "handled" : "proposal", structuredClone(proposal));
      }
      if (changed.length) { this.save(); this.changed(); }
    });
  }
  // Keystrokes are audited as bursts instead of one durable write per key.
  noteBurst(session, length) {
    const burst = this.bursts.get(session.id) ?? { keys: 0, characters: 0, startedAt: Date.now() };
    burst.keys++; burst.characters += length;
    clearTimeout(burst.timer);
    burst.timer = setTimeout(() => {
      this.bursts.delete(session.id);
      this.log("user-input", session, { keys: burst.keys, characters: burst.characters, startedAt: burst.startedAt });
      this.saveSoon();
    }, 1000);
    burst.timer.unref?.();
    this.bursts.set(session.id, burst);
  }
  async write(id, data, binary = false) {
    const view = this.views.get(id);
    const send = async (text) => {
      const bytes = Buffer.from(text, binary ? "latin1" : "utf8");
      for (let offset = 0; offset < bytes.length; offset += 1024) {
        const hex = [...bytes.subarray(offset, offset + 1024)].map((byte) => byte.toString(16).padStart(2, "0"));
        if (view?.alive) await view.command(`send-keys -t ${quote(id)} -H ${hex.join(" ")}`);
        else await this.tmux(["send-keys", "-t", id, "-H", ...hex]);
      }
    };
    if (!binary && data.length > 1 && data.endsWith("\r")) {
      await send(data.slice(0, -1));
      // Native TUIs distinguish paste bursts from an explicit submission key.
      await new Promise((done) => setTimeout(done, 80));
      await send("\r");
    } else await send(data);
  }
  // One step at a time, so an Escape is not read together with the next bytes as a different key.
  async press(id, steps) {
    for (const [index, step] of steps.entries()) {
      if (index) await new Promise((done) => setTimeout(done, 80));
      const { name, bytes } = encodeStep(step);
      if (!name) await this.write(id, bytes.toString("latin1"), true);
      else if (this.views.get(id)?.alive) await this.views.get(id).command(`send-keys -t ${quote(id)} ${name}`);
      else await this.tmux(["send-keys", "-t", id, name]);
    }
  }
  resize(id, cols, rows, client) {
    return this.lane(id).run(async () => {
      size.parse(cols); size.parse(rows);
      const session = this.get(id);
      // The page showing an unclaimed terminal sizes it, so the PTY fills the view; a held keyboard keeps its owner's size.
      const owner = this.owners.get(id);
      if (session.state !== "running") throw failure(409, `Cannot resize a ${session.state} terminal`);
      if (owner !== undefined && owner !== client) throw failure(409, "Only the active input owner can resize a running terminal");
      await this.tmux(["resize-window", "-t", id, "-x", String(cols), "-y", String(rows)]);
      session.cols = cols; session.rows = rows;
      this.views.get(id)?.terminal.resize(cols, rows);
      this.saveSoon();
    });
  }

  // Direct user actions (buttons) and the work behind approved proposals.
  create(options, op) {
    return this.lane("global").run(() => this.createSession(options, op));
  }
  async createSession({ harness, name, cwd = null, id = randomUUID(), cols = 100, rows = 30 }, op) {
    operationId.parse(op);
    z.string().uuid().parse(id);
    size.parse(cols); size.parse(rows);
    z.string().min(1).max(4096).nullable().parse(cwd);
    const adapter = this.adapters[harness];
    if (!adapter) throw failure(400, "Unknown harness");
    const fingerprint = JSON.stringify({ harness, name, cwd, cols, rows });
    const old = this.store.value.operations.find((entry) => entry.id === op && entry.kind === "create");
    if (old) {
      if (old.fingerprint !== fingerprint) throw failure(409, "Operation ID belongs to different input");
      return structuredClone(this.get(old.sessionId));
    }
    this.requireHarness(harness);
    const directory = this.resolveCwd(harness, cwd);
    let extra = {};
    try { extra = await adapter.env?.() ?? {}; }
    catch (error) { throw failure(409, `${harness} environment setup failed: ${redact(error.message)}`); }
    const session = {
      id, harness, name: z.string().trim().min(1).max(80).parse(name ?? harness), cwd: directory,
      state: "starting", revision: 1, cols, rows, pid: null, exitCode: null,
      processRunId: randomUUID(), inputEpoch: 0, runs: [], currentRunId: null,
      createdAt: Date.now(), grants: [], initialInput: null, hooks: Boolean(adapter.hooks),
    };
    this.store.value.sessions.push(session);
    const operation = { id: op, kind: "create", sessionId: id, fingerprint, state: "prepared" };
    this.store.value.operations.push(operation);
    this.log("create-prepared", session);
    this.save();
    return this.lane(id).run(async () => {
      try {
        // tmux 3.4 can lose pane_dead_status when PTY EOF wins the SIGCHLD race.
        // `bash -i` gets past the non-interactive guard of Ubuntu's ~/.bashrc; `exec` keeps the CLI's PID and exit status.
        const argv = adapter.rc ? ["/bin/bash", "-ic", 'exec "$0" "$@"', ...adapter.argv] : adapter.argv;
        const command = `${argv.map(quote).join(" ")}; result=$?; umask 077; printf '%s\\n' "$result" > ${quote(join(this.directory, `exit-${id}.txt`))} || printf '\\r\\n[Failed to record harness exit status]\\r\\n' >&2; exit "$result"`;
        // The session inherits the assistant environment through the tmux client environment (update-environment),
        // so values such as tokens never appear in argv or on disk.
        const { TMUX, TMUX_PANE, TERM, ...inherited } = { ...this.env, ...extra, LIVE_SESSION_ID: id, LIVE_HOOK_SOCKET: this.hookSocket };
        const names = Object.keys(inherited).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
        await this.tmux(["start-server"]);
        await this.tmux(["set-option", "-g", "update-environment", names.join(" "), ";",
          "new-session", "-d", "-s", id, "-x", String(cols), "-y", String(rows), "-c", directory, command, ";",
          "set-option", "-gu", "update-environment"], { ...inherited, TERM: "xterm-256color" });
        session.state = "running";
        const panes = await this.tmux(["display-message", "-p", "-t", id, "#{pane_dead}|#{pane_dead_status}|#{pane_pid}"]);
        this.applyPane(session, panes.trim().split("|"));
        if (session.state === "running") await this.watch(session);
        operation.state = "delivered";
      } catch (error) {
        session.state = "unknown";
        operation.state = "uncertain";
        this.save();
        throw error;
      }
      this.save();
      this.changed();
      return structuredClone(session);
    });
  }
  terminate(id, op) {
    return this.lane(id).run(() => this.terminateSession(this.get(id), op));
  }
  // Closing a tab ends its process first; a session whose termination is unconfirmed stays visible.
  closeTab(id, op) {
    return this.lane(id).run(async () => {
      await this.closeSession(this.get(id), op);
      this.save();
      this.changed();
    });
  }
  async closeSession(session, op) {
    await this.terminateSession(session, op);
    session.closed = true;
    this.log("tab-closed", session, { operationId: op });
  }
  async terminateSession(session, op) {
    operationId.parse(op);
    const id = session.id;
    if (this.store.value.sessions.some((entry) => entry.id !== id && entry.termination?.id === op)) throw failure(409, "Operation ID belongs to a different action");
    if (session.state === "terminated") return;
    for (const verifier of this.verifiers.values()) if (verifier.sessionId === id) verifier.stop("Target session cancelled; verification cancelled");
    // A retry keeps the processes an earlier attempt saw survive: the pane may be gone while they still run.
    const processes = (session.termination?.processes ?? []).filter(stillRunning);
    for (const process of session.pid ? processTree(session.pid) : []) {
      if (!processes.some((known) => known.id === process.id && known.startedAt === process.startedAt)) processes.push(process);
    }
    session.termination = { id: op, state: "prepared", processes };
    this.log("termination-prepared", session, { operationId: op });
    this.save();
    try { await this.tmux(["kill-session", "-t", id]); }
    catch (error) { if (!missing.test(error.cause?.stderr ?? "")) throw error; }
    try {
      await this.tmux(["has-session", "-t", id]);
      throw new Error("Session termination was not confirmed");
    } catch (error) { if (!missing.test(error.cause?.stderr ?? "")) throw error; }
    for (let attempt = 0; attempt < 40 && processes.some(stillRunning); attempt++) await new Promise((done) => setTimeout(done, 50));
    if (processes.some(stillRunning)) {
      session.state = "unknown";
      session.termination.state = "uncertain";
      this.log("termination-unconfirmed", session, { operationId: op });
      this.save();
      throw failure(409, "Terminal detached but descendant processes are still running; termination is unconfirmed");
    }
    session.state = "terminated";
    const run = this.currentRun(session);
    if (run) run.state = "cancelled";
    session.termination.state = "delivered";
    this.views.get(id)?.close();
    this.endSession(session, "termination-confirmed", { operationId: op });
  }
  startVerification(id, runId, command, op) {
    return this.lane(id).run(() => this.runVerification(this.get(id), runId, command, op));
  }
  runVerification(session, runId, command, op) {
    operationId.parse(op); operationId.parse(runId);
    z.string().trim().min(1).parse(command);
    const id = session.id;
    const fingerprint = JSON.stringify({ id, runId, command });
    const old = this.store.value.operations.find((entry) => entry.id === op && entry.kind === "verification");
    if (old) {
      if (old.fingerprint !== fingerprint) throw failure(409, "Operation ID belongs to different verification input");
      return { state: old.state, completion: this.verifiers.get(op)?.completion ?? Promise.resolve(old.result ?? { state: "unknown", runId }) };
    }
    if (session.state !== "running" || runId !== (session.currentRunId ?? session.processRunId)) throw failure(409, "Verification target is stale or not running");
    const operation = {
      id: op, kind: "verification", sessionId: id, runId, fingerprint, command,
      state: "prepared", inputEpoch: session.inputEpoch, startedAt: Date.now(), result: null,
    };
    this.store.value.operations.push(operation);
    this.log("verification-prepared", session, { operationId: op, runId });
    this.save();
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
      cwd: session.cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    // Long output is kept as a rolling tail; the command is never killed for being verbose.
    let output = "", reason = null, forceTimer;
    const signalGroup = (signal) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const stop = (why) => {
      reason ??= why;
      signalGroup("SIGTERM");
      forceTimer ??= setTimeout(() => signalGroup("SIGKILL"), 1000);
    };
    const deadline = setTimeout(() => stop(`Verification timed out after ${Math.round(this.verifyTimeout / 1000)}s`), this.verifyTimeout);
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
    const read = (decoder) => (chunk) => {
      output += decoder.write(chunk);
      if (output.length > 128000) output = output.slice(-64000);
    };
    child.stdout.on("data", read(stdoutDecoder)); child.stderr.on("data", read(stderrDecoder));
    const exit = new Promise((resolveExit) => {
      child.once("error", (error) => { reason = `Verification failed to start: ${error.code}`; resolveExit({ code: null, signal: null }); });
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    const completion = exit.then(async ({ code, signal }) => {
      clearTimeout(deadline); clearTimeout(forceTimer);
      output += stdoutDecoder.end() + stderrDecoder.end();
      signalGroup("SIGTERM");
      await new Promise((done) => setTimeout(done, 50));
      signalGroup("SIGKILL");
      return this.lane(id).run(() => {
        const stale = session.inputEpoch !== operation.inputEpoch
          || (session.currentRunId ?? session.processRunId) !== runId || session.state !== "running";
        const result = {
          sessionId: id, processRunId: session.processRunId, runId, operationId: op,
          inputEpoch: operation.inputEpoch, startedAt: operation.startedAt, endedAt: Date.now(),
          exitCode: code, signal, output: output.slice(-16000), reason,
          state: stale ? "stale" : reason || code === null ? "unknown" : code === 0 ? "passed" : "failed",
        };
        operation.result = result;
        operation.state = reason ? "uncertain" : "delivered";
        const run = session.runs?.find((entry) => entry.id === runId);
        if (run) {
          run.verification = result;
          if (!stale && run.state !== "unknown") run.state = result.state === "passed" ? "verification-passed" : result.state === "failed" ? "verification-failed" : "unknown";
        }
        session.verification = result;
        this.log("verification-result", session, { operationId: op, runId, state: result.state });
        this.save();
        this.emit("fact", result);
        this.changed();
        return result;
      });
    }).finally(() => this.verifiers.delete(op));
    this.verifiers.set(op, { sessionId: id, completion, stop });
    return { state: "started", completion };
  }
  cancelVerification(op) {
    const verifier = this.verifiers.get(operationId.parse(op));
    if (!verifier) throw failure(404, "Verification is not running");
    verifier.stop("Cancelled by the user");
    return verifier.completion;
  }
  async close() {
    this.closed = true;
    clearInterval(this.poll);
    for (const verifier of this.verifiers.values()) verifier.stop("Web backend closed; verification cancelled");
    await Promise.all([...this.verifiers.values()].map((verifier) => verifier.completion.catch(() => {})));
    for (const timer of this.promptTimers.values()) clearTimeout(timer);
    for (const burst of this.bursts.values()) clearTimeout(burst.timer);
    for (const answer of this.hooks.values()) answer(null);
    await Promise.all([...this.lanes.values()].map((lane) => lane.tail));
    await Promise.all(this.watching.values());
    await new Promise((done) => this.hookServer ? this.hookServer.close(() => done()) : done());
    rmSync(this.hookSocket, { force: true });
    this.save();
    for (const view of this.views.values()) view.close();
    await Promise.all([...this.views.values()].map((view) => view.writes));
    for (const { terminal } of this.views.values()) terminal.dispose();
    this.views.clear();
    // Sessions outlive the Web backend; an empty server (kept by exit-empty off) does not.
    const sessions = await this.tmux(["list-sessions", "-F", "#{session_name}"]).catch((error) => missing.test(error.cause?.stderr ?? "") ? "" : null);
    if (sessions === "") await this.tmux(["kill-server"]).catch(() => {});
  }
}
