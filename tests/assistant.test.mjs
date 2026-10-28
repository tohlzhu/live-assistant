import { test as base } from "node:test";
const test = (name, fn) => base(name, { timeout: 45000 }, fn);
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, symlink, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { z } from "zod";
import { Sessions, passiveInput } from "../packages/live-assistant/src/sessions.mjs";
import { startAssistant } from "../packages/live-assistant/src/server.mjs";
import { Assistant, parseDecision, createInterpreter } from "../packages/live-assistant/src/assistant.mjs";
import { defaultAdapters, harnessEnvironment, findExecutable } from "../packages/live-assistant/src/harness.mjs";
import { createSpeech } from "../packages/live-assistant/src/foundry.mjs";
import { condense, detectPrompt, DeltaMemory, trimTrailing } from "../packages/live-assistant/src/text.mjs";
import { EventLog } from "../packages/live-assistant/src/store.mjs";
import { parseKeys, describeKeys, encodeStep } from "../packages/live-assistant/src/keys.mjs";
import headless from "@xterm/headless";

const password = "synthetic-local-test-password";
const hookScript = new URL("../packages/live-assistant/src/hook.mjs", import.meta.url).pathname;
const shell = { argv: ["/bin/bash", "--noprofile", "--norc", "-i"] };
const confirmLoop = "stty -echo; printf '\\033[2J\\033[HProceed? [y/N]'; while read -r answer; do printf x >> count.txt; printf '\\033[2J\\033[HProceed? [y/N]'; done";
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, attempts = 200) {
  for (let i = 0; i < attempts; i++) { if (await predicate()) return; await pause(30); }
  throw new Error(`Timed out: ${label}`);
}
async function content(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}
const waiting = (sessions, id, kind) => sessions.pending().filter((row) => row.state === "pending" && (!id || row.sessionId === id) && (!kind || row.kind === kind));
async function fixture(t, adapters = { shell }, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "live-assistant-test-"));
  const sessions = new Sessions({ directory, workspace: directory, adapters, ...options });
  await sessions.initialize();
  t.after(async () => {
    for (const session of sessions.list()) {
      if (["running", "exited", "unknown"].includes(session.state)) await sessions.terminate(session.id, randomUUID());
    }
    await sessions.close();
    await rm(directory, { recursive: true });
  });
  return { sessions, directory };
}
const fakeLive = (contexts) => ({
  subscribe: () => () => {}, diagnostics: () => ({ state: "active", sessionId: "synthetic-live" }),
  appendContext: async (context) => contexts.push(context), close: async () => {}, usage: () => null,
});
function runHook(env, payload) {
  const child = spawn(process.execPath, [hookScript], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.end(JSON.stringify(payload));
  return once(child, "close").then(([code]) => ({ code, stdout }));
}

test("text helpers condense spinners and detect native Codex, Claude and trust confirmations", () => {
  assert.deepEqual(condense("⠋ Working (12s · esc to interrupt)\n────\n⠙ Working (13s · esc to interrupt)\nresult"), ["Working", "result"]);
  const codex = "Would you like to run the following command?\n  $ npm test\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)";
  const first = detectPrompt(`⠋ thinking (3s)\n${codex}`);
  assert.equal(first.kind, "menu");
  assert.equal(detectPrompt(`⠙ thinking (4s)\n${codex}`).anchor, first.anchor);
  assert.equal(detectPrompt(codex.replace("› 1.", "  1.").replace("  2. No", "› 2. No")), null);
  assert.equal(detectPrompt("Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit").kind, "menu");
  assert.equal(detectPrompt("Overwrite file? [y/N]").data, "y\r");
  assert.equal(detectPrompt("plain output"), null);
  const memory = new DeltaMemory();
  assert.deepEqual(memory.delta("a", ["one", "two"]), ["one", "two"]);
  assert.deepEqual(memory.delta("a", ["one", "two", "three"]), ["three"]);
  assert.deepEqual(parseDecision("批准 3。"), { allowed: true, mode: "once", number: 3 });
  assert.deepEqual(parseDecision("拒绝第二个"), { allowed: false, mode: "once", number: 2 });
  assert.deepEqual(parseDecision("始终允许十二号"), { allowed: true, mode: "always", number: 12 });
  assert.deepEqual(parseDecision("确认操作"), { allowed: true, mode: "once", number: null });
  assert.equal(parseDecision("他说批准"), null);
  // Natural wording around one decision is accepted; negations, questions, quotes, lists and longer sentences are not.
  for (const [speech, allowed, number] of [
    ["批准3号提案", true, 3], ["批准三号提案", true, 3], ["批准第3个提案", true, 3], ["批准提案3", true, 3],
    ["我批准3号", true, 3], ["好的，批准3号", true, 3], ["请批准3号。", true, 3], ["好的，那就批准 3 号吧", true, 3],
    ["拒绝提案 12", false, 12], ["不同意二十三号", false, 23], ["批准吧", true, null], ["approve proposal 4", true, 4],
  ]) assert.deepEqual(parseDecision(speech), { allowed, mode: "once", number }, speech);
  assert.deepEqual(parseDecision("始终允许 5 号提案"), { allowed: true, mode: "always", number: 5 });
  for (const speech of ["不批准3号", "别批准3号", "先不要批准3号", "要批准3号吗", "批准3号可以吗", "他说批准3号",
    "批准3号和4号", "先看看输出再批准3号", "我不同意你的看法", "批准 3？", "批准3号?", "同意吗？", "确认？"]) assert.equal(parseDecision(speech), null, speech);
});

test("trailing punctuation is trimmed in linear time, even around long runs", () => {
  assert.equal(trimTrailing("批准 3 号。 \n", /[。.!！\s]/), "批准 3 号");
  assert.equal(trimTrailing("。。", /[。]/), "");
  assert.equal(trimTrailing("a。b", /[。]/), "a。b");
  // A /[…]+$/ replace needs seconds for the inner run; spoken decisions are parsed on every transcript update.
  const inner = `批准${"\t".repeat(100_000)}3`;
  const trailing = `批准 3${"。".repeat(100_000)}`;
  const started = performance.now();
  assert.deepEqual(parseDecision(inner), { allowed: true, mode: "once", number: 3 });
  assert.deepEqual(parseDecision(trailing), { allowed: true, mode: "once", number: 3 });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `took ${Math.round(elapsed)} ms`);
});

test("actual PTYs run independently, preserve Unicode/control keys and resize, and survive Web observer restart", async (t) => {
  const { sessions, directory } = await fixture(t);
  const a = await sessions.create({ harness: "shell" }, randomUUID());
  const b = await sessions.create({ harness: "shell" }, randomUUID());
  await pause();
  await sessions.userInput(a.id, "printf '中文\\n'; test -t 0 && echo REAL_PTY\r", "a");
  await sessions.userInput(b.id, "sleep .3; printf 'SURVIVED\\n' > result.txt; echo OTHER_TERMINAL\r", "b");
  await until(() => sessions.history(a.id).includes("中文") && sessions.history(a.id).includes("REAL_PTY"), "PTY output");
  await sessions.resize(a.id, 90, 20, "a");
  await sessions.userInput(a.id, "stty size\r", "a");
  await until(() => sessions.history(a.id).includes("20 90"), "terminal dimensions");
  await sessions.userInput(a.id, "sleep 60\r", "a");
  await pause();
  await sessions.userInput(a.id, "\x03", "a");
  await until(() => sessions.history(a.id).includes("^C"), "native Ctrl-C");
  const pid = sessions.get(b.id).pid;
  await sessions.close();
  await pause(400);
  assert.equal(await readFile(join(directory, "shell-work", "result.txt"), "utf8"), "SURVIVED\n");
  const restarted = new Sessions({ directory, workspace: directory, adapters: sessions.adapters });
  await restarted.initialize();
  try {
    assert.equal(restarted.get(b.id).pid, pid);
    assert.equal(restarted.get(b.id).state, "running");
    assert.match((await restarted.snapshot(b.id)).data, /OTHER_TERMINAL/);
    assert.equal(restarted.list().length, 2);
  } finally {
    for (const session of restarted.list()) await restarted.terminate(session.id, randomUUID());
    await restarted.close();
    for (const session of sessions.store.value.sessions) session.state = "terminated";
  }
});

test("duplicate creation is not replayed and reused operation IDs cannot change their target", async (t) => {
  const { sessions } = await fixture(t);
  const op = randomUUID();
  const created = await sessions.create({ harness: "shell", name: "one" }, op);
  const replay = await sessions.create({ harness: "shell", name: "one" }, op);
  assert.equal(replay.id, created.id);
  assert.equal(sessions.list().length, 1);
  await assert.rejects(sessions.create({ harness: "shell", name: "different" }, op), /different input/);
  await sessions.terminate(created.id, randomUUID());
  assert.match((await sessions.snapshot(created.id)).data, /bash-/);
});

test("snapshots report the last output event they contain so attaching clients can drop overtaken output", async (t) => {
  const { sessions } = await fixture(t);
  const session = await sessions.create({ harness: "shell", name: "attach" }, randomUUID());
  const outputs = [];
  sessions.on("output", (event) => { if (event.sessionId === session.id) outputs.push(event); });
  await sessions.userInput(session.id, "echo BEFORE_SNAPSHOT\r", "a");
  await until(() => outputs.map((event) => event.data).join("").split("BEFORE_SNAPSHOT").length > 2, "command echo and its output");
  const snapshot = await sessions.snapshot(session.id);
  assert.match(snapshot.data, /BEFORE_SNAPSHOT/);
  assert.equal(snapshot.observationId, outputs.at(-1).observationId);
  assert.equal(snapshot.sequence, outputs.at(-1).sequence);
  await sessions.userInput(session.id, "echo AFTER_SNAPSHOT\r", "a");
  await until(() => outputs.some((event) => event.sequence > snapshot.sequence && event.data.includes("AFTER_SNAPSHOT")), "output after snapshot");
});

test("a reconcile poll racing session startup never marks the new session lost", async (t) => {
  const { sessions } = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const creating = sessions.create({ harness: "shell", name: `race-${i}` }, randomUUID());
    const polls = Promise.all([0, 1, 2].map(() => pause(i * 3).then(() => sessions.reconcileAll())));
    const created = await creating;
    await polls;
    assert.equal(sessions.get(created.id).state, "running");
  }
});
test("typing supersedes pending input; rejection, idempotent approval and stale decisions are exact", async (t) => {
  const { sessions, directory } = await fixture(t);
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(200);
  let pending = await sessions.propose({ kind: "input", sessionId: session.id, data: "printf approved > approved.txt\r" });
  await sessions.userInput(session.id, "echo keyboard\r", "user");
  assert.equal(sessions.proposal(pending.id).state, "superseded");
  await assert.rejects(sessions.decide(pending.id, true, randomUUID()), (error) => error.status === 409);
  pending = await sessions.propose({ kind: "input", sessionId: session.id, data: "touch rejected.txt\r" });
  await sessions.decide(pending.id, false, randomUUID());
  pending = await sessions.propose({ kind: "input", sessionId: session.id, data: "printf approved > approved.txt\r" });
  const op = randomUUID();
  assert.equal(await sessions.decide(pending.id, true, op), "delivered");
  assert.equal(await sessions.decide(pending.id, true, op), "delivered");
  await assert.rejects(sessions.decide(pending.id, false, op), /different input/);
  await until(async () => await content(join(directory, "shell-work", "approved.txt")) === "approved", "approved input");
  assert.equal(await content(join(directory, "shell-work", "rejected.txt")), null);
  await assert.rejects(sessions.decide(randomUUID(), true, randomUUID()), (error) => error.status === 404);
  await assert.rejects(sessions.resize(session.id, 80, 24, "other"), /owner/);
});

test("after a failed durable state write, typing never reaches the terminal or changes its proposals", async (t) => {
  const { sessions, directory } = await fixture(t);
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await until(() => sessions.history(session.id).includes("bash-"), "ready shell");
  const proposal = await sessions.propose({ kind: "input", sessionId: session.id, data: "echo assistant\r" });
  await chmod(directory, 0o500);
  try { assert.throws(() => sessions.save(), /Durable state write failed/); }
  finally { await chmod(directory, 0o700); }
  await assert.rejects(sessions.userInput(session.id, "printf typed > typed.txt\r", "user"), (error) => error.status === 503);
  await pause(300);
  assert.equal(await content(join(directory, "shell-work", "typed.txt")), null);
  assert.equal(sessions.proposal(proposal.id).state, "pending");
  sessions.store.failed = false;
});

test("terminal-generated mouse motion, wheel, focus and replies reach the PTY without claiming or superseding", async (t) => {
  for (const data of ["\x1b[<35;10;5M\x1b[<35;11;5M", "\x1b[<64;3;4M", "\x1b[I", "\x1b[O", "\x1b[12;40R", "\x1b[?1;2c", "\x1b]11;rgb:0000/0000/0000\x07", "\x1b[MC!!"]) {
    assert.equal(passiveInput(data), true, JSON.stringify(data));
  }
  for (const data of ["\x1b[<0;10;5M", "\x1b[<0;10;5m", "\x1b[M !!", "x", "\x1b[A", "\x1b[<35;10;5Mx", "\x1b"]) {
    assert.equal(passiveInput(data), false, JSON.stringify(data));
  }
  const recorder = { argv: [process.execPath, "-e", 'const fs=require("node:fs");process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on("data",d=>fs.appendFileSync("input.bin",d));process.stdout.write("READY")'] };
  const { sessions, directory } = await fixture(t, { recorder });
  const session = await sessions.create({ harness: "recorder" }, randomUUID());
  await until(() => sessions.history(session.id).includes("READY"), "recorder ready");
  await sessions.claim(session.id, "owner");
  const proposal = await sessions.propose({ kind: "input", sessionId: session.id, data: "approved\r" });
  const { revision, inputEpoch } = sessions.get(session.id);
  await sessions.userInput(session.id, "\x1b[<35;10;5M\x1b[I", "owner");
  await sessions.userInput(session.id, "\x1b[<35;12;5M", "viewer");
  const file = join(directory, "recorder-work", "input.bin");
  await until(async () => (await content(file))?.includes("\x1b[I"), "passive input forwarded");
  assert.equal(sessions.proposal(proposal.id).state, "pending");
  assert.equal(sessions.get(session.id).revision, revision);
  assert.equal(sessions.get(session.id).inputEpoch, inputEpoch);
  assert.equal(sessions.ownerOf(session.id), "owner");
  await pause(200);
  assert.ok(!(await content(file)).includes("12;5M"), "another viewer's reports do not reach a driven terminal");
  await sessions.userInput(session.id, "\x1b[<0;10;5M", "owner");
  assert.equal(sessions.proposal(proposal.id).state, "superseded", "a deliberate click is a takeover");
});

test("an ended session's snapshot stops mouse and focus reporting and its leftover reports are ignored", async (t) => {
  const { sessions } = await fixture(t);
  const session = await sessions.create({ harness: "shell", name: "tui" }, randomUUID());
  // A TUI that is killed before switching its reporting modes back off.
  await sessions.userInput(session.id, "printf '\\033[?1003h\\033[?1006h\\033[?1004h'; echo TUI_''ON\r", "a");
  const view = () => sessions.views.get(session.id).terminal;
  await until(() => view().modes.mouseTrackingMode === "any" && view().modes.sendFocusMode, "reporting modes in the observer");
  await sessions.terminate(session.id, randomUUID());
  const snapshot = await sessions.snapshot(session.id);
  const page = new headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, allowProposedApi: true });
  t.after(() => page.dispose());
  await new Promise((done) => page.write(snapshot.data, done));
  assert.equal(page.modes.mouseTrackingMode, "none");
  assert.equal(page.modes.sendFocusMode, false);
  assert.match(snapshot.data, /TUI_ON/);
  // A page attached before the process ended still reports motion, clicks and focus; none of it is an error.
  for (const data of ["\x1b[<35;10;5M", "\x1b[<0;10;5M\x1b[<0;10;5m", "\x1b[I", "\x1b[O", "\x1b[M !!"]) await sessions.userInput(session.id, data, "a");
  await assert.rejects(sessions.userInput(session.id, "x", "a"), (error) => error.status === 409 && /not running/.test(error.message));
  await assert.rejects(sessions.userInput(session.id, "\x1b[<0;10;5Mx", "a"), (error) => error.status === 409);
});

test("spinner output never invalidates a pending proposal and several proposals wait independently", async (t) => {
  const { sessions, directory } = await fixture(t, { shell: { argv: [process.execPath, "-e",
    'const fs=require("fs");let n=0;setInterval(()=>process.stdout.write(`\\r⠋ working (${n++}s)`),100);process.stdin.on("data",(d)=>fs.appendFileSync("in.txt",d));'] } });
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  const first = await sessions.propose({ kind: "input", sessionId: session.id, data: "one\r" });
  const second = await sessions.propose({ kind: "input", sessionId: session.id, data: "two\r" });
  assert.equal(second.number, first.number + 1);
  await pause(1500);
  assert.equal(waiting(sessions, session.id).length, 2);
  await sessions.decide(second.id, true, randomUUID());
  await sessions.decide(first.id, true, randomUUID());
  await until(async () => /two\s+one/.test(await content(join(directory, "shell-work", "in.txt")) ?? ""), "both inputs in decision order");
});

test("a busy session lane never blocks input or decisions on another session", async (t) => {
  const { sessions, directory } = await fixture(t);
  const a = await sessions.create({ harness: "shell" }, randomUUID());
  const b = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(200);
  const busy = sessions.lane(a.id).run(() => pause(2000));
  const started = Date.now();
  await sessions.userInput(b.id, "printf lane > lane.txt\r", "user");
  const proposal = await sessions.propose({ kind: "input", sessionId: b.id, data: "printf decided > decided.txt\r" });
  await sessions.decide(proposal.id, true, randomUUID());
  assert.ok(Date.now() - started < 1500, "other session waited for a busy lane");
  await until(async () => await content(join(directory, "shell-work", "decided.txt")) === "decided", "independent decision");
  await busy;
});

test("large pastes reach the native process intact without exceeding transport frames", async (t) => {
  const { sessions, directory } = await fixture(t, { shell: { argv: ["/bin/bash", "-c", "stty -echo -icanon; head -c 300000 > paste.txt; sleep 60"] } });
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(200);
  const data = "abcdefghij".repeat(30000);
  for (let offset = 0; offset < data.length; offset += 4096) await sessions.userInput(session.id, data.slice(offset, offset + 4096), "user");
  await until(async () => (await content(join(directory, "shell-work", "paste.txt")))?.length === data.length, "complete paste");
  assert.equal(await content(join(directory, "shell-work", "paste.txt")), data);
});

test("terminal confirmations need a human decision; always-allow has no count limit until revoked", async (t) => {
  const { sessions, directory } = await fixture(t, { shell: { argv: ["/bin/bash", "-c", confirmLoop] } });
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await until(() => waiting(sessions, session.id, "prompt").length, "confirmation observation");
  await pause(500);
  assert.equal(await content(join(directory, "shell-work", "count.txt")), null);
  await sessions.decide(waiting(sessions, session.id, "prompt")[0].id, true, randomUUID(), "always");
  await until(async () => (await content(join(directory, "shell-work", "count.txt")))?.length >= 6, "repeated standing grant");
  await sessions.revoke(session.id);
  await pause(800);
  const count = (await content(join(directory, "shell-work", "count.txt"))).length;
  await pause(800);
  assert.equal((await content(join(directory, "shell-work", "count.txt"))).length, count);
  assert.equal(waiting(sessions, session.id, "prompt").length, 1);
  assert.equal(sessions.get(session.id).grants.length, 0);
});

test("waiting revokes grants and supersedes proposals without freezing the native process", async (t) => {
  const { sessions, directory } = await fixture(t, { shell: { argv: ["/bin/bash", "-c", confirmLoop] } });
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await until(() => waiting(sessions, session.id, "prompt").length, "possible confirmation");
  await sessions.decide(waiting(sessions, session.id, "prompt")[0].id, true, randomUUID());
  await until(async () => await content(join(directory, "shell-work", "count.txt")) === "x", "single approval");
  await until(() => waiting(sessions, session.id, "prompt").length, "next confirmation");
  await sessions.waitForFeedback(session.id);
  assert.equal(waiting(sessions, session.id).length, 0);
  assert.equal(sessions.get(session.id).state, "running");
  assert.equal(await content(join(directory, "shell-work", "count.txt")), "x");
});

test("native permission hooks wait for the human: allow, deny, hand back to the terminal and always-allow", async (t) => {
  const { sessions } = await fixture(t, { shell: { ...shell, hooks: true } });
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  const env = { LIVE_HOOK_SOCKET: sessions.hookSocket, LIVE_SESSION_ID: session.id };
  const payload = (command) => ({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command, description: "fixture" } });
  const decideNext = async (allowed, mode) => {
    await until(() => waiting(sessions, session.id, "permission").length, "hook proposal");
    const [proposal] = waiting(sessions, session.id, "permission");
    assert.match(proposal.preview, /Bash: /);
    await sessions.decide(proposal.id, allowed, randomUUID(), mode);
  };
  let hook = runHook(env, payload("npm test"));
  await decideNext(true, "once");
  let result = await hook;
  assert.deepEqual(JSON.parse(result.stdout).hookSpecificOutput.decision, { behavior: "allow" });
  hook = runHook(env, payload("rm -rf build"));
  await decideNext(false, "once");
  assert.equal(JSON.parse((await hook).stdout).hookSpecificOutput.decision.behavior, "deny");
  hook = runHook(env, payload("git push"));
  await decideNext(false, "terminal");
  result = await hook;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  hook = runHook(env, payload("npm run lint"));
  await decideNext(true, "always");
  await hook;
  result = await runHook(env, payload("npm run lint"));
  assert.deepEqual(JSON.parse(result.stdout).hookSpecificOutput.decision, { behavior: "allow" });
  assert.equal((await runHook({ ...env, LIVE_SESSION_ID: randomUUID() }, payload("npm test"))).stdout, "");
  hook = runHook(env, payload("sleep 1"));
  await until(() => waiting(sessions, session.id, "permission").length, "pending hook before termination");
  await sessions.terminate(session.id, randomUUID());
  assert.equal((await hook).stdout, "");
});

test("typing in the terminal ends its native permission cards; the hook abstains and the voice model is told", async (t) => {
  const { sessions } = await fixture(t, { shell: { ...shell, hooks: true } });
  const contexts = [];
  const assistant = new Assistant({ sessions, live: fakeLive(contexts) });
  t.after(() => assistant.close());
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  const env = { LIVE_HOOK_SOCKET: sessions.hookSocket, LIVE_SESSION_ID: session.id };
  const hook = runHook(env, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push" } });
  await until(() => waiting(sessions, session.id, "permission").length, "hook proposal");
  const [proposal] = waiting(sessions, session.id, "permission");
  await sessions.userInput(session.id, "\x1b[<35;5;5M", "viewer");
  assert.equal(waiting(sessions, session.id, "permission").length, 1, "mouse motion is not an answer");
  await sessions.userInput(session.id, "1", "viewer");
  assert.deepEqual(await hook, { code: 0, stdout: "" });
  assert.equal(waiting(sessions, session.id).length, 0);
  assert.equal(sessions.proposalByNumber(proposal.number).state, "terminal");
  await until(() => contexts.some((context) => context.silent && context.text.startsWith(`Proposal ${proposal.number}. (permission)`) && /answered by the user directly in the terminal/.test(context.text)), "handled context");
});

test("a numbered spoken decision applies to a card hidden by terminal focus", async (t) => {
  const { sessions } = await fixture(t, { shell: { ...shell, hooks: true } });
  const contexts = [];
  const assistant = new Assistant({ sessions, live: fakeLive(contexts) });
  t.after(() => assistant.close());
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  const env = { LIVE_HOOK_SOCKET: sessions.hookSocket, LIVE_SESSION_ID: session.id };
  await sessions.attend(session.id, "viewer", true);
  const hook = runHook(env, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push" } });
  await until(() => sessions.waiting().some((row) => row.sessionId === session.id && row.kind === "permission"), "hidden hook proposal");
  const [hidden] = sessions.waiting();
  assert.equal(waiting(sessions, session.id).length, 0);
  await assistant.voiceDecision(parseDecision(`好的，批准${hidden.number}号提案`));
  assert.deepEqual(JSON.parse((await hook).stdout).hookSpecificOutput.decision, { behavior: "allow" });
  assert.ok(contexts.some((context) => context.text.includes(`proposal ${hidden.number}. was applied`)));
});

test("page focus in a terminal hides its confirmations; leaving shows the same numbered card again", async (t) => {
  const { sessions, directory } = await fixture(t, { shell: { argv: ["/bin/bash", "-c", confirmLoop] } });
  const announced = [], hidden = [];
  sessions.on("proposal", (proposal) => announced.push(proposal.id));
  sessions.on("handled", (proposal) => hidden.push(proposal.id));
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await until(() => waiting(sessions, session.id, "prompt").length, "confirmation observation");
  const [prompt] = waiting(sessions, session.id, "prompt");
  // Focus moves in: the card is hidden but keeps waiting, and screen observation does not raise a second one.
  await sessions.attend(session.id, "viewer", true);
  assert.equal(waiting(sessions, session.id).length, 0);
  assert.equal(sessions.proposalByNumber(prompt.number).state, "pending");
  assert.deepEqual(hidden, [prompt.id]);
  sessions.observePrompt(sessions.get(session.id));
  await pause(600);
  assert.equal(sessions.store.value.proposals.filter((row) => row.sessionId === session.id && row.state === "pending").length, 1);
  // Focus leaves without an answer: the same card, with the same number, is shown and announced again.
  await sessions.attend(session.id, "viewer", false);
  assert.deepEqual(waiting(sessions, session.id, "prompt").map((row) => [row.id, row.number]), [[prompt.id, prompt.number]]);
  assert.deepEqual(announced, [prompt.id, prompt.id]);
  // Answering in the terminal ends it; the redrawn confirmation is a new question that starts hidden.
  await sessions.attend(session.id, "viewer", true);
  await sessions.userInput(session.id, "y\r", "viewer");
  assert.equal(sessions.proposalByNumber(prompt.number).state, "terminal");
  await until(async () => await content(join(directory, "shell-work", "count.txt")) === "x", "native answer");
  await until(() => sessions.store.value.proposals.some((row) => row.sessionId === session.id && row.kind === "prompt" && row.state === "pending" && row.quiet), "hidden confirmation");
  assert.equal(waiting(sessions, session.id).length, 0);
  await sessions.attend(session.id, "viewer", false);
  assert.equal(waiting(sessions, session.id, "prompt").length, 1);
});

test("a native request raised during terminal focus waits hidden, and its native menu is not a second card", async (t) => {
  const { sessions } = await fixture(t, { shell: { ...shell, hooks: true } });
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  const env = { LIVE_HOOK_SOCKET: sessions.hookSocket, LIVE_SESSION_ID: session.id };
  const payload = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push" } };
  const menu = () => sessions.write(session.id, "clear; printf 'Proceed? [y/N]'; read -r answer\r");
  await sessions.attend(session.id, "viewer", true);
  let settled = false;
  const hook = runHook(env, payload).finally(() => { settled = true; });
  await until(() => sessions.store.value.proposals.some((row) => row.sessionId === session.id && row.kind === "permission" && row.state === "pending"), "hidden hook proposal");
  await pause(300);
  assert.equal(settled, false, "the hook keeps waiting while the card is hidden");
  assert.equal(waiting(sessions, session.id).length, 0);
  await sessions.attend(session.id, "viewer", false);
  const [shown] = waiting(sessions, session.id, "permission");
  assert.ok(shown, "leaving the terminal shows the request");
  // "在终端处理": the hook abstains and the menu the harness then draws is that request, not a new confirmation.
  await sessions.decide(shown.id, false, randomUUID(), "terminal");
  assert.deepEqual(await hook, { code: 0, stdout: "" });
  await menu();
  await pause(800);
  assert.equal(sessions.store.value.proposals.filter((row) => row.sessionId === session.id && row.state === "pending").length, 0);
  // After Enter, the same text on screen is a new confirmation again.
  await sessions.userInput(session.id, "\r", "viewer");
  await menu();
  await until(() => waiting(sessions, session.id, "prompt").length, "new confirmation after Enter");
});

test("approved session creation delivers its initial task after startup output; takeover abandons it", async (t) => {
  const { sessions, directory } = await fixture(t, { shell: { argv: [
    "/bin/bash", "-c", "sleep .7; printf 'STARTUP_READY\\n'; exec /bin/bash --noprofile --norc -i",
  ] } });
  const proposal = await sessions.propose({ kind: "create", harness: "shell", data: "printf launched > launched.txt" });
  assert.equal(sessions.list().length, 0);
  await sessions.decide(proposal.id, true, randomUUID());
  const created = sessions.proposal(proposal.id).createdSessionId;
  await until(async () => await content(join(directory, "shell-work", "launched.txt")) === "launched", "initial task", 300);
  assert.ok(sessions.history(created).includes("STARTUP_READY"));
  const second = await sessions.propose({ kind: "create", harness: "shell", data: "touch unauthorized.txt" });
  await sessions.decide(second.id, true, randomUUID());
  await sessions.claim(sessions.proposal(second.id).createdSessionId, "user");
  await pause(2500);
  assert.equal(await content(join(directory, "shell-work", "unauthorized.txt")), null);
});

test("dead and missing supervised sessions recover honestly and clean their runtime files", async (t) => {
  const { sessions, directory } = await fixture(t);
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  const runtime = join(directory, "runtime", session.id);
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, "settings.json"), "{}");
  await until(() => sessions.history(session.id).includes("bash-"), "ready shell");
  await sessions.userInput(session.id, "exit 7\r", "exit-test");
  await until(() => sessions.get(session.id).state === "exited", "exit state");
  assert.equal(sessions.get(session.id).exitCode, 7);
  await assert.rejects(stat(runtime), { code: "ENOENT" });
  await sessions.tmux(["kill-session", "-t", session.id]);
  sessions.get(session.id).state = "running";
  sessions.store.save();
  await sessions.close();
  const recovered = new Sessions({ directory, workspace: directory, adapters: sessions.adapters });
  await recovered.initialize();
  try {
    assert.equal(recovered.get(session.id).state, "lost");
    assert.match((await recovered.snapshot(session.id)).data, /No work was replayed/);
  } finally { await recovered.close(); sessions.get(session.id).state = "lost"; }
});

test("version 1 state migrates, decided history is compacted into the event log and nothing is capped", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-migrate-test-"));
  t.after(() => rm(directory, { recursive: true }));
  await writeFile(join(directory, "sessions.json"), JSON.stringify({ version: 1, sessions: [], operations: [], audit: [{ kind: "old-entry" }] }));
  const sessions = new Sessions({ directory, workspace: directory, adapters: { shell } });
  await sessions.initialize();
  try {
    const session = await sessions.create({ harness: "shell" }, randomUUID());
    await pause(200);
    for (let i = 0; i < 230; i++) {
      const proposal = await sessions.propose({ kind: "input", sessionId: session.id, data: `echo ${i}\r` });
      await sessions.decide(proposal.id, false, randomUUID());
    }
    assert.ok(sessions.store.value.proposals.length <= 200);
    const log = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(log.some((entry) => entry.kind === "old-entry" && entry.migrated));
    assert.equal(log.filter((entry) => entry.kind === "user-rejected").length, 230);
    await sessions.terminate(session.id, randomUUID());
  } finally { await sessions.close(); }
});

test("standalone HTTP and real WebSocket enforce login, Origin, status codes, speech and reconnection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-http-test-"));
  const spoken = [];
  const app = await startAssistant({ directory, workspace: directory, password, speak: async (text) => { spoken.push(text); return { type: "audio/mpeg", data: Buffer.from("ID3fixture") }; } });
  t.after(async () => {
    for (const session of app.sessions.list()) if (session.state === "running") await app.sessions.terminate(session.id, randomUUID());
    await app.close(); await rm(directory, { recursive: true });
  });
  assert.equal((await fetch(`${app.origin}/api/state`)).status, 401);
  const post = (path, data, cookie, origin = app.origin) => fetch(`${app.origin}${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  const login = await post("/api/login", { password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await post("/api/sessions", { harness: "shell", operationId: randomUUID() }, cookie, "https://evil.example")).status, 403);
  assert.equal((await post("/api/sessions", { harness: "shell", operationId: "not-a-uuid" }, cookie)).status, 400);
  assert.equal((await post("/api/decision", { proposalId: randomUUID(), allowed: true, operationId: randomUUID() }, cookie)).status, 404);
  const speech = await post("/api/speech", { text: "第 1 号待确认" }, cookie);
  assert.equal(speech.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await speech.arrayBuffer()).toString(), "ID3fixture");
  assert.deepEqual(spoken, ["第 1 号待确认"]);
  const created = await (await post("/api/sessions", { harness: "shell", operationId: randomUUID() }, cookie)).json();
  const socket = new WebSocket(`${app.origin.replace("http:", "ws:")}/terminal`, { headers: { Origin: app.origin, Cookie: cookie } });
  const events = [];
  socket.on("message", (raw) => events.push(JSON.parse(raw)));
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "attach", sessionId: created.id }));
  await until(() => events.some((event) => event.type === "snapshot"), "snapshot");
  socket.send(JSON.stringify({ type: "input", data: "echo websocket_ok\r" }));
  await until(() => events.some((event) => event.type === "output" && event.data.includes("websocket_ok")), "websocket PTY");
  assert.ok(events.some((event) => event.type === "owner" && event.yours), "typing claims the keyboard");
  const proposal = await (await post("/api/propose", { sessionId: created.id, data: "echo proposed\r" }, cookie)).json();
  await until(() => events.some((event) => event.type === "state" && event.proposals.some((row) => row.id === proposal.id)), "proposal broadcast");
  assert.equal((await post("/api/decision", { proposalId: proposal.id, allowed: true, mode: "terminal", operationId: randomUUID() }, cookie)).status, 400);
  assert.equal((await post("/api/decision", { proposalId: proposal.id, allowed: true, operationId: randomUUID() }, cookie)).status, 200);
  assert.equal((await post("/api/decision", { proposalId: proposal.id, allowed: true, operationId: randomUUID() }, cookie)).status, 409);
  const approvals = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.kind === "user-approved");
  assert.deepEqual(approvals.map(({ proposalId, source }) => [proposalId, source]), [[proposal.id, "button"]]);
  socket.close(); await once(socket, "close");
  assert.equal(app.sessions.get(created.id).state, "running");
  assert.match((await app.sessions.snapshot(created.id)).data, /websocket_ok/);
  assert.equal((await fetch(`${app.origin}/vendor/xterm.js`)).status, 200);
  // Host stats reach a connected page; logout ends this login everywhere but leaves sessions running.
  const watcher = new WebSocket(`${app.origin.replace("http:", "ws:")}/terminal`, { headers: { Origin: app.origin, Cookie: cookie } });
  const watched = [];
  watcher.on("message", (raw) => watched.push(JSON.parse(raw)));
  await once(watcher, "open");
  await until(() => watched.some((event) => event.type === "stats"), "stats push");
  const stats = watched.find((event) => event.type === "stats");
  assert.ok(stats.cores > 0 && stats.memory.total > 0 && stats.memory.available <= stats.memory.total && stats.disk.available <= stats.disk.total);
  assert.ok(stats.tmux.pid > 0 && stats.tmux.panes.some((pane) => pane.sessionId === created.id && pane.pid > 0), JSON.stringify(stats.tmux));
  assert.equal((await post("/api/logout", {}, cookie, "https://evil.example")).status, 403);
  const closed = once(watcher, "close");
  const logout = await post("/api/logout", {}, cookie);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /^live_login=; .*Max-Age=0/);
  assert.equal((await closed)[0], 1008);
  assert.equal((await fetch(`${app.origin}/api/state`, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await post("/api/logout", {}, cookie)).status, 401);
  assert.equal(app.sessions.get(created.id).state, "running");
});

test("files upload into the session's current directory without overwriting and download from it within the roots", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-files-test-"));
  const app = await startAssistant({ directory, workspace: directory, password, uploadLimit: 1024 });
  t.after(async () => {
    try {
      for (const session of app.sessions.list()) if (session.state === "running") await app.sessions.terminate(session.id, randomUUID());
    } finally { await app.close(); await rm(directory, { recursive: true }); }
  });
  const login = await fetch(`${app.origin}/api/login`, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const session = await (await fetch(`${app.origin}/api/sessions`, { method: "POST", headers: { Origin: app.origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ harness: "shell", operationId: randomUUID() }) })).json();
  const told = [];
  const context = app.assistant.context.bind(app.assistant);
  app.assistant.context = (text, ...rest) => { told.push(text); return context(text, ...rest); };
  const upload = (name, body, { origin = app.origin, auth = cookie, sessionId = session.id, ...init } = {}) => fetch(`${app.origin}/api/upload?${new URLSearchParams({ sessionId, name })}`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/octet-stream", ...(auth ? { Cookie: auth } : {}) }, body, ...init,
  });
  const download = (path, query = "", headers = {}) => fetch(`${app.origin}/api/download?${new URLSearchParams({ sessionId: session.id, path })}${query}`, { headers: { Cookie: cookie, ...headers } });
  const work = join(directory, "shell-work");
  const leftovers = async (dir) => (await readdir(dir)).filter((name) => name.startsWith(".live-upload-"));

  const first = await upload("报告 one.txt", "first upload");
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { path: join(work, "报告 one.txt"), name: "报告 one.txt", bytes: 12, sessionId: session.id, sessionName: "shell" });
  assert.equal(await content(join(work, "报告 one.txt")), "first upload");
  await until(() => told.some((text) => text.includes(join(work, "报告 one.txt")) && text.includes("12 bytes")), "upload told to the assistant");
  // The same name is refused and the existing file is untouched.
  const again = await upload("报告 one.txt", "second");
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /already exists/);
  assert.equal(await content(join(work, "报告 one.txt")), "first upload");
  for (const name of ["../escape.txt", "sub/name.txt", "..", ""]) assert.equal((await upload(name, "x")).status, 400, name);
  assert.equal((await upload("evil.txt", "x", { origin: "https://evil.example" })).status, 403);
  assert.equal((await upload("anon.txt", "x", { auth: null })).status, 401);
  assert.equal((await upload("big.txt", "x".repeat(2000))).status, 413);
  // Without a length the limit applies while streaming, and the partial file is removed.
  const chunks = new ReadableStream({ start(controller) { for (let i = 0; i < 4; i++) controller.enqueue(new TextEncoder().encode("y".repeat(400))); controller.close(); } });
  assert.equal((await upload("streamed.txt", chunks, { duplex: "half" })).status, 413);
  assert.equal(await content(join(work, "streamed.txt")), null);
  assert.deepEqual(await leftovers(work), []);
  for (const name of ["anon.txt", "evil.txt", "big.txt"]) assert.equal(await content(join(work, name)), null);

  // A shell that changed directory uploads and downloads relative to where it is now.
  await app.sessions.userInput(session.id, "mkdir -p sub && cd sub\r", "test-client");
  await until(async () => (await app.sessions.currentDirectory(session.id)) === join(work, "sub"), "shell moved into sub");
  assert.equal((await upload("inner.txt", "inner")).status, 200);
  assert.equal(await content(join(work, "sub", "inner.txt")), "inner");
  assert.deepEqual(await (await download("inner.txt", "&check=1")).json(), { path: join(work, "sub", "inner.txt"), name: "inner.txt", size: 5 });
  const fetched = await download("../报告 one.txt");
  assert.equal(fetched.status, 200);
  assert.equal(await fetched.text(), "first upload");
  assert.equal(fetched.headers.get("content-disposition"), `attachment; filename="__ one.txt"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20one.txt`);
  assert.equal((await download("/etc/hostname")).status, 403);
  assert.equal((await download(".")).status, 400);
  assert.equal((await download("missing.txt")).status, 404);
  assert.equal((await download("inner.txt", "", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await fetch(`${app.origin}/api/download?${new URLSearchParams({ sessionId: session.id, path: "inner.txt" })}`)).status, 401);
});

test("two real browser transports: typing moves keyboard ownership and invalidates older proposals", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-two-client-test-"));
  const app = await startAssistant({ directory, workspace: directory, password });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    try {
      for (const session of app.sessions.list()) if (session.state === "running") await app.sessions.terminate(session.id, randomUUID());
    } finally { await app.close(); await rm(directory, { recursive: true }); }
  });
  const post = (path, data, cookie) => fetch(`${app.origin}${path}`, { method: "POST", headers: {
    Origin: app.origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}),
  }, body: JSON.stringify(data) });
  const login = await post("/api/login", { password });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const session = await (await post("/api/sessions", { harness: "shell", operationId: randomUUID() }, cookie)).json();
  const events = [[], []];
  for (let i = 0; i < 2; i++) {
    const socket = new WebSocket(`${app.origin.replace("http:", "ws:")}/terminal`, { headers: { Origin: app.origin, Cookie: cookie } });
    sockets.push(socket);
    socket.on("message", (data) => events[i].push(JSON.parse(data)));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "attach", sessionId: session.id }));
    await until(() => events[i].some((event) => event.type === "snapshot"), "client snapshot");
  }
  sockets[0].send(JSON.stringify({ type: "claim" }));
  await until(() => events[0].some((event) => event.type === "owner" && event.yours), "first owner");
  const request = await app.sessions.propose({ kind: "input", sessionId: session.id, data: "touch unauthorized.txt\r" });
  sockets[1].send(JSON.stringify({ type: "input", data: "printf valid > owner-proof.txt\r" }));
  await until(() => events[1].some((event) => event.type === "owner" && event.yours), "second owner by typing");
  await assert.rejects(app.sessions.decide(request.id, true, randomUUID()), /superseded/);
  sockets[0].send(JSON.stringify({ type: "resize", cols: 70, rows: 20 }));
  await until(() => events[0].some((event) => event.type === "error" && /owner/.test(event.error)), "former owner resize refused");
  sockets[1].send(JSON.stringify({ type: "resize", cols: 85, rows: 25 }));
  await until(async () => await content(join(directory, "shell-work", "owner-proof.txt")) === "valid", "new owner native input");
  await until(() => app.sessions.get(session.id).cols === 85, "owner resize");
  assert.equal(await content(join(directory, "shell-work", "unauthorized.txt")), null);
  // Giving the keyboard back tells every viewer; later assistant proposals are no longer invalidated by that page.
  const seen = events[0].length;
  sockets[1].send(JSON.stringify({ type: "release" }));
  await until(() => events[0].slice(seen).some((event) => event.type === "owner" && !event.yours && event.held === false), "release broadcast");
  assert.equal(app.sessions.ownerOf(session.id), null);
  const later = await app.sessions.propose({ kind: "input", sessionId: session.id, data: "printf later > later.txt\r" });
  sockets[1].send(JSON.stringify({ type: "input", data: "\x1b[<35;4;4M" }));
  await pause(200);
  assert.equal(app.sessions.proposal(later.id).state, "pending");
  for (const socket of sockets) socket.close();
  assert.equal(app.sessions.get(session.id).state, "running");
});

test("a typed request gets the running windows as context, and an incomplete input intent becomes a visible clarification", async (t) => {
  const { sessions, directory } = await fixture(t);
  const calls = [];
  let intent = { kind: "input", harness: "shell", sessionId: null, text: "printf secret-request > a.txt" };
  const assistant = new Assistant({ sessions, interpret: async (input) => { calls.push(input); return intent; } });
  t.after(() => assistant.close());
  const live = await sessions.create({ harness: "shell" }, randomUUID());
  const ended = await sessions.create({ harness: "shell" }, randomUUID());
  await sessions.terminate(ended.id, randomUUID());
  await sessions.label(live.id, { note: "build box" });
  const unclear = await assistant.request("在 build box 里写 a.txt");
  assert.deepEqual(calls[0].running, [{ id: live.id, name: sessions.get(live.id).name, note: "build box", harness: "shell" }]);
  assert.equal(calls[0].sessions.length, 2, "the full catalog is still supplied");
  assert.equal(waiting(sessions).length, 0);
  assert.match(unclear.clarification, /^Could not determine the target session for: printf secret-request/);
  assert.equal(assistant.error, null, "a clarification is an answer, not a lingering backend error");
  intent = { kind: "continue", harness: null, sessionId: live.id, text: "" };
  assert.match((await assistant.request("继续")).clarification, /Could not determine the exact input\./);
  // A typed request is interpreted against the session its page shows, not the shared focus another page set.
  assistant.focused = ended.id;
  await assistant.request("继续", null, live.id);
  assert.equal(calls.at(-1).focused, live.id);
  await assert.rejects(assistant.request("继续", null, randomUUID()), (error) => error.status === 404);
  assert.equal(calls.length, 3, "an unknown page session is refused before interpretation");
  const log = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.kind === "assistant-intent");
  assert.deepEqual(log.slice(0, 2).map(({ intent, targetId, textLength, typed }) => ({ intent, targetId, textLength, typed })),
    [{ intent: "input", targetId: null, textLength: 29, typed: true }, { intent: "continue", targetId: live.id, textLength: 0, typed: true }]);
  assert.ok(!JSON.stringify(log).includes("secret-request"), "the request text is not logged");
});

test("assistant interpretation only proposes; voice approves by number and refuses ambiguous or quoted decisions", async (t) => {
  const { sessions, directory } = await fixture(t);
  let intent = { kind: "new", harness: "shell", sessionId: null, text: "" };
  const assistant = new Assistant({ sessions, interpret: async () => intent });
  t.after(() => assistant.close());
  await assistant.request("create a shell");
  assert.equal(sessions.list().length, 0);
  const [create] = waiting(sessions);
  await assistant.onEvent({ kind: "transcript", utteranceId: 1, utterance: "他说确认操作" });
  await assistant.onEvent({ kind: "output-transcript", afterInput: true });
  assert.equal(sessions.list().length, 0);
  await assistant.onEvent({ kind: "transcript", utteranceId: 2, utterance: `批准 ${create.number}` });
  await assistant.onEvent({ kind: "output-transcript", afterInput: true });
  await until(() => sessions.list().length === 1 && sessions.list()[0].state === "running", "voice-approved creation");
  const session = sessions.list()[0];
  await pause(300);
  intent = { kind: "input", harness: null, sessionId: session.id, text: "printf a > a.txt" };
  await assistant.request("write a");
  intent = { ...intent, text: "printf b > b.txt" };
  await assistant.request("write b");
  const [a, b] = waiting(sessions, session.id);
  await assistant.onEvent({ kind: "transcript", utteranceId: 3, utterance: "批准" });
  // An unnumbered decision with several cards waiting is reported, not applied.
  await assistant.onEvent({ kind: "output-transcript", afterInput: true });
  assert.match(assistant.error, /number/);
  assert.deepEqual([a, b].map((row) => sessions.proposal(row.id).state), ["pending", "pending"]);
  await assistant.onEvent({ kind: "transcript", utteranceId: 4, utterance: `拒绝 ${a.number}` });
  await assistant.onEvent({ kind: "output-transcript", afterInput: true });
  await assistant.onEvent({ kind: "transcript", utteranceId: 5, utterance: "确认" });
  await assistant.onEvent({ kind: "output-transcript", afterInput: true });
  await until(async () => await content(join(directory, "shell-work", "b.txt")) === "b", "single remaining proposal approved");
  assert.equal(sessions.proposal(a.id).state, "rejected");
  assert.equal(sessions.proposal(b.id).state, "delivered");
  intent = { kind: "status", harness: null, sessionId: null, text: "" };
  await assistant.request("status");
  assert.equal(sessions.list().length, 1);
  const log = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(log.filter((row) => row.kind === "voice-decision-missed").map(({ reason, waiting }) => [reason, waiting]), [["ambiguous", 2]]);
  assert.deepEqual(log.filter((row) => /^user-(approved|rejected)$/.test(row.kind)).map((row) => row.source), ["voice", "voice", "voice"]);
});

test("interpretation does not hold the terminal: typing meanwhile flags the proposal instead of discarding it", async (t) => {
  const { sessions } = await fixture(t);
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(200);
  let release;
  const assistant = new Assistant({ sessions, interpret: () => new Promise((done) => { release = done; }) });
  t.after(() => assistant.close());
  const request = assistant.request("echo later");
  await until(() => release, "interpretation started");
  await sessions.userInput(session.id, "echo typed\r", "user");
  release({ kind: "input", harness: null, sessionId: session.id, text: "echo later" });
  await request;
  const [proposal] = waiting(sessions, session.id);
  assert.equal(proposal.changedDuringInterpretation, true);
  assert.equal(await sessions.decide(proposal.id, true, randomUUID()), "delivered");
});

test("modify and continue are exact authorized native inputs, not invisible process control", async (t) => {
  const { sessions, directory } = await fixture(t);
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(150);
  let intent = { kind: "modify", harness: null, sessionId: session.id, text: "printf modified > control.txt" };
  const assistant = new Assistant({ sessions, interpret: async () => intent });
  t.after(() => assistant.close());
  await assistant.request("modify with the explicit command");
  assert.equal(await content(join(directory, "shell-work", "control.txt")), null);
  await sessions.decide(waiting(sessions, session.id)[0].id, true, randomUUID());
  assert.equal(sessions.currentRun(sessions.get(session.id)).control, "modify");
  await until(async () => await content(join(directory, "shell-work", "control.txt")) === "modified", "actual modified task");
  intent = { ...intent, kind: "wait", text: "" };
  await assistant.request("wait for feedback");
  assert.equal(sessions.currentRun(sessions.get(session.id)).state, "waiting-for-feedback");
  intent = { ...intent, kind: "continue", text: "printf continued >> control.txt" };
  await assistant.request("continue using the explicit command");
  assert.equal(await content(join(directory, "shell-work", "control.txt")), "modified");
  await sessions.decide(waiting(sessions, session.id)[0].id, true, randomUUID());
  assert.equal(sessions.currentRun(sessions.get(session.id)).control, "continue");
  await until(async () => await content(join(directory, "shell-work", "control.txt")) === "modifiedcontinued", "actual continuation");
});

test("named keys and chords canonicalize, and chords a terminal cannot send distinctly are refused", () => {
  const steps = parseKeys([
    { type: "key", value: "esc" }, { type: "key", value: "ctrl+c" }, { type: "key", value: "Alt+x" }, { type: "key", value: "alt+shift+x" },
    { type: "key", value: "shift+tab" }, { type: "key", value: "Control+Shift+Left" }, { type: "key", value: "page down" }, { type: "key", value: " " },
    { type: "key", value: "Shift+a" }, { type: "key", value: "+" }, { type: "key", value: "Alt++" }, { type: "text", value: ":wq" },
  ]);
  assert.deepEqual(steps.map(({ type, value }) => type === "text" ? JSON.stringify(value) : value),
    ["Escape", "Ctrl+C", "Alt+X", "Alt+Shift+X", "Shift+Tab", "Ctrl+Shift+Left", "PageDown", "Space", '"A"', '"+"', "Alt++", '":wq"']);
  assert.deepEqual(parseKeys(steps), steps, "canonical steps are stable");
  assert.equal(describeKeys(steps.slice(0, 2)), "Escape → Ctrl+C");
  const encoded = (value) => { const { name, bytes } = encodeStep(parseKeys([{ type: "key", value }])[0]); return name ?? bytes.toString("hex"); };
  assert.deepEqual(["Ctrl+C", "Ctrl+[", "Ctrl+Space", "Ctrl+?", "Alt+x", "Alt+Shift+x", "Ctrl+Alt+x", "Alt+Space"].map(encoded), ["03", "1b", "00", "7f", "1b78", "1b58", "1b18", "1b20"]);
  assert.deepEqual(["Enter", "Alt+Enter", "Backspace", "Shift+Tab", "Alt+Shift+Tab", "Ctrl+Alt+Shift+Up", "Delete", "PgUp", "Shift+F5"].map(encoded),
    ["Enter", "M-Enter", "BSpace", "BTab", "M-BTab", "C-M-S-Up", "DC", "PPage", "S-F5"]);
  for (const [value, error] of [["Ctrl+Enter", /no distinct terminal encoding/], ["Shift+Enter", /no distinct/], ["Ctrl+Shift+C", /no distinct/], ["Shift+Escape", /no distinct/],
    ["Ctrl+Tab", /no distinct/], ["Ctrl+Backspace", /no distinct/], ["Ctrl+1", /no distinct/], ["Shift+1", /keyboard layout/], ["F13", /Unknown key/],
    ["Hyper+x", /Unknown modifier/], ["Ctrl+ctrl+x", /twice/], ["\x03", /control character/], ["", /key name/]]) {
    assert.throws(() => parseKeys([{ type: "key", value }]), (thrown) => thrown.status === 400 && error.test(thrown.message), value);
  }
  assert.throws(() => parseKeys([{ type: "text", value: "a\rb" }]), /control characters/);
  assert.throws(() => parseKeys(Array.from({ length: 51 }, () => ({ type: "key", value: "Down" }))), /At most 50/);
});

test("key proposals reach the PTY as the bytes a terminal sends, honour standing grants and yield to typing", async (t) => {
  // The recorder turns on application cursor keys, so tmux must encode the arrow for that mode.
  const recorder = { argv: [process.execPath, "-e", 'const fs=require("node:fs");process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on("data",d=>fs.appendFileSync("input.bin",d));process.stdout.write("\\x1b[?1h\\x1b=READY")'] };
  const { sessions, directory } = await fixture(t, { recorder });
  const session = await sessions.create({ harness: "recorder" }, randomUUID());
  await until(() => sessions.history(session.id).includes("READY"), "recorder ready");
  const file = join(directory, "recorder-work", "input.bin");
  const recorded = async () => (await readFile(file).catch(() => Buffer.alloc(0))).toString("hex");
  await assert.rejects(sessions.propose({ kind: "keys", sessionId: session.id, steps: [{ type: "key", value: "Ctrl+Enter" }] }), (error) => error.status === 400);
  await assert.rejects(sessions.propose({ kind: "keys", sessionId: session.id, steps: [] }), (error) => error.status === 400);
  const steps = ["Escape", ":wq", "Ctrl+C", "Alt+X", "Up", "Ctrl+Up", "Shift+Tab", "F5", "Ctrl+Space", "Alt+Enter", "Enter", "PageDown", "Ctrl+Alt+Delete", "é"]
    .map((value) => ({ type: [":wq", "é"].includes(value) ? "text" : "key", value }));
  const proposal = await sessions.propose({ kind: "keys", sessionId: session.id, steps });
  assert.equal(proposal.state, "pending");
  assert.equal(proposal.preview, 'Escape → ":wq" → Ctrl+C → Alt+X → Up → Ctrl+Up → Shift+Tab → F5 → Ctrl+Space → Alt+Enter → Enter → PageDown → Ctrl+Alt+Delete → "é"');
  assert.equal(await recorded(), "", "nothing is pressed before approval");
  const { inputEpoch } = sessions.get(session.id);
  assert.equal(await sessions.decide(proposal.id, true, randomUUID(), "always"), "delivered");
  const expected = "1b" + "3a7771" + "03" + "1b78" + "1b4f41" + "1b5b313b3541" + "1b5b5a" + "1b5b31357e" + "00" + "1b0d" + "0d" + "1b5b367e" + "1b5b333b377e" + "c3a9";
  await until(async () => await recorded() === expected, "every key in order");
  assert.equal(sessions.get(session.id).inputEpoch, inputEpoch + 1);
  assert.equal(sessions.get(session.id).currentRunId, null, "keys steer the task instead of starting a run");
  assert.equal(sessions.get(session.id).grants[0].kind, "keys");
  // The identical sequence, written differently, is delivered under the grant; another sequence waits.
  const again = await sessions.propose({ kind: "keys", sessionId: session.id, steps: steps.map((step) => ({ ...step, value: step.type === "key" ? step.value.toLowerCase() : step.value })) });
  assert.equal(again.state, "delivered");
  await until(async () => await recorded() === expected.repeat(2), "granted keys");
  const other = await sessions.propose({ kind: "keys", sessionId: session.id, steps: [{ type: "key", value: "Ctrl+C" }] });
  assert.equal(other.state, "pending");
  await sessions.userInput(session.id, "x", "user");
  assert.equal(sessions.proposal(other.id).state, "superseded");
  await until(async () => await recorded() === `${expected.repeat(2)}78`, "typed key");
});

test("assistant key requests become exact key proposals; unsendable chords and hidden control bytes are clarified", async (t) => {
  const { sessions, directory } = await fixture(t);
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(150);
  let intent;
  const assistant = new Assistant({ sessions, interpret: async () => intent });
  t.after(() => assistant.close());
  const keys = (sessionId, ...steps) => ({ kind: "keys", harness: null, sessionId, text: "", focus: false, steps });
  intent = keys(session.id, { type: "key", value: "esc" }, { type: "text", value: ":q" }, { type: "key", value: "enter" });
  await assistant.request("按 Esc，输入 :q 再按回车");
  const [proposal] = waiting(sessions, session.id);
  assert.equal(proposal.kind, "keys");
  assert.equal(proposal.preview, 'Escape → ":q" → Enter');
  assert.deepEqual(proposal.steps, [{ type: "key", value: "Escape" }, { type: "text", value: ":q" }, { type: "key", value: "Enter" }]);
  await sessions.decide(proposal.id, false, randomUUID());
  intent = keys(session.id, { type: "key", value: "Ctrl+Enter" });
  assert.match((await assistant.request("按 Ctrl 回车")).clarification, /^Ctrl\+Enter has no distinct terminal encoding and cannot be sent\. Name the session and the exact keys/);
  intent = keys(null, { type: "key", value: "Ctrl+C" });
  assert.match((await assistant.request("按 Ctrl C")).clarification, /^Could not determine the target session\./);
  intent = keys(session.id);
  assert.match((await assistant.request("退出 vim")).clarification, /^Could not determine the keys to press\./);
  intent = { kind: "input", harness: null, sessionId: session.id, text: "\x03" };
  assert.match((await assistant.request("中断它")).clarification, /invisible control characters/);
  assert.equal(waiting(sessions).length, 0);
  // Enter is appended on delivery, so a trailing newline from the interpreter does not submit twice.
  intent = { kind: "input", harness: null, sessionId: session.id, text: "printf once >> once.txt\n" };
  await assistant.request("写 once");
  const [typed] = waiting(sessions, session.id);
  assert.equal(typed.data, "printf once >> once.txt\r");
  await sessions.decide(typed.id, true, randomUUID());
  await until(async () => await content(join(directory, "shell-work", "once.txt")) === "once", "single submission");
  const log = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.kind === "assistant-intent");
  assert.deepEqual(log.map((row) => row.steps), [3, 1, 1, 0, 0, 0]);
  assert.ok(!JSON.stringify(log).includes(":q"), "key steps are not logged");
});

test("trusted voice wait revokes grants once per utterance without model interpretation", async (t) => {
  const { sessions, directory } = await fixture(t, { shell: { argv: ["/bin/bash", "-c", confirmLoop] } });
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  let calls = 0;
  const assistant = new Assistant({ sessions, interpret: async () => { calls++; throw new Error("Wait must not need interpretation"); } });
  t.after(() => assistant.close());
  assistant.focused = session.id;
  await until(() => waiting(sessions, session.id, "prompt").length, "native confirmation");
  await assistant.onEvent({ kind: "transcript", utteranceId: 1, utterance: "他说等待用户意见" });
  await sessions.decide(waiting(sessions, session.id, "prompt")[0].id, true, randomUUID(), "always");
  await assistant.onEvent({ kind: "transcript", utteranceId: 2, utterance: "等待用户意见。" });
  assert.equal(sessions.get(session.id).grants.length, 0);
  const count = await content(join(directory, "shell-work", "count.txt"));
  await pause(800);
  await assistant.onEvent({ kind: "transcript", utteranceId: 2, utterance: "等待用户意见。" });
  await assistant.onEvent({ kind: "delegation", delegationId: "same-wait", dialogue: "等待用户意见" });
  assert.equal(await content(join(directory, "shell-work", "count.txt")), count);
  assert.equal(sessions.get(session.id).state, "running");
  assert.equal(calls, 0);
});

test("assistant session creation preserves the user's existing terminal focus", async (t) => {
  const { sessions } = await fixture(t);
  const original = await sessions.create({ harness: "shell" }, randomUUID());
  const assistant = new Assistant({ sessions, interpret: async () => ({ kind: "new", harness: "shell", sessionId: null, text: "" }) });
  t.after(() => assistant.close());
  assistant.focused = original.id;
  await assistant.request("create another empty shell");
  const [proposal] = waiting(sessions);
  await sessions.decide(proposal.id, true, randomUUID());
  assert.equal(assistant.focused, original.id);
  const createdId = sessions.proposal(proposal.id).createdSessionId;
  assert.notEqual(createdId, original.id);
  assert.equal(sessions.get(createdId).state, "running");
});

test("voice can switch the page to a session, follow a target it is asked to show and close a tab", async (t) => {
  const { sessions } = await fixture(t);
  const contexts = [];
  const a = await sessions.create({ harness: "shell", name: "a" }, randomUUID());
  const b = await sessions.create({ harness: "shell", name: "b" }, randomUUID());
  let intent;
  const assistant = new Assistant({ sessions, live: fakeLive(contexts), interpret: async () => intent });
  t.after(() => assistant.close());
  assistant.focused = a.id;
  intent = { kind: "focus", harness: null, sessionId: b.id, text: "" };
  await assistant.request("切换到 b");
  assert.deepEqual([assistant.state().focused, assistant.state().focusRequest], [b.id, 1]);
  assert.equal(waiting(sessions).length, 0, "switching proposes nothing");
  // A request that also asks to show its target switches first; one that does not leaves the view alone.
  intent = { kind: "input", harness: null, sessionId: a.id, text: "echo shown", focus: true };
  await assistant.request("切到 a 并执行 echo shown");
  assert.deepEqual([assistant.state().focused, assistant.state().focusRequest], [a.id, 2]);
  intent = { kind: "input", harness: null, sessionId: b.id, text: "echo hidden", focus: false };
  await assistant.request("在 b 里执行 echo hidden");
  assert.equal(assistant.state().focused, a.id);
  intent = { kind: "new", harness: "shell", sessionId: null, text: "", focus: true };
  await assistant.request("新建 shell 并切过去");
  const create = waiting(sessions).find((row) => row.kind === "create");
  await sessions.decide(create.id, true, randomUUID());
  await until(() => assistant.state().focused === sessions.proposal(create.id).createdSessionId, "focus follows the created session");
  // Closing needs approval, works after termination, and removes the tab.
  await sessions.terminate(b.id, randomUUID());
  intent = { kind: "close", harness: null, sessionId: b.id, text: "" };
  await assistant.request("关闭 b 这个窗口");
  const close = waiting(sessions).find((row) => row.kind === "close");
  assert.equal(close.preview, "关闭 tab");
  assert.ok(sessions.list().some((session) => session.id === b.id), "nothing closes before approval");
  await sessions.decide(close.id, true, randomUUID());
  assert.ok(!sessions.list().some((session) => session.id === b.id));
  intent = { kind: "close", harness: null, sessionId: a.id, text: "" };
  await assistant.request("关闭 a");
  const running = waiting(sessions).find((row) => row.kind === "close");
  assert.equal(running.preview, "终止进程并关闭 tab");
  await sessions.decide(running.id, true, randomUUID());
  assert.equal(sessions.get(a.id).state, "terminated");
  assert.ok(!sessions.list().some((session) => session.id === a.id));
});

test("tab color and note are validated presentation fields that are saved immediately", async (t) => {
  const { sessions, directory } = await fixture(t);
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  const revision = sessions.get(session.id).revision;
  await sessions.label(session.id, { color: "teal" });
  await sessions.label(session.id, { note: "  前端联调  " });
  assert.deepEqual([sessions.get(session.id).color, sessions.get(session.id).note], ["teal", "前端联调"]);
  assert.equal(sessions.get(session.id).revision, revision, "labels never change the authorization epoch");
  await assert.rejects(sessions.label(session.id, { color: "pink" }), z.ZodError);
  await assert.rejects(sessions.label(session.id, { note: "x".repeat(41) }), z.ZodError);
  await sessions.label(session.id, { color: null, note: "" });
  assert.deepEqual([sessions.get(session.id).color, sessions.get(session.id).note], [null, null]);
  await sessions.label(session.id, { color: "red", note: "保留" });
  const saved = JSON.parse(await readFile(join(directory, "sessions.json"), "utf8")).sessions.find((entry) => entry.id === session.id);
  assert.deepEqual([saved.color, saved.note], ["red", "保留"]);
});

test("an unclaimed terminal follows the viewing page's size; a held keyboard keeps its owner's size", async (t) => {
  const { sessions } = await fixture(t);
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  const size = async () => (await sessions.tmux(["display-message", "-p", "-t", session.id, "#{pane_width}|#{pane_height}"])).trim();
  await sessions.resize(session.id, 132, 40, "viewer");
  assert.equal(await size(), "132|40");
  await sessions.claim(session.id, "owner");
  await assert.rejects(sessions.resize(session.id, 80, 24, "viewer"), /owner/);
  await sessions.resize(session.id, 120, 36, "owner");
  await sessions.releaseSession(session.id, "owner");
  await sessions.resize(session.id, 140, 42, "viewer");
  assert.equal(await size(), "140|42");
  await sessions.terminate(session.id, randomUUID());
  await assert.rejects(sessions.resize(session.id, 80, 24, "viewer"), /Cannot resize a terminated terminal/);
});

test("proposal numbers cycle through 1-99 and skip numbers that are still waiting", async (t) => {
  const { sessions } = await fixture(t);
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  const first = await sessions.propose({ kind: "input", sessionId: session.id, data: "echo keep\r" });
  assert.equal(first.number, 1);
  for (let i = 2; i <= 99; i++) {
    const proposal = await sessions.propose({ kind: "input", sessionId: session.id, data: `echo ${i}\r` });
    assert.equal(proposal.number, i);
    await sessions.decide(proposal.id, false, randomUUID());
  }
  // 1 is still waiting, so the cycle continues at 2; a number names the latest proposal that used it.
  const wrapped = await sessions.propose({ kind: "input", sessionId: session.id, data: "echo wrapped\r" });
  assert.equal(wrapped.number, 2);
  assert.equal(sessions.proposal(2).id, wrapped.id);
  assert.equal(sessions.proposalByNumber(2).id, wrapped.id);
  assert.equal(sessions.proposal(1).id, first.id);
});

test("a failed voice delegation is logged with a redacted reason and creates no proposal", async (t) => {
  const { sessions, directory } = await fixture(t);
  let emit;
  const contexts = [];
  const live = { ...fakeLive(contexts), subscribe: (listener) => { emit = listener; return () => {}; } };
  const assistant = new Assistant({ sessions, live, interpret: async () => { throw new Error("Intent model HTTP 500; api_key=synthetic-sensitive-value"); } });
  t.after(() => assistant.close());
  await emit({ kind: "delegation", delegationId: "dsh-create", dialogue: "新建一个 dsh session" });
  assert.match(assistant.state().error, /Intent model HTTP 500/);
  // The delegation is still answered so the voice model can continue instead of waiting.
  assert.equal(contexts.at(-1).delegationId, "dsh-create");
  assert.match(contexts.at(-1).text, /failed and nothing was sent/);
  assert.ok(!contexts.at(-1).text.includes("synthetic-sensitive-value"));
  assert.equal(waiting(sessions).length, 0);
  const log = await readFile(join(directory, "events.jsonl"), "utf8");
  const entry = log.trim().split("\n").map((line) => JSON.parse(line)).find((row) => row.kind === "assistant-error");
  assert.match(entry.error, /Intent model HTTP 500/);
  assert.ok(!log.includes("synthetic-sensitive-value"));
});

test("a spoken decision for a superseded proposal reports why instead of failing the voice turn", async (t) => {
  const { sessions, directory } = await fixture(t);
  const contexts = [];
  const assistant = new Assistant({ sessions, live: fakeLive(contexts) });
  t.after(() => assistant.close());
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(200);
  const proposal = await sessions.propose({ kind: "input", sessionId: session.id, data: "echo late\r" });
  await sessions.userInput(session.id, "echo mine\r", "user");
  await assistant.onEvent({ kind: "transcript", utteranceId: 1, utterance: `批准 ${proposal.number}` });
  await assistant.onEvent({ kind: "delegation", delegationId: "late-decision", dialogue: `批准 ${proposal.number}` });
  assert.equal(sessions.proposal(proposal.id).state, "superseded");
  assert.equal(contexts.at(-1).delegationId, "late-decision");
  assert.match(contexts.at(-1).text, new RegExp(`Proposal ${proposal.number}\\. is superseded \\(The user took over the terminal\\).*NOT applied`));
  assert.match(assistant.state().error, /superseded/);
  await assistant.onEvent({ kind: "transcript", utteranceId: 2, utterance: "批准 999" });
  await assistant.onEvent({ kind: "output-transcript", afterInput: true });
  assert.match(contexts.at(-1).text, /Proposal 999\. does not exist/);
  const log = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(log.filter((row) => row.kind === "voice-decision-missed").map(({ number, reason, proposalId }) => [number, reason, proposalId]),
    [[proposal.number, "superseded", proposal.id], [999, "missing", null]]);
});

test("voice delegations are answered once and logged, and the caller's words stay in a private local transcript", async (t) => {
  const { sessions, directory } = await fixture(t);
  const contexts = [];
  let calls = 0;
  const assistant = new Assistant({ sessions, live: fakeLive(contexts), interpret: async () => { calls++; return { kind: "clarify", harness: null, sessionId: null, text: "Which session?" }; } });
  t.after(() => assistant.close());
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(200);
  const proposal = await sessions.propose({ kind: "input", sessionId: session.id, data: "printf voice > voice.txt\r" });
  const live = { sessionId: "synthetic-live" };
  await assistant.onEvent({ ...live, kind: "transcript", utteranceId: 7, text: `批准 ${proposal.number}`, utterance: `批准 ${proposal.number}`, startMs: 100, endMs: 900 });
  await assistant.onEvent({ ...live, kind: "output-transcript", text: "好的", afterInput: true, startMs: 950, endMs: 1200 });
  await until(async () => await content(join(directory, "shell-work", "voice.txt")) === "voice", "spoken approval");
  // The voice model also delegates the same words: it gets an answer, and nothing is decided or interpreted again.
  await assistant.onEvent({ ...live, kind: "delegation", delegationId: "same-words", utteranceId: 7, text: `批准 ${proposal.number}`, dialogue: "[]" });
  assert.equal(contexts.at(-1).delegationId, "same-words");
  assert.match(contexts.at(-1).text, /already handled these exact words/);
  await assistant.onEvent({ ...live, kind: "delegation", delegationId: "same-words", utteranceId: 7, text: "", dialogue: "[]" });
  assert.equal(contexts.filter((context) => context.delegationId === "same-words").length, 1);
  // More words in the same utterance are a new request, not swallowed by the shortcut that handled the first ones.
  await assistant.onEvent({ ...live, kind: "transcript", utteranceId: 7, text: " 然后 api_key=synthetic-sensitive-value", utterance: `批准 ${proposal.number} 然后 api_key=synthetic-sensitive-value` });
  await assistant.onEvent({ ...live, kind: "delegation", delegationId: "more-words", utteranceId: 7, text: "然后", dialogue: "[]" });
  assert.equal(calls, 1);
  assert.equal(contexts.at(-1).delegationId, "more-words");
  assert.match(contexts.at(-1).text, /Clarification required: Which session/);
  assert.equal(sessions.proposal(proposal.id).state, "delivered");
  const log = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(log.filter((row) => row.kind === "delegation-received").map(({ delegationId, utteranceId, textLength }) => [delegationId, utteranceId, textLength]),
    [["same-words", 7, `批准 ${proposal.number}`.length], ["more-words", 7, 2]]);
  assert.deepEqual(log.filter((row) => row.kind === "delegation-dropped").map(({ delegationId, reason }) => [delegationId, reason]),
    [["same-words", "handled-utterance"], ["same-words", "seen"]]);
  assert.deepEqual(log.filter((row) => row.kind === "user-approved").map(({ proposalId, source }) => [proposalId, source]), [[proposal.id, "voice"]]);
  const intent = log.find((row) => row.kind === "assistant-intent");
  assert.equal(intent.delegationId, "more-words");
  assert.ok(Number.isInteger(intent.latencyMs) && intent.latencyMs >= 0);
  assert.ok(!JSON.stringify(log).includes("然后"), "the caller's words are not in the event log");
  const file = join(directory, "live-transcript.jsonl");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const transcript = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(transcript.map(({ kind, utteranceId, text, startMs, afterInput }) => [kind, utteranceId, text ?? null, startMs ?? null, afterInput ?? null]), [
    ["transcript", 7, `批准 ${proposal.number}`, 100, null], ["output-transcript", null, "好的", 950, true],
    ["delegation", 7, null, null, null], ["delegation", 7, null, null, null],
    ["transcript", 7, transcript[4].text, null, null], ["delegation", 7, null, null, null],
  ]);
  assert.match(transcript[4].text, /^ 然后 /);
  assert.ok(transcript.every((row) => row.liveSessionId === "synthetic-live"));
  assert.ok(!JSON.stringify(transcript).includes("synthetic-sensitive-value"), "the transcript is redacted");
});

test("a spoken decision or status that cannot apply is answered once and logged instead of thrown", async (t) => {
  const { sessions, directory } = await fixture(t);
  const contexts = [];
  const assistant = new Assistant({ sessions, live: fakeLive(contexts) });
  t.after(() => assistant.close());
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(200);
  const proposal = await sessions.propose({ kind: "input", sessionId: session.id, data: "echo x\r" });
  sessions.decide = async () => { throw new Error("Simulated delivery failure"); };
  await assistant.onEvent({ kind: "transcript", utteranceId: 1, utterance: `批准 ${proposal.number}` });
  await assistant.onEvent({ kind: "delegation", delegationId: "failing", utteranceId: 1, text: `批准 ${proposal.number}` });
  delete sessions.decide;
  assert.deepEqual(contexts.filter((context) => context.delegationId === "failing").length, 1);
  assert.match(contexts.at(-1).text, new RegExp(`proposal ${proposal.number}\\. failed: Simulated delivery failure.*do not claim it ran`));
  assert.match(assistant.state().error, /Simulated delivery failure/);
  // A status request with no session shown still answers its delegation.
  await assistant.onEvent({ kind: "transcript", utteranceId: 2, utterance: "任务状态" });
  await assistant.onEvent({ kind: "delegation", delegationId: "status", utteranceId: 2, text: "任务状态" });
  assert.equal(contexts.at(-1).delegationId, "status");
  assert.match(contexts.at(-1).text, /No terminal output can be observed/);
  await assistant.onEvent({ kind: "error", code: "rate_limit_exceeded", command: "session.commentary.append" });
  assert.equal(assistant.state().error, "Live: rate_limit_exceeded");
  const log = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(log.filter((row) => row.kind === "voice-decision-missed").map(({ reason, proposalId }) => [reason, proposalId]), [["decide-failed", proposal.id]]);
  assert.deepEqual(log.filter((row) => row.kind === "live-error").map(({ code, command }) => [code, command]), [["rate_limit_exceeded", "session.commentary.append"]]);
  assert.equal(sessions.proposal(proposal.id).state, "pending");
});

test("a bounded event log rolls over to one previous file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-event-log-"));
  t.after(() => rm(directory, { recursive: true }));
  const file = join(directory, "log.jsonl");
  const log = new EventLog(file, { limit: 200 });
  for (let i = 0; i < 6; i++) log.append({ kind: "entry", i, padding: "x".repeat(40) });
  const rows = async (path) => (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line).i);
  const [current, previous] = [await rows(file), await rows(`${file}.1`)];
  assert.deepEqual([...previous, ...current], [0, 1, 2, 3, 4, 5].slice(-(previous.length + current.length)));
  assert.ok((await stat(file)).size <= 200);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // A reopened log continues from the size already on disk.
  new EventLog(file, { limit: 200 }).append({ kind: "entry", i: 6, padding: "x".repeat(40) });
  assert.ok((await stat(file)).size <= 200);
});

test("a spoken number decides the proposal it named when speech began, not one that reused the number", async (t) => {
  const { sessions, directory } = await fixture(t);
  const contexts = [];
  const assistant = new Assistant({ sessions, live: fakeLive(contexts) });
  t.after(() => assistant.close());
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(200);
  const old = await sessions.propose({ kind: "input", sessionId: session.id, data: "printf old > old.txt\r" });
  await assistant.onEvent({ kind: "transcript", utteranceId: 1, utterance: "批准" });
  await sessions.decide(old.id, false, randomUUID());
  // The cycle wraps back to the same number while the user is still speaking.
  sessions.store.value.nextNumber = old.number;
  const reused = await sessions.propose({ kind: "input", sessionId: session.id, data: "printf new > new.txt\r" });
  assert.equal(reused.number, old.number);
  await assistant.onEvent({ kind: "transcript", utteranceId: 1, utterance: `批准 ${old.number}` });
  await assistant.onEvent({ kind: "output-transcript", afterInput: true });
  assert.equal(sessions.proposal(reused.id).state, "pending");
  assert.match(contexts.at(-1).text, new RegExp(`Proposal ${old.number}\\. is rejected.*NOT applied`));
  // A card that appears mid-utterance is not decided by it either.
  const late = await sessions.propose({ kind: "input", sessionId: session.id, data: "printf late > late.txt\r" });
  await assistant.onEvent({ kind: "transcript", utteranceId: 2, utterance: "嗯" });
  const after = await sessions.propose({ kind: "input", sessionId: session.id, data: "printf after > after.txt\r" });
  await assistant.onEvent({ kind: "transcript", utteranceId: 2, utterance: `批准 ${after.number}` });
  await assistant.onEvent({ kind: "output-transcript", afterInput: true });
  assert.equal(sessions.proposal(after.id).state, "pending");
  assert.match(contexts.at(-1).text, /appeared after the user started speaking.*NOT applied/);
  await assistant.onEvent({ kind: "transcript", utteranceId: 3, utterance: `批准 ${late.number}` });
  await assistant.onEvent({ kind: "output-transcript", afterInput: true });
  await until(async () => await content(join(directory, "shell-work", "late.txt")) === "late", "decision bound at utterance start");
  assert.equal(await content(join(directory, "shell-work", "new.txt")), null);
});

test("progress reaches every background session, sends only new condensed lines and redacts secrets", async (t) => {
  const { sessions } = await fixture(t, { shell: { argv: [
    process.execPath, "-e", 'setTimeout(()=>process.stdout.write("BACKGROUND_UPDATE api_key=synthetic-sensitive-value\\n"),800);setInterval(()=>process.stdout.write("\\r⠋ waiting"),200);',
  ] } });
  const contexts = [];
  const assistant = new Assistant({ sessions, live: fakeLive(contexts) });
  t.after(() => assistant.close());
  const created = [];
  for (let i = 0; i < 5; i++) created.push(await sessions.create({ harness: "shell" }, randomUUID()));
  const progress = () => contexts.filter((context) => context.text.startsWith("New terminal lines"));
  const observed = () => new Set(progress().map((context) => JSON.parse(context.text.slice(context.text.indexOf("{"))).sessionId));
  await until(() => observed().size === 5, "all sessions observed", 400);
  assert.deepEqual([...observed()].sort(), created.map((session) => session.id).sort());
  assert.ok(contexts.every((context) => !context.text.includes("synthetic-sensitive-value")));
  const sent = progress().length;
  await pause(4000);
  assert.equal(progress().length, sent, "spinner repaints produced repeated progress");
  assert.match(sessions.history(created[0].id), /synthetic-sensitive-value/);
});

test("secrets are redacted on whole logical lines before soft-wrapped rows or long lines are cut", async (t) => {
  const { sessions } = await fixture(t);
  const contexts = [];
  const assistant = new Assistant({ sessions, live: fakeLive(contexts) });
  t.after(() => assistant.close());
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await sessions.resize(session.id, 40, 20, "user");
  await until(() => sessions.history(session.id).includes("bash-"), "ready shell");
  // The value of the first secret starts near the end of a 40-column row and continues on the next one.
  await sessions.userInput(session.id, "clear; printf '%030d api_key=synthetic-wrapped-secret-value\\n' 0\r", "user");
  await until(() => sessions.screen(session.id).includes("0 api_key=synthetic-wrapped-secret-value"), "wrapped line rejoined");
  assert.match(sessions.screen(session.id), /^0{30} api_key=synthetic-wrapped-secret-value$/m);
  assert.doesNotMatch(JSON.stringify(assistant.summary(sessions.list()[0])), /secret-value|wrapped-s|synthetic/);
  // The second is longer than the observation window, so cutting first would keep its value without the key name.
  await sessions.userInput(session.id, "clear; printf 'api_key=synthetic%0800dSECRETTAIL\\n' 0\r", "user");
  await until(() => sessions.history(session.id).includes("SECRETTAIL\n") || sessions.history(session.id).endsWith("SECRETTAIL"), "long line printed");
  await assistant.observe(session.id);
  assert.match(contexts.at(-1).text, /api_key=\[REDACTED\]/);
  assert.doesNotMatch(contexts.at(-1).text, /SECRETTAIL|secret-value/);
});

test("readonly status observes a busy native session without changing its authorization epoch", async (t) => {
  const { sessions } = await fixture(t, { shell: { argv: [process.execPath, "-e", 'setInterval(()=>process.stdout.write("BUSY_UPDATE\\n"),50);'] } });
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  const contexts = [];
  const assistant = new Assistant({ sessions, live: fakeLive(contexts), interpret: async () => {
    await pause(300);
    return { kind: "status", sessionId: session.id, harness: null, text: "" };
  } });
  t.after(() => assistant.close());
  const revision = sessions.get(session.id).revision;
  await assistant.request("show the current busy session status");
  assert.equal(sessions.get(session.id).revision, revision);
  assert.equal(waiting(sessions).length, 0);
  assert.ok(contexts.some((context) => context.text.includes("BUSY_UPDATE")));
});

test("independent verifiers bind to a managed run, keep an output tail, time out, cancel and never replay", async (t) => {
  const { sessions, directory } = await fixture(t, { shell }, { verifyTimeout: 1500 });
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(150);
  const first = await sessions.propose({ kind: "input", sessionId: session.id, data: "printf first > first.txt\r" });
  await sessions.decide(first.id, true, randomUUID());
  const firstRun = sessions.get(session.id).currentRunId;
  await writeFile(join(directory, "shell-work", "verify-first.mjs"), 'import {readFileSync,appendFileSync} from "node:fs";import assert from "node:assert/strict";appendFileSync("verify-count.txt","x");await new Promise(r=>setTimeout(r,400));assert.equal(readFileSync("first.txt","utf8"),"first");');
  const node = JSON.stringify(process.execPath);
  const command = `${node} verify-first.mjs`;
  const op = randomUUID();
  const execution = await sessions.startVerification(session.id, firstRun, command, op);
  const second = await sessions.propose({ kind: "input", sessionId: session.id, data: "printf second > second.txt\r", control: "modify" });
  await sessions.decide(second.id, true, randomUUID());
  const secondRun = sessions.get(session.id).currentRunId;
  const result = await execution.completion;
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "stale");
  const duplicate = await sessions.startVerification(session.id, firstRun, command, op);
  assert.deepEqual(await duplicate.completion, result);
  assert.equal(await readFile(join(directory, "shell-work", "verify-count.txt"), "utf8"), "x");
  await assert.rejects(sessions.startVerification(session.id, firstRun, command, randomUUID()), /stale/);
  await writeFile(join(directory, "shell-work", "verify-second.mjs"), 'import {readFileSync} from "node:fs";import assert from "node:assert/strict";process.stdout.write("y".repeat(300000));process.stdout.write("TAIL_MARK");assert.equal(readFileSync("second.txt","utf8"),"second");');
  const accepted = await sessions.startVerification(session.id, secondRun, `${node} verify-second.mjs`, randomUUID());
  const passed = await accepted.completion;
  assert.equal(passed.state, "passed");
  assert.match(passed.output, /TAIL_MARK$/);
  assert.equal(sessions.currentRun(sessions.get(session.id)).state, "verification-passed");
  const slow = await sessions.startVerification(session.id, secondRun, "sleep 30", randomUUID());
  const timedOut = await slow.completion;
  assert.equal(timedOut.state, "unknown");
  assert.match(timedOut.reason, /timed out/);
  const cancelOp = randomUUID();
  const cancelled = await sessions.startVerification(session.id, secondRun, "sleep 30", cancelOp);
  await pause(100);
  await sessions.cancelVerification(cancelOp);
  assert.match((await cancelled.completion).reason, /Cancelled/);
  assert.equal(sessions.get(session.id).state, "running");
});

test("terminal output has process provenance and increasing sequence", async (t) => {
  const { sessions } = await fixture(t);
  const output = [];
  sessions.on("output", (event) => output.push(event));
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(150);
  const request = await sessions.propose({ kind: "input", sessionId: session.id, data: "echo SCOPED_OUTPUT\r" });
  await sessions.decide(request.id, true, randomUUID());
  await until(() => output.some((event) => event.data.includes("SCOPED_OUTPUT")), "actual scoped output");
  for (const event of output) {
    assert.equal(event.processRunId, sessions.get(session.id).processRunId);
    assert.ok(event.observationId);
  }
  assert.ok(output.every((event, index) => index === 0 || event.sequence > output[index - 1].sequence));
});

test("instant native startup output is captured exactly once and observers never resize the PTY", async (t) => {
  const { sessions } = await fixture(t, { shell: { argv: [
    process.execPath, "-e", 'process.stdout.write("FAST_START\\nNEXT_LINE\\n");setInterval(()=>{},1000);',
  ] } });
  for (let i = 0; i < 3; i++) {
    const session = await sessions.create({ harness: "shell", cols: 110, rows: 35 }, randomUUID());
    await until(() => sessions.history(session.id).includes("NEXT_LINE"), "instant startup capture");
    assert.equal(sessions.history(session.id).match(/FAST_START/g)?.length, 1);
    assert.equal(sessions.history(session.id).match(/NEXT_LINE/g)?.length, 1);
    assert.equal((await sessions.tmux(["display-message", "-p", "-t", session.id, "#{pane_width}|#{pane_height}"])).trim(), "110|35");
  }
});

test("high-volume terminal output has bounded snapshots and never terminates the underlying process", async (t) => {
  const { sessions } = await fixture(t, { shell: { argv: [process.execPath, "-e", 'setTimeout(()=>process.stdout.write("x".repeat(2000000)+"\\nOUTPUT_DONE\\n"),200);setTimeout(()=>{},60000)'] } });
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await pause(1200);
  const snapshot = await sessions.snapshot(session.id);
  assert.ok(snapshot.data.length < 1024 * 1024);
  assert.equal(sessions.get(session.id).state, "running");
  assert.match(snapshot.data, /OUTPUT_DONE/);
});

test("speech uses the Foundry v1 route with an Entra bearer token and redacts failures", async () => {
  const calls = [];
  const credential = { getToken: async (scope) => { assert.equal(scope, "https://cognitiveservices.azure.com/.default"); return { token: "synthetic-token" }; } };
  const speak = createSpeech({ endpoint: "https://fixture.openai.azure.com/", deployment: "tts-fixture", credential, fetch: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(Buffer.from("ID3"), { headers: { "Content-Type": "audio/mpeg" } })
      : new Response("bad api_key=synthetic-secret", { status: 400 });
  } });
  const audio = await speak("你好");
  assert.equal(audio.type, "audio/mpeg");
  assert.equal(audio.data.toString(), "ID3");
  assert.equal(calls[0].url, "https://fixture.openai.azure.com/openai/v1/audio/speech");
  assert.equal(calls[0].options.headers.Authorization, "Bearer synthetic-token");
  assert.equal(JSON.parse(calls[0].options.body).model, "tts-fixture");
  assert.equal(JSON.parse(calls[0].options.body).voice, "alloy");
  await assert.rejects(speak("again"), (error) => /HTTP 400/.test(error.message) && !error.message.includes("synthetic-secret"));
  assert.throws(() => createSpeech({ endpoint: "https://evil.example/", credential }), /authorized Foundry/);
  const voiced = createSpeech({ endpoint: "https://fixture.openai.azure.com/", voice: "coral", credential, fetch: async (_url, options) => {
    calls.push({ options });
    return new Response(Buffer.from("ID3"), { headers: { "Content-Type": "audio/mpeg" } });
  } });
  await voiced("你好");
  assert.equal(JSON.parse(calls.at(-1).options.body).voice, "coral");
  await voiced("你好", { voice: "sage" });
  assert.equal(JSON.parse(calls.at(-1).options.body).voice, "sage");
});

test("intent interpreter defaults to gpt-6.1-sol with low effort and accepts only GPT deployments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-assistant-test-"));
  t.after(() => rm(directory, { recursive: true }));
  const bodies = [];
  const credential = { getToken: async () => ({ token: "synthetic-token" }) };
  const fetch = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    const intent = { kind: "status", harness: null, sessionId: null, text: "", focus: false };
    return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(intent) }] }], usage: { total_tokens: 10 } });
  };
  const request = { dialogue: "进展如何", sessions: [], proposals: [], focused: null };
  const endpoint = "https://fixture.openai.azure.com/";
  await createInterpreter({ endpoint, directory, credential, fetch })(request);
  await createInterpreter({ endpoint, directory, credential, fetch, deployment: "gpt-6-luna", effort: "none" })(request);
  assert.equal(bodies[0].model, "gpt-6.1-sol");
  assert.deepEqual(bodies[0].reasoning, { effort: "low" });
  assert.deepEqual(bodies[0].text.format.schema.required, ["kind", "harness", "sessionId", "text", "focus", "steps"]);
  assert.equal(bodies[1].model, "gpt-6-luna");
  assert.deepEqual(bodies[1].reasoning, { effort: "none" });
  for (const deployment of ["FW-DeepSeek-V4.1-Flash", "", "gpt-6 luna"]) {
    assert.throws(() => createInterpreter({ endpoint, directory, credential, fetch, deployment }), /FOUNDRY_INTENT_DEPLOYMENT/);
  }
  assert.throws(() => createInterpreter({ endpoint, directory, credential, fetch, effort: "fast" }), /FOUNDRY_INTENT_EFFORT/);
});


test("harness environment keeps the shell environment but drops the login password and what npm run injected", () => {
  const plain = { PATH: "/a/node_modules/.bin:/usr/bin", HOME: "/home/x", EDITOR: "vi" };
  assert.deepEqual(harnessEnvironment(plain), plain);
  assert.deepEqual(harnessEnvironment({ ...plain, LIVE_ASSISTANT_PASSWORD: password }), plain);
  const npm = harnessEnvironment({
    PATH: ["/repo/node_modules/.bin", "/node_modules/.bin", "/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin", "/home/x/.nvm/bin", "/repo/node_modules/.bin"].join(":"),
    HOME: "/home/x", EDITOR: "vi", npm_lifecycle_event: "assistant", npm_config_prefix: "/p", INIT_CWD: "/repo", NODE: "/n", COLOR: "1", AZURE_SUBSCRIPTION_NAME: "fixture", LIVE_ASSISTANT_PASSWORD: password,
  });
  assert.deepEqual(npm, { PATH: "/home/x/.nvm/bin:/repo/node_modules/.bin", HOME: "/home/x", EDITOR: "vi", AZURE_SUBSCRIPTION_NAME: "fixture" });
  assert.equal(findExecutable("bash", "/nonexistent:/bin:/usr/bin")?.endsWith("/bash"), true);
  assert.equal(findExecutable("definitely-missing-harness", "/bin:/usr/bin"), null);
  assert.equal(findExecutable("/bin/sh"), "/bin/sh");
});

test("default adapters start the installed CLIs and only add a DSH token when configured", async () => {
  const plain = defaultAdapters({ hooks: false });
  assert.deepEqual(Object.fromEntries(Object.entries(plain).map(([name, adapter]) => [name, adapter.argv])), {
    shell: ["/bin/bash", "-i"], claude: ["claude"], codex: ["codex"], copilot: ["copilot"], dsh: ["dsh", "--profile", "dsh-tui"],
  });
  assert.deepEqual(Object.entries(plain).filter(([, adapter]) => adapter.rc).map(([name]) => name), ["claude", "codex", "copilot", "dsh"]);
  assert.equal(plain.dsh.env, undefined);
  const scopes = [];
  const withToken = defaultAdapters({ hooks: true, dshToken: true, dshProfile: "fixture", credential: { getToken: async (scope) => { scopes.push(scope); return { token: "synthetic-token" }; } } });
  assert.deepEqual(withToken.dsh.argv, ["dsh", "--profile", "fixture"]);
  assert.deepEqual(await withToken.dsh.env(), { FOUNDRY_TOKEN: "synthetic-token" });
  assert.deepEqual(scopes, ["https://cognitiveservices.azure.com/.default"]);
  assert.ok(!withToken.claude.argv.join(" ").includes("synthetic"));
  assert.equal(withToken.claude.argv[1], "--settings");
  assert.equal(withToken.codex.argv[1], "-c");
});

test("missing harnesses are listed as unavailable and cannot start or be proposed", async (t) => {
  const { sessions } = await fixture(t, { shell, ghost: { argv: ["live-assistant-missing-cli"] } });
  const rows = sessions.harnesses();
  assert.deepEqual(rows.map(({ name, available }) => ({ name, available })), [{ name: "shell", available: true }, { name: "ghost", available: false }]);
  await assert.rejects(sessions.create({ harness: "ghost" }, randomUUID()), (error) => error.status === 409 && /not found on PATH/.test(error.message));
  await assert.rejects(sessions.propose({ kind: "create", harness: "ghost" }), (error) => error.status === 409);
  assert.deepEqual(sessions.list(), []);
});

test("sessions start in <harness>-work by default and custom directories must stay inside the allowed roots", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "live-outside-"));
  const extra = await mkdtemp(join(tmpdir(), "live-root-"));
  t.after(() => Promise.all([rm(outside, { recursive: true }), rm(extra, { recursive: true })]));
  const { sessions, directory } = await fixture(t, { shell }, { roots: [extra] });
  const first = await sessions.create({ harness: "shell" }, randomUUID());
  assert.equal(first.cwd, join(directory, "shell-work"));
  await sessions.write(first.id, "pwd > where.txt\r");
  await until(async () => (await content(join(directory, "shell-work", "where.txt")))?.trim() === join(directory, "shell-work"), "default cwd");
  const nested = await sessions.create({ harness: "shell", cwd: join(extra, "project", "sub") }, randomUUID());
  assert.equal(nested.cwd, join(extra, "project", "sub"));
  assert.equal((await stat(nested.cwd)).isDirectory(), true);
  await assert.rejects(sessions.create({ harness: "shell", cwd: outside }, randomUUID()), (error) => error.status === 403);
  await assert.rejects(sessions.create({ harness: "shell", cwd: join(extra, "..", "escape") }, randomUUID()), (error) => error.status === 403);
  await symlink(outside, join(extra, "link"));
  await assert.rejects(sessions.create({ harness: "shell", cwd: join(extra, "link") }, randomUUID()), (error) => error.status === 403);
  await assert.rejects(stat(join(extra, "..", "escape")), { code: "ENOENT" });
  // A missing path below a link that leaves the roots is refused before anything is created outside.
  await assert.rejects(sessions.create({ harness: "shell", cwd: join(extra, "link", "made", "here") }, randomUUID()), (error) => error.status === 403);
  await assert.rejects(stat(join(outside, "made")), { code: "ENOENT" });
  const proposal = await sessions.propose({ kind: "create", harness: "shell", cwd: join(extra, "proposed"), data: "pwd > proposed.txt" });
  assert.match(proposal.preview, /proposed/);
  await sessions.decide(proposal.id, true, randomUUID());
  await until(async () => (await content(join(extra, "proposed", "proposed.txt")))?.trim() === join(extra, "proposed"), "approved create in custom cwd", 300);
});

test("sessions inherit the assistant environment; adapter secrets stay out of argv, tmux globals and state", async (t) => {
  const secret = { argv: shell.argv, env: async () => ({ SYNTHETIC_SESSION_TOKEN: "synthetic-secret-value" }) };
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LIVE_FIXTURE_INHERITED: "inherited value; with $pecial", TMUX: "/outer,1,0" };
  const { sessions, directory } = await fixture(t, { shell, secret }, { env });
  const plain = await sessions.create({ harness: "shell" }, randomUUID());
  const token = await sessions.create({ harness: "secret" }, randomUUID());
  await sessions.write(plain.id, "printf '%s|%s|%s' \"$LIVE_FIXTURE_INHERITED\" \"${SYNTHETIC_SESSION_TOKEN-unset}\" \"${TMUX:+nested}\" > env.txt\r");
  await sessions.write(token.id, "printf '%s' \"$SYNTHETIC_SESSION_TOKEN\" > token.txt\r");
  await until(async () => await content(join(directory, "shell-work", "env.txt")) !== null, "inherited env");
  assert.equal(await content(join(directory, "shell-work", "env.txt")), "inherited value; with $pecial|unset|nested");
  await until(async () => await content(join(directory, "secret-work", "token.txt")) === "synthetic-secret-value", "adapter env");
  const tmux = (...args) => promisify(execFile)("tmux", ["-S", join(directory, "tmux.sock"), ...args]).then(({ stdout }) => stdout);
  assert.ok(!(await tmux("show-environment", "-g")).includes("synthetic-secret-value"));
  assert.ok(!(await tmux("show-options", "-g", "update-environment")).includes("SYNTHETIC"));
  assert.ok(!(await promisify(execFile)("ps", ["-eo", "args"])).stdout.includes("synthetic-secret-value"));
  for (const file of ["sessions.json", "events.jsonl"]) assert.ok(!(await content(join(directory, file)) ?? "").includes("synthetic-secret-value"));
  const failing = { argv: shell.argv, env: async () => { throw new Error("az login required"); } };
  const second = await fixture(t, { failing });
  await assert.rejects(second.sessions.create({ harness: "failing" }, randomUUID()), (error) => error.status === 409 && /environment setup failed: az login required/.test(error.message));
});

test("each new session reads the current ~/.bashrc: shell sources it, rc harnesses start through it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "live-assistant-home-"));
  t.after(() => rm(home, { recursive: true }));
  // Like Ubuntu's ~/.bashrc, it returns early for non-interactive shells.
  const rc = (value) => writeFile(join(home, ".bashrc"), `case $- in *i*) ;; *) return;; esac\nexport LIVE_FIXTURE_RC=${value}\n`);
  const probe = (file, end) => ["/bin/bash", "-c", `printf '%s' "\${LIVE_FIXTURE_RC-unset}" > ${file}; ${end}`];
  const { shell: bashrc } = defaultAdapters({ hooks: false });
  const adapters = { shell: bashrc, cli: { argv: probe("cli.txt", "exit 7"), rc: true }, plain: { argv: probe("plain.txt", "sleep 60") } };
  const { sessions, directory } = await fixture(t, adapters, { env: { PATH: process.env.PATH, HOME: home } });
  const result = (harness, file) => content(join(directory, `${harness}-work`, file));
  for (const value of ["first", "edited"]) {
    await rc(value);
    const shellSession = await sessions.create({ harness: "shell" }, randomUUID());
    await sessions.write(shellSession.id, "printf '%s' \"$LIVE_FIXTURE_RC\" > shell.txt; exit\r");
    const cli = await sessions.create({ harness: "cli" }, randomUUID());
    await until(async () => await result("shell", "shell.txt") === value, `shell reads ~/.bashrc (${value})`);
    await until(async () => await result("cli", "cli.txt") === value, `rc harness reads ~/.bashrc (${value})`);
    // The wrapper bash execs the CLI, so its exit status is the session's.
    await until(() => sessions.get(cli.id).exitCode === 7, "rc harness exit status");
  }
  await sessions.create({ harness: "plain" }, randomUUID());
  await until(async () => await result("plain", "plain.txt") === "unset", "harness without rc skips ~/.bashrc");
});

test("a termination retry keeps waiting for descendants an earlier attempt saw survive", async (t) => {
  const { sessions, directory } = await fixture(t);
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  await until(() => sessions.history(session.id).includes("bash-"), "ready shell");
  await sessions.userInput(session.id, "nohup sleep 60 >/dev/null 2>&1 & echo $! > survivor.pid\r", "user");
  let survivor;
  await until(async () => (survivor = Number(await content(join(directory, "shell-work", "survivor.pid")))) > 0, "survivor started");
  t.after(() => { try { process.kill(survivor, "SIGKILL"); } catch {} });
  await assert.rejects(sessions.terminate(session.id, randomUUID()), (error) => error.status === 409);
  assert.equal(sessions.get(session.id).state, "unknown");
  // The pane is gone now, so only the recorded list still names the survivor.
  await assert.rejects(sessions.terminate(session.id, randomUUID()), (error) => error.status === 409);
  assert.equal(sessions.get(session.id).termination.state, "uncertain");
  process.kill(survivor, "SIGKILL");
  await sessions.terminate(session.id, randomUUID());
  assert.equal(sessions.get(session.id).state, "terminated");
});

test("closing a tab terminates its process and removes it from the session list", async (t) => {
  const { sessions } = await fixture(t);
  const keep = await sessions.create({ harness: "shell" }, randomUUID());
  const close = await sessions.create({ harness: "shell" }, randomUUID());
  await until(() => sessions.get(close.id).pid, "pid");
  const pid = sessions.get(close.id).pid;
  await sessions.closeTab(close.id, randomUUID());
  assert.equal(sessions.get(close.id).state, "terminated");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(sessions.list().map((session) => session.id), [keep.id]);
  await sessions.terminate(keep.id, randomUUID());
  await sessions.closeTab(keep.id, randomUUID());
  assert.deepEqual(sessions.list(), []);
});

test("one backend per state directory: a second is refused before it touches state, and a crashed holder frees it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-lock-"));
  t.after(() => rm(directory, { recursive: true }));
  const first = await startAssistant({ directory, workspace: directory, password });
  const config = await readFile(join(directory, "tmux.conf"), "utf8");
  await writeFile(join(directory, "tmux.conf"), `${config}# marker\n`);
  await assert.rejects(startAssistant({ directory, workspace: directory, password }), /already used by another live assistant backend/);
  assert.match(await readFile(join(directory, "tmux.conf"), "utf8"), /# marker/, "the refused backend rewrote nothing");
  await stat(join(directory, "hook.sock"));
  await first.close();
  // Another process holds the lock, then dies without cleanup.
  const store = new URL("../packages/live-assistant/src/store.mjs", import.meta.url).href;
  const holder = spawn(process.execPath, ["--input-type=module", "-e",
    `const { lockDirectory } = await import(${JSON.stringify(store)}); await lockDirectory(${JSON.stringify(directory)}); console.log("locked"); setInterval(() => {}, 1000);`]);
  t.after(() => holder.kill("SIGKILL"));
  await new Promise((done, fail) => { holder.stdout.once("data", done); holder.once("exit", fail); });
  await assert.rejects(startAssistant({ directory, workspace: directory, password }), /already used/);
  holder.kill("SIGKILL");
  await once(holder, "exit");
  const again = await startAssistant({ directory, workspace: directory, password });
  await again.close();
});

test("HTTP state reports harness availability and roots; /api/close ends and hides a session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-http-close-"));
  const app = await startAssistant({ directory, workspace: directory, password, adapters: { shell, ghost: { argv: ["live-assistant-missing-cli"] } } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true }); });
  const post = (path, data, cookie) => fetch(`${app.origin}${path}`, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  const cookie = (await post("/api/login", { password })).headers.get("set-cookie").split(";")[0];
  const state = await (await fetch(`${app.origin}/api/state`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(state.harnesses.map(({ name, available }) => [name, available]), [["shell", true], ["ghost", false]]);
  assert.equal(state.workspace, app.sessions.workspace);
  assert.deepEqual(state.roots, [app.sessions.workspace]);
  assert.equal((await post("/api/sessions", { harness: "ghost", operationId: randomUUID() }, cookie)).status, 409);
  assert.equal((await post("/api/sessions", { harness: "shell", cwd: tmpdir(), operationId: randomUUID() }, cookie)).status, 403);
  const created = await (await post("/api/sessions", { harness: "shell", cwd: join(directory, "custom"), operationId: randomUUID() }, cookie)).json();
  assert.equal(created.cwd, join(app.sessions.workspace, "custom"));
  assert.equal((await post("/api/close", { sessionId: created.id, operationId: randomUUID() }, cookie)).status, 200);
  assert.equal(app.sessions.get(created.id).state, "terminated");
  assert.deepEqual((await (await fetch(`${app.origin}/api/state`, { headers: { Cookie: cookie } })).json()).sessions, []);
});

test("a failed Live creation pushes its state so the page shows the failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-http-live-"));
  let info = { state: "disconnected", sessionId: null, error: null };
  const live = {
    subscribe: () => () => {}, diagnostics: () => info, usage: () => null, close: async () => {}, initialize: async () => {},
    open: async () => { info = { state: "failed", sessionId: null, error: "creation-uncertain" }; throw new Error("Live creation failed without a response (TypeError: ENOTFOUND)"); },
  };
  const app = await startAssistant({ directory, workspace: directory, password, adapters: { shell }, live });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true }); });
  const post = (path, data, cookie) => fetch(`${app.origin}${path}`, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
  const cookie = (await post("/api/login", { password })).headers.get("set-cookie").split(";")[0];
  const socket = new WebSocket(`${app.origin.replace("http:", "ws:")}/terminal`, { headers: { Origin: app.origin, Cookie: cookie } });
  t.after(() => socket.terminate());
  const states = [];
  socket.on("message", (raw) => { const event = JSON.parse(raw.toString()); if (event.type === "state") states.push(event.assistant.live); });
  await once(socket, "open");
  const response = await post("/api/live/open", { sdp: "v=0\nfixture" }, cookie);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /without a response \(TypeError: ENOTFOUND\)/);
  for (let i = 0; i < 50 && !states.some((row) => row.state === "failed"); i++) await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(states.at(-1), { state: "failed", sessionId: null, error: "creation-uncertain" });
});
