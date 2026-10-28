import { createServer } from "node:http";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { readFile, mkdir, statfs } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { cpus, totalmem, freemem, loadavg } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { Sessions } from "./sessions.mjs";
import { lockDirectory, Serial } from "./store.mjs";
import { Assistant, createLive, createInterpreter, interpreterUsage } from "./assistant.mjs";
import { defaultAdapters } from "./harness.mjs";
import { createSpeech } from "./foundry.mjs";
import { Settings, settingsPatch, voiceName } from "./settings.mjs";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const root = resolve(publicDir, "../../..");
const same = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const uuid = z.string().uuid();
const schemas = {
  "/api/sessions": z.strictObject({ harness: z.string().min(1).max(40), name: z.string().min(1).max(80).optional(), cwd: z.string().min(1).max(4096).optional(), operationId: uuid }),
  "/api/focus": z.strictObject({ sessionId: uuid }),
  "/api/terminate": z.strictObject({ sessionId: uuid, operationId: uuid }),
  "/api/close": z.strictObject({ sessionId: uuid, operationId: uuid }),
  "/api/propose": z.strictObject({ sessionId: uuid, data: z.string().min(1) }),
  "/api/decision": z.strictObject({ proposalId: uuid, allowed: z.boolean(), operationId: uuid, mode: z.enum(["once", "always", "terminal"]).default("once") }),
  "/api/tab": z.strictObject({ sessionId: uuid, color: z.string().nullable().optional(), note: z.string().optional() }),
  "/api/revoke": z.strictObject({ sessionId: uuid, grantId: uuid.optional() }),
  "/api/wait": z.strictObject({ sessionId: uuid }),
  "/api/verify": z.strictObject({ sessionId: uuid, runId: uuid, command: z.string().min(1), operationId: uuid }),
  "/api/verify-cancel": z.strictObject({ operationId: uuid }),
  "/api/request": z.strictObject({ text: z.string().min(1), sessionId: uuid.nullable() }),
  "/api/logout": z.strictObject({}),
  "/api/speech": z.strictObject({ text: z.string().trim().min(1).max(4000), voice: voiceName.optional() }),
  "/api/live/open": z.strictObject({ sdp: z.string().min(1).max(65536), voice: voiceName.optional(), preview: z.boolean().default(false) }),
  "/api/live/preview": z.strictObject({}),
  "/api/settings": z.strictObject({ values: settingsPatch }),
  "/api/live/close": z.strictObject({}),
  "/api/live/mute": z.strictObject({ muted: z.boolean() }),
};

export async function startAssistant(options = {}) {
  const { password, uploadLimit = 2 * 1024 ** 3 } = options;
  if (typeof password !== "string" || password.length < 16) throw new Error("Set LIVE_ASSISTANT_PASSWORD to an in-memory password of at least 16 characters");
  if (!(uploadLimit > 0)) throw new Error("Set LIVE_ASSISTANT_UPLOAD_MB to a positive number of MiB");
  // The state directory is locked before Live, tmux configuration, state or the hook socket are touched.
  const lock = await lockDirectory(resolve(options.directory));
  try { return await serve({ ...options, uploadLimit }, lock); }
  catch (error) { await lock.release(); throw error; }
}

// A voice preview session only reads one sample sentence aloud and is then closed.
const previewInstructions = "You are a voice preview. When the application sends an update, say its text aloud exactly once in natural Mandarin, add nothing, never delegate, then stay silent.";
const previewText = "你好，我是 Live Assistant。这是我现在的声音，你可以选择合适的音色。";
const previewLimit = 30000;

async function serve({
  directory, workspace, password, port = 0, origin: configuredOrigin, adapters: fixedAdapters, live, liveTransport, interpret, speak,
  foundry = {}, harness = {}, verifyTimeout = 600000, roots = [], env, uploadLimit,
}, lock) {
  directory = resolve(directory);
  // The options (from the environment) are defaults; values saved from the page override them and apply without a restart.
  const settings = new Settings(directory, {
    subscription: foundry.subscription ?? "",
    liveEndpoint: foundry.liveEndpoint ?? "", liveDeployment: foundry.deployment ?? "gpt-live-1", liveVoice: foundry.voice ?? "marin",
    ttsEndpoint: foundry.ttsEndpoint ?? "", ttsDeployment: foundry.ttsDeployment ?? "gpt-4o-mini-tts", ttsVoice: foundry.ttsVoice ?? "alloy",
    intentEndpoint: foundry.intentEndpoint ?? "", intentDeployment: foundry.intentDeployment ?? "gpt-6.1-sol", intentEffort: foundry.intentEffort ?? "low",
    workspace: resolve(workspace), roots: roots.map((path) => resolve(path)),
    dshProfile: harness.dshProfile ?? "dsh-tui", dshToken: harness.dshToken ?? false, hooks: harness.hooks ?? process.env.LIVE_ASSISTANT_HOOKS !== "0",
    verifyTimeout: verifyTimeout / 1000, uploadMb: uploadLimit / 1024 ** 2,
  });
  // Injected components (tests) stay fixed; the rest is rebuilt from the settings.
  const fixed = { live: Boolean(live), interpret: Boolean(interpret), speak: Boolean(speak) };
  const usage = interpreterUsage(directory);
  const liveConfig = (values) => ({ endpoint: values.liveEndpoint, subscription: values.subscription || undefined, deployment: values.liveDeployment, voice: values.liveVoice });
  // Builds everything a settings change needs without touching the running parts, so a failure changes nothing.
  const build = async (values) => {
    await mkdir(values.workspace, { recursive: true, mode: 0o700 });
    Sessions.places(values.workspace, values.roots);
    const subscription = values.subscription || undefined;
    return {
      places: { workspace: values.workspace, roots: values.roots, verifyTimeout: values.verifyTimeout * 1000 },
      adapters: fixedAdapters ?? defaultAdapters({ hooks: values.hooks, dshProfile: values.dshProfile, dshToken: values.dshToken, subscription }),
      interpret: fixed.interpret ? interpret : values.intentEndpoint
        ? createInterpreter({ endpoint: values.intentEndpoint, subscription, deployment: values.intentDeployment, effort: values.intentEffort, directory, usage }) : undefined,
      speak: fixed.speak ? speak : values.ttsEndpoint
        ? createSpeech({ endpoint: values.ttsEndpoint, subscription, deployment: values.ttsDeployment, voice: values.ttsVoice }) : undefined,
    };
  };
  let faults = settings.ignored.length ? [{ at: Date.now(), message: `Ignored invalid saved settings: ${settings.ignored.join(", ")}` }] : [];
  let built;
  try { built = await build(settings.values); }
  catch (error) {
    // Saved settings that cannot apply (say, a removed directory) must not keep the page from opening to fix them.
    if (!settings.overridden().length) throw error;
    faults.push({ at: Date.now(), message: `Saved settings could not be applied, using the defaults: ${error.message}` });
    settings.values = settings.defaults;
    built = await build(settings.values);
  }
  ({ interpret, speak } = built);
  if (!fixed.live) {
    live = createLive(directory, liveConfig(settings.values), liveTransport);
    await live.initialize();
  }
  const sessions = new Sessions({ directory, ...built.places, adapters: built.adapters, env });
  await sessions.initialize();
  const assistant = new Assistant({ sessions, live, interpret });
  const configuring = new Serial();
  const configure = (patch) => configuring.run(async () => {
    const next = settings.merge(patch);
    const parts = await build(next.values);
    const previous = live.config;
    if (!fixed.live) live.reconfigure(liveConfig(next.values));
    try { settings.commit(next); }
    catch (error) { if (!fixed.live) live.reconfigure(previous); throw error; }
    sessions.configure({ ...parts.places, adapters: parts.adapters });
    ({ interpret, speak } = parts);
    assistant.interpret = interpret;
  });
  const logins = new Map();
  const clients = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let origin = configuredOrigin;
  let lastLogin = 0;
  const report = (error) => {
    faults = [...faults.slice(-9), { at: Date.now(), message: error.message }];
    broadcastState();
  };
  const send = (socket, value) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 512 * 1024) { socket.close(1013, "Output gap: reconnect for a terminal snapshot"); return; }
    socket.send(JSON.stringify(value));
  };
  const state = () => ({
    sessions: sessions.list(), proposals: sessions.pending(), assistant: assistant.state(), faults,
    harnesses: sessions.harnesses(), workspace: sessions.workspace, roots: sessions.roots, speech: Boolean(speak),
    settings: settings.view(),
  });
  // State is pushed when something changed; bursts of changes coalesce into one message.
  let broadcasting = null;
  const broadcastState = () => {
    broadcasting ??= setImmediate(() => {
      broadcasting = null;
      const message = { type: "state", ...state() };
      for (const socket of clients.keys()) send(socket, message);
    });
  };
  const onOutput = (event) => {
    for (const [socket, client] of clients) if (client.sessionId === event.sessionId) send(socket, { type: "output", ...event });
  };
  sessions.on("output", onOutput);
  sessions.on("gap", ({ sessionId }) => {
    for (const [socket, client] of clients) if (client.sessionId === sessionId) socket.close(1013, "Output gap: reconnect for a fresh snapshot");
  });
  sessions.on("state", broadcastState);
  sessions.on("fault", report);
  sessions.on("owner", ({ sessionId, client }) => {
    for (const [socket, current] of clients) if (current.sessionId === sessionId) send(socket, { type: "owner", sessionId, yours: current.id === client, held: client !== null });
  });
  assistant.on("change", broadcastState);
  const loginOf = (request) => /(?:^|;\s*)live_login=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? "")?.[1];
  const authenticated = (request) => {
    const cookie = loginOf(request);
    const expires = cookie ? logins.get(cookie) : null;
    return expires && expires > Date.now();
  };
  // Host load for the status strip: CPU busy share since the previous sample, available memory, workspace disk and tmux PIDs.
  let cpuTimes = cpus().map(({ times }) => times), stats = null;
  const sample = async () => {
    const now = cpus().map(({ times }) => times);
    let busy = 0, total = 0;
    now.forEach((times, i) => {
      const before = cpuTimes[i] ?? times;
      const spent = Object.keys(times).reduce((sum, key) => sum + times[key] - before[key], 0);
      total += spent; busy += spent - (times.idle - before.idle);
    });
    cpuTimes = now;
    const disk = await statfs(sessions.workspace);
    // No tmux server simply means no live session yet; any other supervisor failure is reported.
    const panes = await sessions.tmux(["list-panes", "-a", "-F", "#{pid} #{session_name} #{pane_pid}"])
      .catch((error) => { if (/no server running|error connecting/.test(error.message)) return ""; throw error; });
    const rows = panes.split("\n").filter(Boolean).map((line) => line.split(" "));
    stats = {
      type: "stats", at: Date.now(), cpu: total > 0 ? busy / total : null, cores: now.length, load: loadavg(),
      memory: { total: totalmem(), available: freemem() },
      disk: { total: disk.blocks * disk.bsize, available: disk.bavail * disk.bsize },
      tmux: { pid: rows.length ? Number(rows[0][0]) : null, panes: rows.map(([, session, pid]) => ({ sessionId: session, pid: Number(pid) })) },
    };
    for (const socket of clients.keys()) send(socket, stats);
  };
  const json = (response, code, data) => {
    response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(data));
  };
  const body = async (request) => {
    if (request.headers["content-type"] !== "application/json") throw Object.assign(new Error("Use application/json"), { status: 415 });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) throw Object.assign(new Error("Request too large"), { status: 413 });
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const assets = {
    "/": [join(publicDir, "index.html"), "text/html"],
    "/client.js": [join(publicDir, "client.js"), "text/javascript"],
    "/style.css": [join(publicDir, "style.css"), "text/css"],
    "/icons.svg": [join(publicDir, "icons.svg"), "image/svg+xml"],
    "/vendor/xterm.js": [join(root, "node_modules/@xterm/xterm/lib/xterm.js"), "text/javascript"],
    "/vendor/xterm.css": [join(root, "node_modules/@xterm/xterm/css/xterm.css"), "text/css"],
    "/vendor/fit.js": [join(root, "node_modules/@xterm/addon-fit/lib/addon-fit.js"), "text/javascript"],
  };
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'");
    try {
      if (request.headers.host !== new URL(origin).host) { json(response, 403, { error: "Untrusted Host" }); return; }
      if (request.method === "GET" && assets[request.url]) {
        const [file, type] = assets[request.url];
        response.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
        response.end(await readFile(file)); return;
      }
      if (request.url === "/api/login" && request.method === "POST") {
        if (request.headers.origin !== origin) { json(response, 403, { error: "Untrusted Origin" }); return; }
        if (Date.now() - lastLogin < 300) { json(response, 429, { error: "Login rate limited" }); return; }
        lastLogin = Date.now();
        const value = z.strictObject({ password: z.string().max(1000) }).parse(await body(request));
        if (!same(value.password, password)) { json(response, 401, { error: "Login failed" }); return; }
        for (const [key, expires] of logins) if (expires < Date.now()) logins.delete(key);
        const cookie = randomBytes(32).toString("hex");
        logins.set(cookie, Date.now() + 8 * 3600000);
        response.setHeader("Set-Cookie", `live_login=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${origin.startsWith("https:") ? "; Secure" : ""}`);
        json(response, 200, { ok: true }); return;
      }
      if (!authenticated(request)) { json(response, 401, { error: "Authentication required" }); return; }
      if (request.method === "GET" && request.url === "/api/state") { json(response, 200, state()); return; }
      const url = new URL(request.url, origin);
      // Files stream straight between the request and disk, outside the JSON body limit.
      if (request.method === "POST" && url.pathname === "/api/upload") {
        if (request.headers.origin !== origin) { json(response, 403, { error: "Untrusted Origin" }); return; }
        if (request.headers["content-type"] !== "application/octet-stream") throw Object.assign(new Error("Use application/octet-stream"), { status: 415 });
        const uploadLimit = Math.floor(settings.values.uploadMb * 1024 ** 2);
        if (Number(request.headers["content-length"]) > uploadLimit) {
          response.setHeader("Connection", "close");
          throw Object.assign(new Error(`Upload exceeds the ${uploadLimit}-byte limit`), { status: 413 });
        }
        const sessionId = uuid.parse(url.searchParams.get("sessionId"));
        const result = await sessions.upload(sessionId, url.searchParams.get("name"), request, uploadLimit);
        json(response, 200, result);
        void assistant.uploaded(result).catch(report);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/download") {
        // Downloads are plain navigations; the SameSite=Strict cookie and Sec-Fetch-Site keep other sites out.
        const site = request.headers["sec-fetch-site"];
        if (site && site !== "same-origin") { json(response, 403, { error: "Untrusted download request" }); return; }
        const sessionId = uuid.parse(url.searchParams.get("sessionId"));
        const file = await sessions.downloadable(sessionId, url.searchParams.get("path"));
        // The page checks first so a bad path shows as an error instead of a broken browser download.
        if (url.searchParams.has("check")) { json(response, 200, file); return; }
        const stream = createReadStream(file.path);
        await once(stream, "open");
        response.writeHead(200, {
          "Content-Type": "application/octet-stream", "Content-Length": file.size, "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${file.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        });
        sessions.log("file-downloaded", sessions.get(sessionId), { path: file.path, bytes: file.size });
        stream.pipe(response);
        stream.on("error", () => response.destroy());
        return;
      }
      if (request.method !== "POST" || !schemas[request.url]) { json(response, 404, { error: "Unknown endpoint" }); return; }
      if (request.headers.origin !== origin) { json(response, 403, { error: "Untrusted Origin" }); return; }
      const data = schemas[request.url].parse(await body(request));
      let result = { ok: true };
      switch (request.url) {
        case "/api/sessions": {
          const { operationId, ...options } = data;
          result = await sessions.create(options, operationId); break;
        }
        case "/api/focus": sessions.get(data.sessionId); assistant.focused = data.sessionId; await assistant.sync(); break;
        case "/api/terminate": await sessions.terminate(data.sessionId, data.operationId); break;
        case "/api/close": await sessions.closeTab(data.sessionId, data.operationId); break;
        case "/api/propose": result = await sessions.propose({ kind: "input", sessionId: data.sessionId, data: data.data, source: "web" }); break;
        case "/api/decision": result = { state: await sessions.decide(data.proposalId, data.allowed, data.operationId, data.mode, "button") }; break;
        case "/api/tab": { const { sessionId, ...fields } = data; await sessions.label(sessionId, fields); break; }
        case "/api/revoke": await sessions.revoke(data.sessionId, data.grantId ?? null); break;
        case "/api/wait": await sessions.waitForFeedback(data.sessionId); break;
        case "/api/verify": {
          const verification = await sessions.startVerification(data.sessionId, data.runId, data.command, data.operationId);
          void verification.completion.catch(report);
          result = { state: verification.state }; break;
        }
        case "/api/verify-cancel": await sessions.cancelVerification(data.operationId); break;
        case "/api/logout": {
          const cookie = loginOf(request);
          logins.delete(cookie);
          for (const [socket, client] of clients) if (client.login === cookie) socket.close(1008, "Logged out");
          response.setHeader("Set-Cookie", `live_login=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${origin.startsWith("https:") ? "; Secure" : ""}`);
          break;
        }
        case "/api/speech": {
          if (!speak) throw Object.assign(new Error("Speech output requires Foundry configuration"), { status: 409 });
          const audio = await speak(data.text, { voice: data.voice });
          response.writeHead(200, { "Content-Type": audio.type, "Cache-Control": "no-store" });
          response.end(audio.data);
          return;
        }
        case "/api/request": result = { ok: true, ...await assistant.request(data.text, null, data.sessionId) }; break;
        case "/api/live/open":
          if (data.preview) {
            result = await live.open({ sdp: data.sdp, language: "zh" }, { voice: data.voice, instructions: previewInstructions, preview: true });
            // The page closes the preview once the sample is heard; this bounds its cost if the page goes away first.
            const { sessionId } = live.diagnostics();
            setTimeout(() => { if (live.diagnostics().sessionId === sessionId) void live.close().catch(() => {}); }, previewLimit).unref();
            break;
          }
          result = await live.open({ sdp: data.sdp, language: "zh" }, { voice: data.voice }); await assistant.sync(); await assistant.observe(assistant.focused); break;
        case "/api/live/preview": {
          // Called once the page's preview connection is up; the page closes it after the sample has played.
          const current = live.diagnostics();
          if (!current.preview || current.state !== "active") throw Object.assign(new Error("No voice preview is connected"), { status: 409 });
          try { await live.appendContext({ sessionId: current.sessionId, text: previewText }); }
          catch (error) { await live.close(); throw error; }
          break;
        }
        case "/api/settings": await configure(data.values); result = settings.view(); break;
        case "/api/live/close": if (live) await live.close(); break;
        case "/api/live/mute": if (live) await (data.muted ? live.stopSpeaking() : live.resumeSpeaking()); break;
      }
      json(response, 200, result);
      broadcastState();
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) json(response, 400, { error: "Invalid request fields" });
      else json(response, error.status ?? 409, { error: error.message });
      // A failed request can still change state (e.g. a failed Live creation); push it so the page shows it.
      broadcastState();
    }
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/terminal" || request.headers.origin !== origin || request.headers.host !== new URL(origin).host || !authenticated(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const client = { id: randomUUID(), sessionId: null, login: loginOf(request), attending: false };
      // Page focus belongs to the attached terminal; switching or disconnecting takes it away.
      const leave = () => {
        if (!client.attending) return Promise.resolve();
        client.attending = false;
        return sessions.attend(client.sessionId, client.id, false);
      };
      clients.set(ws, client);
      send(ws, { type: "state", ...state() });
      if (stats) send(ws, stats); else sample().catch(report);
      const inbound = { tail: Promise.resolve() };
      ws.on("message", (raw) => {
        inbound.tail = inbound.tail.then(async () => {
          if (!authenticated(request)) { ws.close(1008, "Login expired"); return; }
          const data = JSON.parse(raw.toString());
          if (data.type === "attach") {
            uuid.parse(data.sessionId);
            sessions.get(data.sessionId);
            if (client.sessionId !== data.sessionId) await leave();
            client.sessionId = data.sessionId;
            const snapshot = await sessions.snapshot(data.sessionId);
            send(ws, { type: "snapshot", ...snapshot });
            send(ws, { type: "owner", sessionId: data.sessionId, yours: sessions.ownerOf(data.sessionId) === client.id, held: sessions.ownerOf(data.sessionId) !== null });
          } else if (data.type === "claim") {
            if (!client.sessionId) throw new Error("Attach before claiming input");
            await sessions.claim(client.sessionId, client.id);
          } else if (data.type === "release") {
            if (!client.sessionId) throw new Error("Attach before releasing input");
            await sessions.releaseSession(client.sessionId, client.id);
          } else if (data.type === "attention") {
            if (!client.sessionId) throw new Error("Attach before reporting focus");
            client.attending = z.boolean().parse(data.on);
            await sessions.attend(client.sessionId, client.id, client.attending);
          } else if (data.type === "input") {
            if (!client.sessionId) throw new Error("Attach before typing");
            await sessions.userInput(client.sessionId, data.data, client.id, z.boolean().default(false).parse(data.binary));
          } else if (data.type === "resize") {
            if (!client.sessionId) throw new Error("Attach before resizing");
            await sessions.resize(client.sessionId, data.cols, data.rows, client.id);
          } else throw new Error("Unknown terminal operation");
        }).catch((error) => send(ws, { type: "error", error: error.message }));
      });
      ws.on("close", () => { sessions.release(client.id); clients.delete(ws); void leave().catch(report); });
      ws.on("error", () => report(new Error("Browser terminal transport error")));
    });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  origin ??= `http://127.0.0.1:${server.address().port}`;
  const heartbeat = setInterval(() => { for (const socket of clients.keys()) socket.ping(); }, 15000);
  heartbeat.unref();
  const sampler = setInterval(() => { if (clients.size) sample().catch(report); }, 5000);
  sampler.unref();
  return {
    origin, server, sessions, assistant,
    async close() {
      clearInterval(heartbeat); clearInterval(sampler);
      clearImmediate(broadcasting);
      let failure;
      try { await assistant.close(); } catch (error) { failure = error; }
      for (const socket of clients.keys()) socket.terminate();
      wss.close();
      try { await sessions.close(); } finally { await lock.release(); }
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      if (failure) throw failure;
    },
  };
}
