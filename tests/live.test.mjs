import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { FoundryLive } from "../packages/live-assistant/src/live.mjs";

const config = { endpoint: "https://fixture.openai.azure.com", deployment: "fixture", instructions: "Synthetic fixture instructions." };
async function fixture(t, options = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((done) => server.close(done));
  });
  const commands = [];
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const event = JSON.parse(raw.toString()); commands.push(event);
    if (event.type === "session.close") {
      socket.send(JSON.stringify({ type: "session.closed", usage: { seconds: 12 } }));
      if (options.closeSocketOnAck) socket.close();
    }
    else if (options.respond?.(event, socket)) return;
    else if (!options.dropAcks) socket.send(JSON.stringify({ type: `${event.type}ed` }));
  }));
  let stored;
  let posts = 0;
  const creates = [];
  const store = {
    load: () => structuredClone(stored),
    save: async (record) => {
      if (options.failSave) throw new Error("Disk unavailable");
      if (record.status === "closed" && options.slowClosedSave) await new Promise((done) => setTimeout(done, 40));
      stored = structuredClone(record);
    },
  };
  const transport = {
    ...(options.now ? { now: options.now } : {}),
    credential: { getToken: async () => ({ token: "synthetic-fixture-not-a-real-credential", expiresOnTimestamp: Date.now() + 10000 }) },
    fetch: async (_url, request) => {
      posts++;
      creates.push(JSON.parse(request.body));
      if (options.creationError) throw new Error("Simulated accepted-but-lost response");
      if (options.creationStatus) return new Response("Rejected", { status: options.creationStatus });
      return Response.json({ session: { id: `session-${posts}` }, transport: { sdp: "v=0\nanswer" } });
    },
    socket: () => new WebSocket(`ws://127.0.0.1:${server.address().port}`),
    acknowledgementTimeoutMs: options.ackTimeoutMs ?? (options.dropAcks ? 50 : 1000),
  };
  const live = new FoundryLive(options.config ?? config, store, transport);
  return { live, commands, server, store, transport, creates, posts: () => posts };
}

test("usage is recorded across restarts without a connection or seconds ceiling", async (t) => {
  const lab = await fixture(t);
  await lab.live.open({ sdp: "v=0\none" });
  await lab.live.close();
  assert.equal(lab.live.usage().seconds, 12);
  const restarted = new FoundryLive(config, lab.store, lab.transport);
  await restarted.initialize();
  assert.equal(restarted.usage().seconds, 12);
  for (const offer of ["two", "three"]) {
    await restarted.open({ sdp: `v=0\n${offer}` });
    await restarted.close();
  }
  assert.deepEqual({ ...restarted.usage(), month: null }, { month: null, timezone: "UTC", seconds: 36, connections: 3 });
  assert.equal(lab.posts(), 3);
});

test("a configured voice is sent at creation; without one the provider default applies", async (t) => {
  const voiced = await fixture(t, { config: { ...config, voice: "cedar" } });
  await voiced.live.open({ sdp: "v=0\none" });
  await voiced.live.close();
  assert.deepEqual(voiced.creates[0].session.audio, { output: { voice: "cedar" } });
  const plain = await fixture(t);
  await plain.live.open({ sdp: "v=0\none" });
  await plain.live.close();
  assert.equal("audio" in plain.creates[0].session, false);
});

test("failed state storage performs no Live POST and does not strand the connecting state", async (t) => {
  const lab = await fixture(t, { failSave: true });
  await assert.rejects(lab.live.open({ sdp: "v=0\none" }), { code: "storage-fault" });
  assert.equal(lab.posts(), 0);
  assert.equal(lab.live.diagnostics().state, "failed");
  await assert.rejects(lab.live.open({ sdp: "v=0\ntwo" }), { code: "storage-fault" });
});

test("provider socket close cannot overtake durable processing of the final acknowledgement", async (t) => {
  const lab = await fixture(t, { closeSocketOnAck: true, slowClosedSave: true });
  await lab.live.open({ sdp: "v=0\none" });
  await lab.live.close();
  assert.equal(lab.store.load().status, "closed");
  assert.equal(lab.store.load().usage.seconds, 12);
  assert.equal(lab.live.diagnostics().finalUsageKnown, true);
});

test("context uses commentary, or thinking when muted or silent, bound to session and delegation", async (t) => {
  const lab = await fixture(t);
  const { sessionId } = await lab.live.open({ sdp: "v=0\none" });
  assert.equal(lab.creates[0].session.instructions, config.instructions);
  assert.deepEqual(lab.creates[0].session.delegation, { type: "client" });
  await lab.live.appendContext({ sessionId, delegationId: "proposal", text: "User rejected the proposal." });
  await lab.live.appendContext({ sessionId, text: "Background summary.", silent: true });
  await lab.live.stopSpeaking();
  await lab.live.appendContext({ sessionId, delegationId: null, text: "Task state updated while muted." });
  assert.deepEqual(lab.commands.map((event) => [event.type, event.delegation_id]), [
    ["session.commentary.append", "proposal"], ["session.thinking.append", null], ["session.thinking.append", null],
  ]);
  await assert.rejects(lab.live.appendContext({ sessionId: "old", delegationId: null, text: "stale" }), { code: "live-unavailable" });
  await assert.rejects(lab.live.appendContext({ sessionId, text: "x".repeat(1201) }), { code: "invalid-context" });
  await lab.live.close();
});

test("concurrent creation performs one non-idempotent POST", async (t) => {
  const lab = await fixture(t);
  const first = lab.live.open({ sdp: "v=0\none" });
  await assert.rejects(lab.live.open({ sdp: "v=0\ntwo" }), { code: "live-unsettled" });
  await first;
  assert.equal(lab.posts(), 1);
  await lab.live.close();
});

test("a lost creation response remains blocked across restart and cannot report a confirmed close", async (t) => {
  const lab = await fixture(t, { creationError: true });
  await assert.rejects(lab.live.open({ sdp: "v=0\nlost" }), { code: "creation-uncertain", message: /without a response \(Error: Simulated accepted-but-lost response\)/ });
  const restarted = new FoundryLive(config, lab.store, lab.transport);
  assert.equal(restarted.diagnostics().error, "recovery-required");
  await assert.rejects(restarted.open({ sdp: "v=0\nretry" }), { code: "live-unsettled" });
  await assert.rejects(restarted.close(), { code: "close-unconfirmed" });
  assert.equal(lab.posts(), 1);
  assert.equal(lab.store.load().status, "uncertain");
});

test("a rejected creation is closed and counted as a connection without seconds", async (t) => {
  const lab = await fixture(t, { creationStatus: 400 });
  await assert.rejects(lab.live.open({ sdp: "v=0\nbad" }), { code: "http-400", message: /HTTP 400: Rejected/ });
  assert.equal(lab.store.load().status, "closed");
  assert.equal(lab.live.usage().connections, 1);
  assert.equal(lab.live.usage().seconds, 0);
});

test("unknown acknowledgements cannot be retried or correlated with a later append", async (t) => {
  const lab = await fixture(t, { dropAcks: true });
  const { sessionId } = await lab.live.open({ sdp: "v=0\none" });
  await assert.rejects(lab.live.appendContext({ sessionId, text: "first" }), { code: "acknowledgement-unknown" });
  for (const socket of lab.server.clients) socket.send(JSON.stringify({ type: "session.commentary.appended" }));
  await assert.rejects(lab.live.appendContext({ sessionId, text: "second" }), { code: "live-unavailable" });
  assert.equal(lab.commands.filter((event) => event.type === "session.commentary.append").length, 1);
  await lab.live.close();
});

test("closing interrupts a pending append instead of waiting out its acknowledgement", async (t) => {
  const lab = await fixture(t, { dropAcks: true, ackTimeoutMs: 30_000 });
  const { sessionId } = await lab.live.open({ sdp: "v=0\none" });
  const append = lab.live.appendContext({ sessionId, text: "pending" });
  const rejected = assert.rejects(append, { code: "acknowledgement-unknown" });
  await new Promise((done) => setTimeout(done, 20));
  const started = Date.now();
  await lab.live.close();
  await rejected;
  assert.ok(Date.now() - started < 1000);
  assert.equal(lab.store.load().status, "closed");
  assert.equal(lab.commands.filter((event) => event.type === "session.commentary.append").length, 1);
});

test("a persisted active session is closed by reattaching, never recreated", async (t) => {
  const lab = await fixture(t);
  await lab.live.open({ sdp: "v=0\none" });
  const restarted = new FoundryLive(config, lab.store, lab.transport);
  await assert.rejects(restarted.open({ sdp: "v=0\ntwo" }), { code: "live-unsettled" });
  await restarted.close();
  assert.equal(lab.posts(), 1);
  assert.equal(lab.store.load().status, "closed");
  await lab.live.close();
});

test("usage resets at the UTC month and a spanning session counts toward its starting month only", async (t) => {
  let now = Date.parse("2026-09-30T23:59:50Z");
  const lab = await fixture(t, { now: () => now });
  await lab.live.open({ sdp: "v=0\none" });
  now = Date.parse("2026-10-01T00:00:02Z");
  await lab.live.close();
  assert.deepEqual(lab.live.usage(), { month: "2026-10", timezone: "UTC", seconds: 0, connections: 0 });
  await lab.live.open({ sdp: "v=0\ntwo" });
  await lab.live.close();
  assert.deepEqual(lab.live.usage(), { month: "2026-10", timezone: "UTC", seconds: 12, connections: 1 });
});

test("cumulative usage updates never double count", async (t) => {
  const lab = await fixture(t);
  await lab.live.open({ sdp: "v=0\none" });
  const socket = [...lab.server.clients][0];
  socket.send(JSON.stringify({ type: "session.usage.updated", usage: { seconds: 6 } }));
  socket.send(JSON.stringify({ type: "session.usage.updated", usage: { seconds: 6 } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(lab.live.usage().seconds, 6);
  await lab.live.close();
  assert.equal(lab.live.usage().seconds, 12);
});

test("new delegations use fresh input and transcript paragraphs are only presentation boundaries", async (t) => {
  const lab = await fixture(t);
  await lab.live.open({ sdp: "v=0\none" });
  const observed = [];
  lab.live.subscribe(async (event) => { observed.push(event); });
  const socket = [...lab.server.clients][0];
  for (const event of [
    { type: "session.input_transcript.delta", delta: "Old task.", start_ms: 100, end_ms: 900 },
    { type: "session.delegation.created", delegation: { id: "old", target: "client" } },
    { type: "session.output_transcript.delta", delta: "First reply.", start_ms: 1000, end_ms: 2000 },
    { type: "session.input_transcript.delta", delta: "New task.", start_ms: 3000, end_ms: 4000 },
    { type: "session.delegation.created", delegation: { id: "new", target: "client" } },
    { type: "session.output_transcript.delta", delta: "Second reply.", start_ms: 5000, end_ms: 6000 },
  ]) socket.send(JSON.stringify(event));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(observed.filter((event) => event.kind === "delegation").map((event) => event.text), ["Old task.", "New task."]);
  assert.equal(lab.live.diagnostics().output, "First reply.\n\nSecond reply.");
  assert.equal(lab.live.diagnostics().input, "Old task.\n\nNew task.");
  assert.deepEqual(lab.live.diagnostics().turns, [
    { role: "user", text: "Old task." }, { role: "assistant", text: "First reply." },
    { role: "user", text: "New task." }, { role: "assistant", text: "Second reply." },
  ]);
  assert.match(observed.find((event) => event.kind === "delegation" && event.delegationId === "new").dialogue, /First reply/);
  await lab.live.close();
});

test("an overlapping assistant response does not split a caller's decision phrase", async (t) => {
  const lab = await fixture(t);
  await lab.live.open({ sdp: "v=0\none" });
  const observed = [];
  lab.live.subscribe(async (event) => observed.push(event));
  const socket = [...lab.server.clients][0];
  for (const event of [
    { type: "session.input_transcript.delta", delta: "批准", start_ms: 100, end_ms: 900 },
    { type: "session.output_transcript.delta", delta: "好的", start_ms: 950, end_ms: 1100 },
    { type: "session.input_transcript.delta", delta: " 1", start_ms: 1100, end_ms: 1400 },
    { type: "session.output_transcript.delta", delta: "，正在处理。", start_ms: 1200, end_ms: 2000 },
  ]) socket.send(JSON.stringify(event));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const inputs = observed.filter((event) => event.kind === "transcript");
  assert.equal(inputs[0].utteranceId, inputs[1].utteranceId);
  assert.equal(inputs[1].utterance, "批准 1");
  assert.equal(observed.at(-1).afterInput, true);
  // The display keeps the caller's phrase whole even though the reply started in the middle of it.
  assert.deepEqual(lab.live.diagnostics().turns, [{ role: "user", text: "批准 1" }, { role: "assistant", text: "好的，正在处理。" }]);
  await lab.live.close();
});

test("without timestamps, delegations and replies separate utterances and IDs never repeat", async (t) => {
  const lab = await fixture(t);
  await lab.live.open({ sdp: "v=0\none" });
  const observed = [];
  lab.live.subscribe(async (event) => observed.push(event));
  const socket = [...lab.server.clients][0];
  for (const event of [
    { type: "session.input_transcript.delta", delta: "批准 1" },
    { type: "session.delegation.created", delegation: { id: "first", target: "client" } },
    { type: "session.output_transcript.delta", delta: "好的" },
    { type: "session.output_transcript.delta", delta: "，已批准。" },
    { type: "session.input_transcript.delta", delta: "批准" },
    { type: "session.input_transcript.delta", delta: " 2" },
    { type: "session.output_transcript.delta", delta: "收到。" },
    { type: "session.input_transcript.delta", delta: "批准 3" },
  ]) socket.send(JSON.stringify(event));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const inputs = observed.filter((event) => event.kind === "transcript");
  assert.deepEqual(inputs.map((event) => [event.utteranceId, event.utterance]), [[1, "批准 1"], [2, "批准"], [2, "批准 2"], [3, "批准 3"]]);
  assert.equal(observed.find((event) => event.kind === "delegation").utteranceId, 1);
  // A reply that follows caller speech answers it in every delta, as with timestamps.
  assert.deepEqual(observed.filter((event) => event.kind === "output-transcript").map((event) => event.afterInput), [true, true, true]);
  assert.deepEqual(inputs.map((event) => event.startMs), [null, null, null, null]);
  await lab.live.close();
  // A reconnection starts new input but never reuses an earlier utterance ID.
  await lab.live.open({ sdp: "v=0\ntwo" });
  [...lab.server.clients].at(-1).send(JSON.stringify({ type: "session.input_transcript.delta", delta: "批准 4" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(observed.filter((event) => event.kind === "transcript").at(-1).utteranceId, 4);
  await lab.live.close();
});

test("timestamps on a per-item timebase fall back to delegation and reply boundaries", async (t) => {
  const lab = await fixture(t);
  await lab.live.open({ sdp: "v=0\none" });
  const observed = [];
  lab.live.subscribe(async (event) => observed.push(event));
  const socket = [...lab.server.clients][0];
  for (const event of [
    { type: "session.input_transcript.delta", delta: "批准 1", start_ms: 0, end_ms: 800 },
    { type: "session.output_transcript.delta", delta: "好的。", start_ms: 0, end_ms: 600 },
    // Each item counts from zero, so the next phrase seems to start before the last one ended.
    { type: "session.input_transcript.delta", delta: "批准", start_ms: 0, end_ms: 400 },
    { type: "session.input_transcript.delta", delta: " 2", start_ms: 400, end_ms: 700 },
    { type: "session.output_transcript.delta", delta: "收到。", start_ms: 0, end_ms: 300 },
  ]) socket.send(JSON.stringify(event));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const inputs = observed.filter((event) => event.kind === "transcript");
  assert.deepEqual(inputs.map((event) => [event.utteranceId, event.utterance]), [[1, "批准 1"], [2, "批准"], [2, "批准 2"]]);
  assert.equal(observed.at(-1).afterInput, true);
  assert.deepEqual(lab.live.diagnostics().turns, [
    { role: "user", text: "批准 1" }, { role: "assistant", text: "好的。" }, { role: "user", text: "批准 2" }, { role: "assistant", text: "收到。" },
  ]);
  await lab.live.close();
});

test("a provider error fails only the command in flight and is published with its code", async (t) => {
  let reject = true;
  const lab = await fixture(t, { respond: (event, socket) => {
    if (event.type !== "session.commentary.append" || !reject) return false;
    reject = false;
    socket.send(JSON.stringify({ type: "error", error: { code: "invalid_delegation_id" } }));
    return true;
  } });
  const { sessionId } = await lab.live.open({ sdp: "v=0\none" });
  const observed = [];
  lab.live.subscribe(async (event) => observed.push(event));
  const rejected = lab.live.appendContext({ sessionId, delegationId: "gone", text: "late answer" });
  const queued = lab.live.appendContext({ sessionId, text: "next update" });
  await assert.rejects(rejected, { code: "provider-error", message: /session\.commentary\.append \(invalid_delegation_id\)/ });
  await queued;
  assert.deepEqual(observed.filter((event) => event.kind === "error").map(({ code, command }) => ({ code, command })),
    [{ code: "invalid_delegation_id", command: "session.commentary.append" }]);
  // An error with nothing in flight is reported and fails nothing; the lane stays usable.
  [...lab.server.clients][0].send(JSON.stringify({ type: "error", error: {} }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(observed.filter((event) => event.kind === "error").at(-1).command, null);
  assert.equal(lab.live.diagnostics().error, "provider-error");
  await lab.live.appendContext({ sessionId, text: "still works" });
  assert.equal(lab.commands.filter((event) => event.type === "session.commentary.append").length, 3);
  await lab.live.close();
});

test("only the authorized Foundry HTTPS root is accepted", () => {
  for (const endpoint of ["http://fixture.openai.azure.com", "https://example.com", "https://fixture.openai.azure.com/path", "https://u:p@fixture.openai.azure.com"]) {
    assert.throws(() => new FoundryLive({ ...config, endpoint }, { load: () => undefined, save: async () => {} }));
  }
  assert.throws(() => new FoundryLive({ ...config, instructions: "" }, { load: () => undefined, save: async () => {} }), { code: "invalid-config" });
});
