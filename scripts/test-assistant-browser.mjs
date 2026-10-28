import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "@playwright/test";
import { startAssistant } from "../packages/live-assistant/src/server.mjs";
import { defaultAdapters } from "../packages/live-assistant/src/harness.mjs";

const directory = await mkdtemp(join(tmpdir(), "live-browser-test-"));
const password = "synthetic-browser-test-password";
const interpreted = [];
const app = await startAssistant({
  directory, workspace: directory, password,
  // Slow synthetic interpreter: the request form must show progress while it waits.
  interpret: async ({ dialogue, focused }) => {
    interpreted.push({ dialogue, focused });
    await new Promise((done) => setTimeout(done, 600));
    return { kind: "clarify", harness: null, sessionId: null, text: "synthetic clarification", focus: false };
  },
  // The page checks don't depend on the tester's ~/.bashrc; the rc launch itself is covered by `npm test`.
  adapters: { ...defaultAdapters(), shell: { argv: ["/bin/bash", "--noprofile", "--norc", "-i"], hooks: true }, missing: { argv: ["live-assistant-missing-cli"] }, fixture: { argv: [
    process.execPath, "-e",
    'const fs=require("node:fs");process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on("data",data=>{fs.appendFileSync("input.bin",data);if(data.includes(76))process.stdout.write("\\x1b[?1006l");});process.stdout.write("\\x1b[?1049h\\x1b[2J\\x1b[HFULLSCREEN_FIXTURE\\x1b[?1000h\\x1b[?1006h\\x1b[?2004h");',
  ] } },
});
const work = (harness) => join(directory, `${harness}-work`);
let browser;
let page;
const errors = [];
// "新建 session" opens a harness menu; the chosen entry opens the directory dialog, which defaults to
// <workspace>/<harness>-work, and `cwd` picks a custom directory instead.
async function create(harness = "shell", cwd) {
  await page.locator("#create").click();
  await page.locator(`#harness-menu button:text-is("${harness}")`).click();
  await page.locator("#create-dialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#create-harness").textContent(), harness);
  if (cwd) {
    await page.locator('#create-form input[value="custom"]').check();
    await page.locator("#create-cwd").fill(cwd);
  }
  await page.locator("#create-confirm").click();
}
try {
  // Without an override Playwright launches the Chromium it installed (`npx playwright install chromium`).
  const executablePath = process.env.LIVE_ASSISTANT_CHROMIUM || undefined;
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  // A slow login reply invites a second Enter; the page must still build one terminal on one socket.
  const sockets = [];
  page.on("websocket", (socket) => sockets.push(socket));
  await page.route("**/api/login", async (route) => { await new Promise((done) => setTimeout(done, 1200)); await route.continue(); });
  await page.goto(app.origin);
  await page.locator("#password").fill(password);
  await page.locator("#password").press("Enter");
  await new Promise((done) => setTimeout(done, 500));
  await page.locator("#password").press("Enter");
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.unroute("**/api/login");
  await page.waitForFunction(() => document.querySelectorAll("#harness-menu button").length > 0);
  await new Promise((done) => setTimeout(done, 500));
  assert.equal(await page.locator("#terminal .xterm").count(), 1);
  assert.equal(sockets.length, 1);
  // A still-valid login whose first state check is slow: submitting the visible form must not enter twice.
  {
    const lateContext = await browser.newContext();
    await lateContext.addCookies(await page.context().cookies());
    const late = await lateContext.newPage();
    let first = true;
    await late.route("**/api/state", async (route) => { if (first) { first = false; await new Promise((done) => setTimeout(done, 2000)); } await route.continue(); });
    const lateSockets = [];
    late.on("websocket", (socket) => lateSockets.push(socket));
    await late.goto(app.origin);
    await late.locator("#password").fill(password);
    await late.locator("#password").press("Enter");
    await late.locator("#workspace").waitFor({ state: "visible" });
    await new Promise((done) => setTimeout(done, 2500));
    assert.equal(await late.locator("#terminal .xterm").count(), 1);
    assert.equal(lateSockets.length, 1);
    await lateContext.close();
  }
  // A dropped terminal socket: the connection banner clears once it reattaches, and a login lost while the socket was
  // down (backend restart or expiry refuses the upgrade without 1008) returns the page to the login form.
  {
    const dropContext = await browser.newContext();
    const drop = await dropContext.newPage();
    await drop.goto(app.origin);
    await drop.locator("#password").fill(password);
    await drop.locator("#password").press("Enter");
    await drop.locator("#workspace").waitFor({ state: "visible" });
    await drop.waitForFunction(() => ws?.readyState === WebSocket.OPEN);
    await drop.evaluate(() => { ws.onerror(); ws.close(); });
    assert.equal(await drop.locator("#error-text").textContent(), "终端连接失败");
    await drop.waitForFunction(() => document.querySelector("#error").hidden && ws.readyState === WebSocket.OPEN, null, { timeout: 5000 });
    await drop.evaluate(async () => {
      await new Promise((done) => { const closed = ws.onclose; ws.onclose = (event) => { closed(event); done(); }; ws.close(); });
      await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    });
    await drop.locator("#login").waitFor({ state: "visible", timeout: 8000 });
    await dropContext.close();
  }
  // Voice controls: one connect/disconnect toggle and two switches whose labels state the current setting.
  const voice = () => page.evaluate(() => ({
    state: document.querySelector("#live-status").dataset.state, label: document.querySelector("#live-label").textContent,
    connect: [document.querySelector("#connect").textContent, document.querySelector("#connect").disabled, document.querySelector("#connect").className],
    mic: [document.querySelector("#mic").textContent, document.querySelector("#mic").getAttribute("aria-checked"), document.querySelector("#mic").disabled],
    sound: [document.querySelector("#mute").textContent, document.querySelector("#mute").getAttribute("aria-checked"), document.querySelector("#mute").disabled],
  }));
  assert.deepEqual(await voice(), { state: "disabled", label: "语音不可用", connect: ["连接语音", true, "primary"], mic: ["麦克风 开", "true", true], sound: ["助手声音 开", "true", true] });
  // Simulate a connected page (no Foundry here) to check the switches flip visibly and the toggle offers disconnect.
  await page.evaluate(() => { pc = { close() {} }; current.assistant.live = { ...current.assistant.live, state: "active", error: null }; voiceControls(); });
  assert.deepEqual(await voice(), { state: "active", label: "已连接", connect: ["断开语音", false, "connected"], mic: ["麦克风 开", "true", false], sound: ["助手声音 开", "true", false] });
  await page.locator("#mic").click();
  await page.locator("#mute").click();
  await page.waitForFunction(() => document.querySelector("#mute").getAttribute("aria-checked") === "false");
  assert.deepEqual((await voice()).mic, ["麦克风 关", "false", false]);
  assert.deepEqual((await voice()).sound, ["助手声音 关", "false", false]);
  assert.equal(await page.evaluate(() => document.querySelector("#audio").muted), true);
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#connect").textContent === "连接语音");
  assert.deepEqual(await voice(), { state: "disabled", label: "语音不可用", connect: ["连接语音", true, "primary"], mic: ["麦克风 开", "true", true], sound: ["助手声音 开", "true", true] });
  // A failed provider session that is not confirmed closed blocks reconnecting, so the toggle still offers disconnect.
  const failedVoice = (closeConfirmed) => page.evaluate((confirmed) => {
    const saved = current.assistant.live;
    current.assistant.live = { ...saved, state: "failed", error: "close-unconfirmed", closeConfirmed: confirmed };
    voiceControls();
    const result = [document.querySelector("#connect").textContent, document.querySelector("#connect").disabled];
    current.assistant.live = saved; voiceControls();
    return result;
  }, closeConfirmed);
  assert.deepEqual(await failedVoice(false), ["断开语音", false]);
  assert.deepEqual(await failedVoice(true), ["连接语音", false]);
  // Spoken turns are shown in order, so after a long reply the caller's latest words are still in view.
  const transcript = await page.evaluate(() => {
    const box = document.querySelector("#transcript");
    const turns = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: i % 2 ? `回复 ${i} `.repeat(20) : `问题 ${i}` }));
    render({ ...current, assistant: { ...current.assistant, live: { ...current.assistant.live, turns } } });
    const lines = [...box.querySelectorAll("p")];
    const visible = lines.filter((line) => line.offsetTop + line.offsetHeight > box.scrollTop + box.offsetTop && line.offsetTop < box.scrollTop + box.offsetTop + box.clientHeight);
    box.scrollTop = 0;
    render({ ...current, assistant: { ...current.assistant, live: { ...current.assistant.live, turns: [...turns, { role: "user", text: "再问" }] } } });
    return { count: lines.length, first: lines[0].textContent, visible: visible.map((line) => line.textContent.slice(0, 12)), kept: box.scrollTop };
  });
  assert.equal(transcript.count, 30);
  assert.equal(transcript.first, "你：问题 0");
  assert.ok(transcript.visible.includes("你：问题 28"), `latest caller turn visible: ${transcript.visible}`);
  assert.equal(transcript.kept, 0, "reading earlier turns is not interrupted by new speech");
  assert.equal(await page.locator("#harness-menu").isHidden(), true);
  await page.locator("#create").click();
  assert.equal(await page.locator("#create").getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator('#harness-menu button:text-is("missing（未找到）")').isDisabled(), true);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "shell", "the first available harness takes focus");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#harness-menu").isHidden(), true);
  await page.locator("#create").click();
  await page.locator("#terminal").click({ position: { x: 10, y: 10 } });
  assert.equal(await page.locator("#harness-menu").isHidden(), true, "clicking elsewhere closes the menu");
  await create();
  await page.locator("#tabs .tab").waitFor();
  await page.waitForTimeout(500);
  // An unclaimed terminal fills the black area: the native pane takes the page's fitted size and follows window resizes.
  const paneSize = async () => (await app.sessions.tmux(["display-message", "-p", "-t", app.sessions.list()[0].id, "#{pane_width}x#{pane_height}"])).trim();
  const fitted = async (previous) => {
    for (let i = 0; i < 40; i++) {
      const size = await page.evaluate(() => `${terminal.cols}x${terminal.rows}`);
      if (size !== previous && await paneSize() === size) return size;
      await page.waitForTimeout(50);
    }
    assert.fail(`pane ${await paneSize()} does not follow the page terminal ${await page.evaluate(() => `${terminal.cols}x${terminal.rows}`)}`);
  };
  // The fitted grid stays inside the frame's padding, so the rounded border never cuts off the last row,
  // and it leaves less than one row empty.
  const framed = (size) => page.evaluate((size) => {
    const frame = $("terminal"), style = getComputedStyle(frame), box = frame.getBoundingClientRect();
    const screen = frame.querySelector(".xterm-screen").getBoundingClientRect();
    const bottom = box.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth);
    const right = box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
    return { size, inside: screen.bottom <= bottom + 0.5 && screen.right <= right + 0.5, filled: bottom - screen.bottom < screen.height / terminal.rows };
  }, size);
  const wide = await fitted();
  assert.notEqual(wide, "100x30");
  assert.deepEqual(await framed(wide), { size: wide, inside: true, filled: true });
  await page.setViewportSize({ width: 1100, height: 700 });
  const small = await fitted(wide);
  assert.deepEqual(await framed(small), { size: small, inside: true, filled: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const grown = (await fitted(small)).split("x").map(Number);
  assert.ok(grown[0] >= Number(wide.split("x")[0]) - 1 && grown[1] >= Number(wide.split("x")[1]) - 1, "the terminal refits when the window grows back");
  // The keyboard button is a visible toggle: take over, give back, take over again.
  await page.locator("#claim").click();
  await page.waitForFunction(() => document.querySelector("#claim").getAttribute("aria-pressed") === "true" && document.querySelector("#claim").textContent === "交还键盘");
  await page.locator("#claim").click();
  await page.waitForFunction(() => document.querySelector("#claim").getAttribute("aria-pressed") === "false" && document.querySelector("#claim").textContent === "接管键盘");
  assert.equal(app.sessions.ownerOf(app.sessions.list()[0].id), null);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "request-text", "giving the keyboard back focuses the request box");
  await page.locator("#claim").click();
  await page.waitForFunction(() => document.querySelector("#claim").getAttribute("aria-pressed") === "true");
  await page.locator(".xterm-helper-textarea").pressSequentially("printf 'FIRST_TAB\\n'; printf test > browser-proof.txt");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("FIRST_TAB"));
  await create("shell", join(directory, "custom-dir"));
  await page.waitForFunction(() => document.querySelectorAll("#tabs .tab").length === 2);
  // A new session takes the keyboard focus: typing right away, without clicking, reaches its harness.
  await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea"), null, { timeout: 5000 });
  await page.keyboard.type("printf 'SECOND_TAB\\n'");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("SECOND_TAB"));
  // Voice "switch to the first session" moves the page itself, not only the command target.
  await app.assistant.switchTo(app.sessions.list()[0].id);
  await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("FIRST_TAB"));
  assert.equal(await page.locator("#tabs .tab.selected").count(), 1);
  assert.equal(await page.locator("#tabs .tab").first().evaluate((tab) => tab.classList.contains("selected")), true);
  await page.locator("#tabs .tab-label").nth(1).click();
  await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("SECOND_TAB"));
  await page.locator("#tabs .tab-label").first().click();
  await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("FIRST_TAB"));
  // Running tabs carry no state word; the color dot and a double-click note label a tab for every page.
  const labels = () => page.locator("#tabs .tab-label").allTextContents();
  assert.deepEqual(await labels(), ["shell", "shell"]);
  await page.locator("#tabs .tab-color").nth(1).click();
  await page.locator('#color-menu [data-color="purple"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#tabs .tab")[1].dataset.color === "purple");
  assert.equal(app.sessions.list()[1].color, "purple");
  assert.equal(await page.locator("#terminal").getAttribute("data-color"), null, "the selected first tab keeps a neutral frame");
  await page.locator("#tabs .tab-label").nth(1).dblclick();
  await page.locator(".tab-note-input").fill("  构建与测试  ");
  await page.locator(".tab-note-input").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#tabs .tab-note")[1].textContent === "构建与测试");
  assert.equal(app.sessions.list()[1].note, "构建与测试");
  await page.locator("#tabs .tab-label").first().dblclick();
  await page.locator(".tab-note-input").fill("discarded");
  await page.locator(".tab-note-input").press("Escape");
  assert.equal(app.sessions.list()[0].note ?? null, null);
  const pids = app.sessions.list().map((session) => session.pid);
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("FIRST_TAB"));
  assert.deepEqual(app.sessions.list().map((session) => session.pid), pids);
  assert.deepEqual(await labels(), ["shell", "shell构建与测试"]);
  assert.equal(await page.locator("#tabs .tab").nth(1).getAttribute("data-color"), "purple");
  await page.locator("#tabs .tab-label").nth(1).click();
  await page.waitForFunction(() => document.querySelector("#terminal").dataset.color === "purple");
  await page.locator("#tabs .tab-label").first().click();
  await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("FIRST_TAB"));
  // Numbered decision cards: approve one proposal in the page and check the native effect.
  const proposal = await app.sessions.propose({ kind: "input", sessionId: app.sessions.list()[0].id, data: "printf card > card-proof.txt\r" });
  // Decision cards sit above any error banner, and the banner does not float over them.
  await page.locator(`#decisions .decision:has(.number:text-is("${proposal.number}."))`).waitFor();
  const layout = await page.evaluate(() => {
    fail(new Error("synthetic banner"));
    const card = document.querySelector("#decisions .decision").getBoundingClientRect(), banner = document.querySelector("#error").getBoundingClientRect();
    const result = { above: card.bottom <= banner.top, position: getComputedStyle(document.querySelector("#error")).position };
    document.querySelector("#error-close").click();
    return result;
  });
  assert.deepEqual(layout, { above: true, position: "static" });
  await page.locator(`#decisions .decision:has(.number:text-is("${proposal.number}.")) button:text-is("批准")`).click();
  for (let i = 0; i < 100 && await readFile(join(work("shell"), "card-proof.txt"), "utf8").catch(() => null) !== "card"; i++) await page.waitForTimeout(50);
  assert.equal(await readFile(join(work("shell"), "card-proof.txt"), "utf8"), "card");
  assert.equal(app.sessions.list()[1].cwd, join(directory, "custom-dir"));
  await page.waitForFunction(() => !document.querySelector("#decisions .decision"));
  // A key card names every press, including invisible chords, and can be granted like typed input.
  const keys = await app.sessions.propose({ kind: "keys", sessionId: app.sessions.list()[0].id, steps: [
    { type: "text", value: "rintf keys > keys-proof.txt" }, { type: "key", value: "ctrl+a" }, { type: "text", value: "p" }, { type: "key", value: "Enter" },
  ] });
  const keyCard = page.locator(`#decisions .decision:has(.number:text-is("${keys.number}."))`);
  await keyCard.waitFor();
  assert.equal(await keyCard.locator("strong").textContent(), "按键 · shell");
  assert.equal(await keyCard.locator("pre").textContent(), '"rintf keys > keys-proof.txt" → Ctrl+A → "p" → Enter');
  assert.equal(await keyCard.locator('button:text-is("始终允许")').count(), 1);
  await keyCard.locator('button:text-is("批准")').click();
  for (let i = 0; i < 100 && await readFile(join(work("shell"), "keys-proof.txt"), "utf8").catch(() => null) !== "keys"; i++) await page.waitForTimeout(50);
  assert.equal(await readFile(join(work("shell"), "keys-proof.txt"), "utf8"), "keys");
  await page.waitForFunction(() => !document.querySelector("#decisions .decision"));
  // "在终端处理" hands a native permission request back and moves the page and keyboard to that session's prompt.
  const hooked = app.sessions.list()[1];
  const hook = spawn(process.execPath, [new URL("../packages/live-assistant/src/hook.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, LIVE_HOOK_SOCKET: app.sessions.hookSocket, LIVE_SESSION_ID: hooked.id }, stdio: ["pipe", "pipe", "inherit"],
  });
  const hookExit = once(hook, "close");
  let hookOutput = "";
  hook.stdout.on("data", (chunk) => { hookOutput += chunk; });
  hook.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test", description: "fixture" } }));
  await page.locator('#decisions .decision button:text-is("在终端处理")').click();
  await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("SECOND_TAB") && document.activeElement?.classList.contains("xterm-helper-textarea"), null, { timeout: 5000 });
  assert.equal(await page.locator("#tabs .tab").nth(1).evaluate((tab) => tab.classList.contains("selected")), true);
  assert.equal((await hookExit)[0], 0);
  assert.equal(hookOutput, "", "the hook defers to the native prompt");
  await page.keyboard.type("printf handed > handed.txt");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 100 && await readFile(join(hooked.cwd, "handed.txt"), "utf8").catch(() => null) !== "handed"; i++) await page.waitForTimeout(50);
  assert.equal(await readFile(join(hooked.cwd, "handed.txt"), "utf8"), "handed");
  // With page focus in that terminal, a new native request waits without a card for the native prompt there.
  const permissionHook = () => {
    const child = spawn(process.execPath, [new URL("../packages/live-assistant/src/hook.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, LIVE_HOOK_SOCKET: app.sessions.hookSocket, LIVE_SESSION_ID: hooked.id }, stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm run lint" } }));
    return once(child, "close").then(([code]) => ({ code, stdout }));
  };
  for (let i = 0; i < 100 && !app.sessions.attended(hooked.id); i++) await page.waitForTimeout(50);
  assert.equal(app.sessions.attended(hooked.id), true, "terminal focus is reported to the backend");
  const quietHook = permissionHook();
  for (let i = 0; i < 100 && !app.sessions.store.value.proposals.some((row) => row.kind === "permission" && row.state === "pending"); i++) await page.waitForTimeout(50);
  const hidden = app.sessions.store.value.proposals.find((row) => row.kind === "permission" && row.state === "pending");
  assert.ok(hidden?.quiet, "the request waits hidden");
  assert.equal(await page.locator("#decisions .decision").count(), 0);
  // Focus elsewhere on the page shows it; choosing its tab puts the keyboard in the terminal and hides it again
  // with the same number; a key typed there answers it natively.
  await page.locator("#request-text").focus();
  const shownCard = page.locator(`#decisions .decision:has(.number:text-is("${hidden.number}."))`);
  await shownCard.locator('button:text-is("在终端处理")').waitFor();
  await page.locator("#tabs .tab-label").nth(1).click();
  await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea") && !document.querySelector("#decisions .decision"));
  await page.locator("#request-text").focus();
  await shownCard.locator('button:text-is("在终端处理")').waitFor();
  assert.equal(await page.locator("#decisions .decision").count(), 1, "leaving shows the same card, not a new one");
  await page.locator(".xterm-helper-textarea").focus();
  await page.waitForFunction(() => !document.querySelector("#decisions .decision"));
  await page.keyboard.press("Escape");
  assert.deepEqual(await quietHook, { code: 0, stdout: "" });
  assert.equal(app.sessions.proposalByNumber(hidden.number).state, "terminal");
  await page.locator("#tabs .tab-label").first().click();
  await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("FIRST_TAB"));
  await page.locator("#verify-command").fill(`${JSON.stringify(process.execPath)} -e 'require("node:assert/strict").equal(require("node:fs").readFileSync("browser-proof.txt","utf8"),"test"); console.log("verify-output-ok")'`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#verify button:not(#verify-cancel)").click();
  await page.waitForFunction(() => document.querySelector("#verification").textContent.includes("passed"));
  await page.locator("#verification-details summary").click();
  await page.waitForFunction(() => document.querySelector("#verification-output").textContent.includes("verify-output-ok"));
  assert.equal(await page.locator("#verification-output").isVisible(), true);
  // Ctrl+Enter submits the request; the form stays busy until the interpreter answers and ignores repeat submits.
  // The request names the session this page shows, whatever another page or voice last focused.
  const shown = app.sessions.list()[0].id;
  app.assistant.focused = app.sessions.list()[1].id;
  await page.locator("#request-text").fill("ctrl enter request");
  await page.locator("#request-text").press("Control+Enter");
  await page.waitForFunction(() => document.querySelector("#request").getAttribute("aria-busy") === "true");
  assert.equal(await page.locator("#request button").textContent(), "正在交给助手…");
  assert.equal(await page.locator("#request button").isDisabled(), true);
  await page.locator("#request-text").press("Control+Enter");
  await page.waitForFunction(() => !document.querySelector("#request").hasAttribute("aria-busy"));
  assert.equal(await page.locator("#request-text").inputValue(), "");
  assert.equal(await page.locator("#request button").textContent(), "交给助手");
  assert.deepEqual(interpreted, [{ dialogue: "ctrl enter request", focused: shown }]);
  // A typed request that needs clarification says so on the page, since no voice reply will come.
  await page.waitForFunction(() => !document.querySelector("#error").hidden && document.querySelector("#error-text").textContent === "Clarification required: synthetic clarification");
  await page.locator("#error-close").click();
  // Upload into the focused shell's working directory, refuse the same name, then download the file back.
  const uploaded = { name: "上传 proof.txt", mimeType: "text/plain", buffer: Buffer.from("uploaded via page") };
  await page.locator("#upload-input").setInputFiles(uploaded);
  await page.waitForFunction(() => document.querySelector("#copy-status").textContent.startsWith("已上传"));
  assert.equal(await readFile(join(work("shell"), uploaded.name), "utf8"), "uploaded via page");
  await page.locator("#upload-input").setInputFiles({ ...uploaded, buffer: Buffer.from("must not overwrite") });
  await page.waitForFunction(() => /^上传 .* 失败：.*already exists/.test(document.querySelector("#copy-status").textContent));
  assert.equal(await readFile(join(work("shell"), uploaded.name), "utf8"), "uploaded via page");
  await page.locator("#download").click();
  await page.locator("#download-path").fill(uploaded.name);
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download-confirm").click()]);
  assert.equal(download.suggestedFilename(), uploaded.name);
  assert.equal(await readFile(await download.path(), "utf8"), "uploaded via page");
  await page.locator("#download").click();
  await page.locator("#download-path").fill("missing.txt");
  await page.locator("#download-confirm").click();
  await page.waitForFunction(() => /^下载失败：.*does not exist/.test(document.querySelector("#copy-status").textContent));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  // Tabs that do not fit wrap onto another row rather than scrolling sideways.
  const tabRows = await page.evaluate(() => {
    const nav = document.querySelector("#tabs");
    nav.style.width = "220px";
    const result = { scrolls: nav.scrollWidth > nav.clientWidth, rows: new Set([...nav.children].map((tab) => tab.offsetTop)).size };
    nav.style.width = "";
    return result;
  });
  assert.deepEqual(tabRows, { scrolls: false, rows: 2 });
  await page.setViewportSize({ width: 1440, height: 900 });
  // Closing a tab ends its native process and removes the tab without a confirmation prompt.
  const closing = app.sessions.list()[1];
  await page.locator("#tabs .tab").nth(1).locator(".tab-close").click();
  await page.waitForFunction(() => document.querySelectorAll("#tabs .tab").length === 1);
  assert.equal(app.sessions.get(closing.id).state, "terminated");
  assert.throws(() => process.kill(closing.pid, 0), { code: "ESRCH" });
  await create("fixture");
  await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("FULLSCREEN_FIXTURE"));
  await page.locator("#claim").click();
  await page.waitForTimeout(200);
  await page.locator(".xterm-screen").click({ position: { x: 50, y: 40 } });
  await page.locator(".xterm-helper-textarea").evaluate((element) => {
    const data = new DataTransfer(); data.setData("text/plain", "PASTE_FIXTURE");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  // A paste longer than one message: with the odd prefix some emoji straddles every chunk boundary.
  const emoji = `y${"😀".repeat(3000)}`;
  await page.locator(".xterm-helper-textarea").evaluate((element, text) => {
    const data = new DataTransfer(); data.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  }, emoji);
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(400);
  const nativeInput = await readFile(join(work("fixture"), "input.bin"), "utf8");
  assert.match(nativeInput, /\x1b\[<0;\d+;\d+M/);
  assert.match(nativeInput, /PASTE_FIXTURE/);
  assert.ok(nativeInput.includes(emoji) && !nativeInput.includes("\uFFFD"), "chunked paste keeps every emoji intact");
  assert.ok(nativeInput.includes("\x03"));
  // Select-and-copy is one-shot: the drag selects and copies, no mouse bytes reach the TUI, then the button resets.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: app.origin });
  const inputLength = async () => (await readFile(join(work("fixture"), "input.bin"))).length;
  const grid = await page.evaluate(() => {
    const rect = document.querySelector(".xterm-screen").getBoundingClientRect();
    return { x: rect.left, y: rect.top, w: rect.width / terminal.cols, h: rect.height / terminal.rows };
  });
  const beforeSelect = await inputLength();
  await page.locator("#select").click();
  assert.equal(await page.locator("#select").getAttribute("aria-pressed"), "true");
  await page.mouse.move(grid.x + grid.w * 0.5, grid.y + grid.h * 0.5);
  await page.mouse.down();
  await page.mouse.move(grid.x + grid.w * 17.5, grid.y + grid.h * 0.5, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("#copy-status").textContent.startsWith("已复制"));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "FULLSCREEN_FIXTURE");
  assert.equal(await page.locator("#select").getAttribute("aria-pressed"), "false");
  await page.locator("#select").click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#select").getAttribute("aria-pressed"), "false");
  await page.waitForTimeout(300);
  assert.equal(await inputLength(), beforeSelect, "selection, copy and Esc must not reach the native PTY");
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.locator("#copy-screen").click();
  await page.waitForFunction(() => document.querySelector("#copy-status").textContent.startsWith("已复制屏幕文本"));
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^FULLSCREEN_FIXTURE/);
  await page.locator(".xterm-screen").click({ position: { x: 60, y: 40 } });
  await page.waitForTimeout(200);
  assert.match((await readFile(join(work("fixture"), "input.bin"))).subarray(beforeSelect).toString("utf8"), /\x1b\[<0;\d+;\d+M/, "mouse reports resume after copying");
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#terminal").textContent.includes("FULLSCREEN_FIXTURE"));
  await page.locator("#claim").click();
  await page.waitForTimeout(200);
  const beforeMouse = (await readFile(join(work("fixture"), "input.bin"))).length;
  await page.locator(".xterm-screen").click({ position: { x: 70, y: 40 } });
  await page.waitForTimeout(200);
  assert.match((await readFile(join(work("fixture"), "input.bin"))).subarray(beforeMouse).toString("utf8"), /\x1b\[<0;\d+;\d+M/);
  await page.keyboard.press("L");
  await page.waitForTimeout(200);
  const beforeBinaryMouse = (await readFile(join(work("fixture"), "input.bin"))).length;
  await page.locator(".xterm-screen").click({ position: { x: 850, y: 40 } });
  await page.waitForTimeout(200);
  const binaryMouse = (await readFile(join(work("fixture"), "input.bin"))).subarray(beforeBinaryMouse);
  const mouseStart = binaryMouse.indexOf(Buffer.from("\x1b[M"));
  assert.ok(mouseStart >= 0, "Legacy mouse bytes must reach the native PTY");
  assert.ok(binaryMouse[mouseStart + 4] >= 128, "Legacy mouse coordinates must preserve non-UTF8 bytes");
  assert.equal(binaryMouse.length, 12, "One native press/release pair must not be UTF8-expanded");
  // Before attachment, terminal-generated reports (mouse, focus) are dropped silently; typing still reports the error.
  const unattached = await page.evaluate(() => {
    snapshotReady = false;
    terminal.input("\x1b[<35;10;5M\x1b[<35;11;5M"); terminal.input("\x1b[I");
    const silent = document.querySelector("#error").hidden;
    terminal.input("x");
    const typed = document.querySelector("#error-text").textContent;
    document.querySelector("#error").hidden = true; snapshotReady = true;
    return { silent, typed };
  });
  assert.deepEqual(unattached, { silent: true, typed: "终端尚未附着；断线期间输入不会缓存。" });
  // The status strip shows host load; logout from one tab returns every tab of that login to the login form.
  await page.waitForFunction(() => /^\d+(\.\d)?G$/.test(document.querySelector("#stat-memory .stat-value").textContent));
  assert.match(await page.locator("#stat-disk .stat-value").textContent(), /^\d+%$/);
  // The single strip tooltip names the tmux server and each running session's pane PID.
  const tooltip = await page.locator("#server-stats").getAttribute("title");
  const running = app.sessions.list().find((session) => session.state === "running");
  assert.match(tooltip, /^CPU .*\nMEM .*\nDISK .*\ntmux 服务 PID \d+\n/);
  assert.ok(tooltip.includes(running.id.slice(0, 8)), tooltip);
  // One top bar spans both columns: terminal commands on the left, host load and the account menu on the right.
  const bar = await page.evaluate(() => {
    const box = (query) => document.querySelector(query).getBoundingClientRect();
    const header = box(".app-bar"), terminals = box(".terminals"), aside = box("aside");
    return {
      inside: ["#create", "#terminate", "#server-stats", "#avatar"].every((query) => document.querySelector(".app-bar").contains(document.querySelector(query))),
      spans: header.left <= terminals.left && header.right >= aside.right,
      above: header.bottom <= terminals.top && header.bottom <= aside.top,
    };
  });
  assert.deepEqual(bar, { inside: true, spans: true, above: true });
  // Icons come from a same-origin sprite, since the page's CSP blocks data: images.
  const icons = await page.evaluate(async () => {
    const response = await fetch("/icons.svg");
    const mask = getComputedStyle(document.querySelector("#claim"), "::before").maskImage;
    return { status: response.status, type: response.headers.get("content-type"), keyboard: (await response.text()).includes('id="keyboard"'), mask: /icons\.svg#keyboard/.test(mask) };
  });
  assert.deepEqual(icons, { status: 200, type: "image/svg+xml; charset=utf-8", keyboard: true, mask: true });
  await page.waitForFunction(() => /^\d+%$/.test(document.querySelector("#stat-cpu .stat-value").textContent), null, { timeout: 8000 });
  // A second tab of the same login: page.newPage() owns its context, so share the cookie with a sibling context.
  const tab = await browser.newContext();
  await tab.addCookies(await page.context().cookies());
  const other = await tab.newPage();
  await other.goto(app.origin);
  await other.locator("#workspace").waitFor({ state: "visible" });
  // The avatar menu holds settings and logout. Settings save at once, persist, and an invalid value keeps the dialog open.
  assert.equal(await page.locator("#account-menu").isHidden(), true);
  await page.locator("#avatar").click();
  assert.deepEqual(await page.locator("#account-menu button").allTextContents(), ["设置", "登出"]);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#account-menu").isHidden(), true);
  await page.locator("#avatar").click();
  await page.locator("#open-settings").click();
  await page.locator("#settings-dialog").waitFor({ state: "visible" });
  const form = page.locator("#settings-form");
  assert.equal(await form.locator("[name=liveVoice]").inputValue(), "marin");
  assert.equal(await form.locator("[name=ttsVoice]").inputValue(), "alloy");
  assert.ok((await form.locator("[name=liveVoice] option").count()) > 10);
  // Without Foundry neither sample can play.
  assert.deepEqual(await page.evaluate(() => [document.querySelector("#preview-live").disabled, document.querySelector("#preview-tts").disabled]), [true, true]);
  const resetHidden = () => form.locator('[data-key="ttsVoice"] .default button').isHidden();
  assert.equal(await resetHidden(), true);
  await form.locator("[name=ttsVoice]").selectOption("nova");
  assert.equal(await resetHidden(), false);
  await form.locator("[name=uploadMb]").fill("3");
  await form.locator("[name=intentEndpoint]").fill("https://example.com/");
  await page.locator("#settings-save").click();
  await page.locator("#error").waitFor({ state: "visible" });
  assert.match(await page.locator("#error-text").textContent(), /Foundry HTTPS root/);
  assert.equal(await page.locator("#settings-dialog").isVisible(), true);
  await form.locator('[data-key="intentEndpoint"] .default button').click();
  await page.locator("#settings-save").click();
  await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  const saved = await page.evaluate(async () => (await (await fetch("/api/state")).json()).settings);
  assert.deepEqual([saved.values.ttsVoice, saved.values.uploadMb, saved.overridden.sort()], ["nova", 3, ["ttsVoice", "uploadMb"]]);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "settings.json"), "utf8")), { ttsVoice: "nova", uploadMb: 3 });
  await page.locator("#avatar").click();
  await page.locator("#open-settings").click();
  await page.locator("#settings-defaults").click();
  await page.locator("#settings-save").click();
  await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "settings.json"), "utf8")), {});
  await page.locator("#avatar").click();
  await page.locator("#logout").click();
  await page.locator("#login").waitFor({ state: "visible" });
  await other.locator("#login").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(async () => (await fetch("/api/state")).status), 401);
  assert.ok(app.sessions.list().some((session) => session.state === "running"), "logout leaves sessions running");
  await tab.close();
  const fixture = join(directory, "browser-result.json");
  await writeFile(fixture, JSON.stringify({ tabs: 2, closedTab: true, reloadPreservedPids: true, narrowLayout: true, errors }));
  assert.deepEqual(errors, []);
  console.log("Independent browser workspace passed: single entry on slow or repeated login, terminal reconnect clears its banner and a lost login returns to the login form, voice control states, missing harness marking, harness menu with create dialog with default/custom directory, terminal auto-fit inside its frame, voice page switch, native typing, numbered decision cards, key cards, hand-back to the terminal with focus, hidden confirmations while the terminal has focus, tab click focuses its terminal, file upload/download, multiple tabs, tab color and note, tab wrapping, tab close, reload persistence, narrow layout, fullscreen TUI, mouse, select-and-copy, screen copy, paste and control keys, focus on new session, spoken turns in order, one top bar with commands and server status, same-origin icons, avatar menu with settings dialog (save, persist, invalid value, restore defaults), logout across tabs.");
} catch (error) {
  console.error(JSON.stringify({
    terminals: app.sessions.list().map((session) => ({ id: session.id, name: session.name, state: session.state, exitCode: session.exitCode, text: app.sessions.history(session.id) })),
    pageErrors: errors,
    browser: await page?.evaluate(() => ({
      error: document.querySelector("#error")?.textContent, copy: document.querySelector("#copy-status")?.textContent, selecting: document.querySelector("#select")?.getAttribute("aria-pressed"), focus: localStorage.getItem("live-focus"), screen: document.querySelector("#terminal").textContent.slice(0, 200), status: document.querySelector("#terminal-status").textContent, tabs: [...document.querySelectorAll("#tabs .tab")].map((tab) => tab.dataset.key + (tab.classList.contains("selected") ? "*" : "")),
      overflow: [...document.querySelectorAll("body *")].map((element) => ({ tag: element.tagName, id: element.id, class: element.className, width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right })).filter((element) => element.right > innerWidth),
    })),
  }));
  throw error;
} finally {
  await browser?.close();
  for (const session of app.sessions.list()) if (session.state === "running") await app.sessions.terminate(session.id, randomUUID());
  await app.close();
  await rm(directory, { recursive: true });
}
