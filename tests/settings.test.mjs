import { test as base } from "node:test";
const test = (name, fn) => base(name, { timeout: 45000 }, fn);
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { Settings } from "../packages/live-assistant/src/settings.mjs";
import { Sessions } from "../packages/live-assistant/src/sessions.mjs";
import { startAssistant } from "../packages/live-assistant/src/server.mjs";

const password = "synthetic-local-test-password";
const shell = { argv: ["/bin/bash", "--noprofile", "--norc", "-i"] };
const endpoint = "https://fixture.openai.azure.com/";
const pause = (ms = 20) => new Promise((done) => setTimeout(done, ms));
const defaults = (workspace) => ({
  subscription: "", liveEndpoint: "", liveDeployment: "gpt-live-1", liveVoice: "marin", ttsEndpoint: "", ttsDeployment: "gpt-4o-mini-tts", ttsVoice: "alloy",
  intentEndpoint: "", intentDeployment: "gpt-6.1-sol", intentEffort: "low", workspace, roots: [], dshProfile: "dsh-tui", dshToken: false, hooks: true,
  verifyTimeout: 600, uploadMb: 2048,
});
async function temporary(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("saved settings override the defaults, null or the default value removes the override, invalid saved keys are ignored", async (t) => {
  const directory = await temporary(t, "live-settings-");
  const settings = new Settings(directory, defaults(directory));
  assert.deepEqual(settings.values, defaults(directory));
  settings.commit(settings.merge({ liveVoice: "cedar", liveEndpoint: endpoint, uploadMb: 1.5 }));
  assert.deepEqual(JSON.parse(await readFile(join(directory, "settings.json"), "utf8")), { liveVoice: "cedar", liveEndpoint: endpoint, uploadMb: 1.5 });
  settings.commit(settings.merge({ liveVoice: null, uploadMb: 2048 }));
  assert.deepEqual(settings.view().overridden, ["liveEndpoint"]);
  assert.equal(settings.values.liveVoice, "marin");
  assert.throws(() => settings.merge({ liveEndpoint: "https://example.com/" }), { status: 400, message: /^liveEndpoint: Use the Foundry HTTPS root/ });
  assert.throws(() => settings.merge({ intentEndpoint: "http://intent.openai.azure.com/" }), { status: 400, message: /^intentEndpoint: Use the Foundry HTTPS root/ });
  assert.throws(() => settings.merge({ password: "x" }), { status: 400 });
  assert.throws(() => settings.merge({ roots: ["relative"] }), { message: /roots\.0: Use an absolute path/ });
  await writeFile(join(directory, "settings.json"), JSON.stringify({ ttsVoice: "nova", intentEffort: "extreme" }));
  const restarted = new Settings(directory, defaults(directory));
  assert.equal(restarted.values.ttsVoice, "nova");
  assert.equal(restarted.values.intentEffort, "low");
  assert.deepEqual(restarted.view().ignored, ["intentEffort"]);
});

test("a session keeps the hook setting it was created with when the settings change", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-settings-hooks-"));
  const sessions = new Sessions({ directory, workspace: directory, adapters: { shell: { ...shell, hooks: true } } });
  t.after(async () => {
    for (const session of sessions.list()) if (session.state === "running") await sessions.terminate(session.id, randomUUID());
    await sessions.close();
    await rm(directory, { recursive: true });
  });
  await sessions.initialize();
  const session = await sessions.create({ harness: "shell" }, randomUUID());
  sessions.configure({ workspace: directory, roots: [], adapters: { shell: { ...shell, hooks: false } }, verifyTimeout: 1000 });
  assert.equal(sessions.get(session.id).hooks, true);
  assert.equal(sessions.verifyTimeout, 1000);
  const later = await sessions.create({ harness: "shell" }, randomUUID());
  assert.equal(sessions.get(later.id).hooks, false);
});

// A fake Foundry Live: the creation POST is recorded and the sideband socket acknowledges every command.
async function fakeLive(t) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((done) => server.close(done));
  });
  const creates = [], commands = [];
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const event = JSON.parse(raw.toString()); commands.push(event);
    socket.send(JSON.stringify(event.type === "session.close" ? { type: "session.closed", usage: { seconds: 3 } } : { type: `${event.type}ed` }));
  }));
  const transport = {
    credential: { getToken: async () => ({ token: "synthetic-fixture-not-a-real-credential", expiresOnTimestamp: Date.now() + 10000 }) },
    fetch: async (url, request) => {
      creates.push({ url, body: JSON.parse(request.body) });
      return Response.json({ session: { id: `session-${creates.length}` }, transport: { sdp: "v=0\nanswer" } });
    },
    socket: () => new WebSocket(`ws://127.0.0.1:${server.address().port}`),
    acknowledgementTimeoutMs: 1000,
  };
  return { transport, creates, commands };
}

test("page settings apply without a restart: Live endpoint and voice, speech voice, failures change nothing, saved values survive restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "live-settings-http-"));
  const fake = await fakeLive(t);
  const spoken = [];
  const options = {
    directory, workspace: join(directory, "workspace"), password, adapters: { shell }, liveTransport: fake.transport,
    speak: async (text, { voice } = {}) => { spoken.push([text, voice]); return { type: "audio/mpeg", data: Buffer.from("ID3fixture") }; },
  };
  let app = await startAssistant(options);
  t.after(async () => {
    for (const session of app.sessions.list()) if (session.state === "running") await app.sessions.terminate(session.id, randomUUID());
    await app.close(); await rm(directory, { recursive: true });
  });
  const session = async () => {
    const post = (path, data, cookie) => fetch(`${app.origin}${path}`, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
    const cookie = (await post("/api/login", { password })).headers.get("set-cookie").split(";")[0];
    return {
      cookie, post: (path, data) => post(path, data, cookie),
      state: async () => (await fetch(`${app.origin}/api/state`, { headers: { Cookie: cookie } })).json(),
    };
  };
  let page = await session();
  let state = await page.state();
  assert.equal(state.settings.values.liveEndpoint, "");
  assert.equal(state.assistant.live.state, "disabled");
  assert.equal(state.settings.liveVoices[0], "marin");
  assert.equal((await page.post("/api/live/open", { sdp: "v=0\noffer" })).status, 409);
  assert.equal(fake.creates.length, 0);

  // A root that does not exist rejects the whole change, including the valid endpoint and voice.
  const rejected = await page.post("/api/settings", { values: { liveEndpoint: endpoint, liveVoice: "cedar", roots: [join(directory, "missing")] } });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Allowed session root .* is unavailable: ENOENT/);
  state = await page.state();
  assert.deepEqual([state.settings.values.liveEndpoint, state.settings.overridden, state.assistant.live.state], ["", [], "disabled"]);

  await mkdir(join(directory, "extra"));
  const saved = await page.post("/api/settings", { values: { liveEndpoint: endpoint, liveVoice: "cedar", ttsVoice: "nova", roots: [join(directory, "extra")], uploadMb: 0.001 } });
  assert.equal(saved.status, 200);
  state = await page.state();
  assert.equal(state.assistant.live.state, "disconnected");
  assert.deepEqual(state.roots, [app.sessions.workspace, join(directory, "extra")]);
  // The upload limit applies to the next request.
  const created = await (await page.post("/api/sessions", { harness: "shell", operationId: randomUUID() })).json();
  const upload = await fetch(`${app.origin}/api/upload?sessionId=${created.id}&name=big.bin`, {
    method: "POST", headers: { Origin: app.origin, Cookie: page.cookie, "Content-Type": "application/octet-stream" }, body: Buffer.alloc(2048),
  });
  assert.equal(upload.status, 413);
  await app.sessions.terminate(created.id, randomUUID());

  // The next connection uses the saved endpoint and voice; the endpoint cannot change under a connection.
  assert.equal((await page.post("/api/live/open", { sdp: "v=0\noffer" })).status, 200);
  assert.ok(fake.creates[0].url.startsWith("https://fixture.openai.azure.com/"));
  assert.deepEqual(fake.creates[0].body.session.audio, { output: { voice: "cedar" } });
  const moved = await page.post("/api/settings", { values: { liveEndpoint: "https://other.openai.azure.com/" } });
  assert.equal(moved.status, 409);
  assert.match((await moved.json()).error, /Disconnect voice before changing the Foundry endpoint/);
  assert.equal((await page.state()).settings.values.liveEndpoint, endpoint);
  // A voice change while connected is saved for the next connection; the other models' resources are not pinned by it.
  assert.equal((await page.post("/api/settings", { values: { liveVoice: "ash" } })).status, 200);
  assert.equal((await page.post("/api/settings", { values: { intentEndpoint: "https://intent.openai.azure.com/", ttsEndpoint: "https://speech.openai.azure.com/" } })).status, 200);
  assert.equal((await page.post("/api/settings", { values: { intentEndpoint: null, ttsEndpoint: null } })).status, 200);
  assert.equal((await page.post("/api/live/close", {})).status, 200);

  // A preview connection reads the sample in the chosen voice and gets no assistant context.
  assert.equal((await page.post("/api/live/preview", {})).status, 409);
  assert.equal((await page.post("/api/live/open", { sdp: "v=0\noffer", voice: "verse", preview: true })).status, 200);
  assert.deepEqual(fake.creates[1].body.session.audio, { output: { voice: "verse" } });
  assert.match(fake.creates[1].body.session.instructions, /voice preview/);
  await pause(50);
  assert.equal(fake.commands.filter((event) => event.type === "session.commentary.append").length, 0);
  assert.equal((await page.post("/api/live/preview", {})).status, 200);
  assert.match(JSON.stringify(fake.commands.filter((event) => event.type === "session.commentary.append")), /这是我现在的声音/);
  assert.equal((await page.state()).assistant.live.preview, true);
  assert.equal((await page.post("/api/live/close", {})).status, 200);
  assert.equal((await page.post("/api/live/open", { sdp: "v=0\noffer" })).status, 200);
  assert.deepEqual(fake.creates[2].body.session.audio, { output: { voice: "ash" } });
  assert.doesNotMatch(fake.creates[2].body.session.instructions, /voice preview/);
  assert.equal((await page.post("/api/live/close", {})).status, 200);

  assert.equal((await page.post("/api/speech", { text: "示例", voice: "shimmer" })).status, 200);
  assert.equal((await page.post("/api/speech", { text: "提醒" })).status, 200);
  assert.deepEqual(spoken, [["示例", "shimmer"], ["提醒", undefined]]);

  // Saved values survive a restart; saved values that no longer apply fall back to the defaults with a fault.
  await app.close();
  app = await startAssistant(options);
  page = await session();
  state = await page.state();
  assert.deepEqual([state.settings.values.liveEndpoint, state.settings.values.liveVoice, state.settings.values.ttsVoice], [endpoint, "ash", "nova"]);
  await app.close();
  await rm(join(directory, "extra"), { recursive: true });
  app = await startAssistant(options);
  page = await session();
  state = await page.state();
  assert.equal(state.settings.values.liveEndpoint, "");
  assert.deepEqual(state.roots, [app.sessions.workspace]);
  assert.match(state.faults.at(-1).message, /Saved settings could not be applied, using the defaults: Allowed session root/);
  // Removing the stale root from the page applies the other saved values again.
  assert.equal((await page.post("/api/settings", { values: { roots: null } })).status, 200);
  assert.equal((await page.state()).settings.values.liveEndpoint, endpoint);
});
