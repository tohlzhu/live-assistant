import WebSocket from "ws";
import { z } from "zod";
import { foundryCredential, foundryOrigin, audience } from "./foundry.mjs";
import { redact } from "./text.mjs";

const creationSchema = z.object({
  session: z.object({ id: z.string().min(1) }),
  transport: z.object({ sdp: z.string().min(1) }),
});
const eventSchema = z.object({ type: z.string() }).passthrough();
const recordSchema = z.object({
  status: z.enum(["closed", "creating", "active", "uncertain"]),
  sessionId: z.string().nullable(),
  sessionSeconds: z.number().nonnegative(),
  sessionMonth: z.string().nullable(),
  finalUsageKnown: z.boolean(),
  unknownFinalUsageSessions: z.number().int().nonnegative(),
  usage: z.object({ month: z.string(), seconds: z.number().nonnegative(), connections: z.number().int().nonnegative() }),
});

export class LiveError extends Error {
  constructor(code, message, options) { super(message, options); this.code = code; }
}

/**
 * GPT-Live over WebRTC with a trusted Sideband observer.
 * The provider POST is not idempotent, so an uncertain creation is recorded and never retried; usage is
 * recorded for display only, because the human decides when to disconnect.
 */
export class FoundryLive {
  #socket;
  #listeners = new Set();
  #waits = new Map();
  #commands = Promise.resolve();
  #received = Promise.resolve();
  #writes = Promise.resolve();
  #closing;
  #poisoned = false;
  #muted = false;
  #storageFailed = false;
  #inputCursor = 0;
  #inputBoundary = 0;
  #lastInputEnd = 0;
  #lastOutputEnd = 0;
  #outputBreak = false;
  // Utterance IDs only grow, so an ID never names two utterances, even across compaction or reconnection.
  #utterance = 0;
  #consumed = false;
  #replied = false;
  #answering = false;
  #clock = true;
  #inputTurn = null;
  #outputTurn = null;
  #dialogue = [];
  #record;
  #info = {
    state: "disconnected", preview: false, sessionId: null, seconds: 0, finalUsageKnown: true, error: null,
    input: "", output: "", turns: [], outputVersion: 0, delegations: [], eventCounts: {}, transportStatus: null,
  };

  /**
   * @param {{ endpoint: string, deployment: string, instructions: string, voice?: string, subscription?: string }} config
   * @param {{ load(): unknown, save(record: unknown): Promise<void> }} store
   * @param {{ credential?: { getToken(scope: string): Promise<{ token: string }> }, fetch?: typeof fetch,
   *   socket?: (url: string, options: object) => WebSocket, acknowledgementTimeoutMs?: number, now?: () => number }} [transport]
   */
  constructor(config, store, transport = {}) {
    if (!config.instructions) throw new LiveError("invalid-config", "Live instructions are required");
    this.config = config;
    this.store = store;
    this.transport = transport;
    this.#target(config);
    const stored = store.load();
    this.#record = stored ? recordSchema.parse(stored) : {
      status: "closed", sessionId: null, sessionSeconds: 0, sessionMonth: null, finalUsageKnown: true,
      unknownFinalUsageSessions: 0, usage: { month: this.#month(), seconds: 0, connections: 0 },
    };
    this.#info.sessionId = this.#record.sessionId;
    this.#info.seconds = this.#record.sessionSeconds;
    this.#info.finalUsageKnown = this.#record.finalUsageKnown;
    if (this.#record.status !== "closed") { this.#info.state = "degraded"; this.#info.error = "recovery-required"; }
  }

  // Without an endpoint Live is disabled until one is configured.
  #target({ endpoint, subscription }) {
    this.endpoint = endpoint ? foundryOrigin(endpoint) : null;
    this.credential = this.transport.credential ?? foundryCredential(subscription);
  }
  /** Deployment and voice apply from the next connection; the endpoint and subscription only change while closed. */
  reconfigure(config) {
    const next = { ...this.config, ...config };
    if (next.endpoint !== this.config.endpoint || next.subscription !== this.config.subscription) {
      if (this.#record.status !== "closed" || ["connecting", "closing"].includes(this.#info.state) || this.#closing) {
        throw new LiveError("live-unsettled", "Disconnect voice before changing the Foundry endpoint or subscription");
      }
      this.#target(next);
    }
    this.config = next;
  }
  #now() { return this.transport.now?.() ?? Date.now(); }
  #month() { return new Date(this.#now()).toISOString().slice(0, 7); }
  #rollMonth() {
    const month = this.#month();
    if (this.#record.usage.month !== month) this.#record.usage = { month, seconds: 0, connections: 0 };
  }
  async initialize() { await this.#persist(); }
  #persist() {
    const snapshot = structuredClone(this.#record);
    const write = this.#writes.then(async () => {
      if (this.#storageFailed) throw new LiveError("storage-fault", "Live state storage requires recovery");
      try { await this.store.save(snapshot); }
      catch (cause) { this.#storageFailed = true; throw new LiveError("storage-fault", "Live state write failed", { cause }); }
    });
    this.#writes = write.then(() => {}, () => {});
    return write;
  }

  usage() {
    this.#rollMonth();
    const current = this.#record.status !== "closed" && this.#record.sessionMonth === this.#record.usage.month ? this.#record.sessionSeconds : 0;
    return { month: this.#record.usage.month, timezone: "UTC", seconds: this.#record.usage.seconds + current, connections: this.#record.usage.connections };
  }
  diagnostics() {
    const disabled = !this.endpoint && this.#record.status === "closed" && this.#info.state === "disconnected";
    return structuredClone({
      ...this.#info, ...(disabled ? { state: "disabled", error: "Foundry configuration is required" } : {}), closeConfirmed: this.#record.status === "closed",
      unknownFinalUsageSessions: this.#record.unknownFinalUsageSessions,
    });
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  #publish(event) {
    for (const listener of this.#listeners) {
      void listener(event).catch(() => {
        this.#info.state = "failed"; this.#info.error = "observer-failed"; this.#socket?.close();
      });
    }
  }
  #settle(seconds) {
    this.#rollMonth();
    if (this.#record.sessionMonth === this.#record.usage.month) this.#record.usage.seconds += seconds;
  }

  /**
   * @param {{ sdp: string }} offer
   * @param {{ voice?: string, instructions?: string, preview?: boolean }} [options] a preview session plays one voice
   *   sample with its own instructions; the assistant does not treat it as a conversation.
   */
  async open(offer, { voice = this.config.voice, instructions = this.config.instructions, preview = false } = {}) {
    if (!offer?.sdp?.startsWith("v=0") || offer.sdp.length > 64 * 1024) throw new LiveError("invalid-sdp", "A bounded browser SDP offer is required");
    if (!this.endpoint) throw new LiveError("not-configured", "Set the Foundry endpoint in settings first");
    if (this.#record.status !== "closed" || this.#info.state === "connecting" || this.#closing) {
      throw new LiveError("live-unsettled", "Close or reconcile the existing provider session before creating another");
    }
    if (this.#storageFailed) throw new LiveError("storage-fault", "Live state storage requires recovery");
    this.#info = { ...this.#info, state: "connecting", preview, sessionId: null, seconds: 0, finalUsageKnown: false, error: null, input: "", output: "", turns: [], outputVersion: 0, delegations: [], eventCounts: {}, transportStatus: null };
    let token;
    try { token = await this.credential.getToken(audience); }
    catch {
      this.#info.state = "failed"; this.#info.error = "credential-unavailable";
      throw new LiveError("credential-unavailable", "Unable to obtain an Entra credential; verify the selected subscription and native login");
    }
    this.#rollMonth();
    const previous = structuredClone(this.#record);
    this.#record = { ...this.#record, status: "creating", sessionId: null, sessionSeconds: 0, sessionMonth: this.#month(), finalUsageKnown: false };
    this.#record.usage = { ...this.#record.usage, connections: this.#record.usage.connections + 1 };
    this.#inputCursor = 0; this.#inputBoundary = 0; this.#lastInputEnd = 0; this.#lastOutputEnd = 0; this.#outputBreak = false;
    this.#consumed = false; this.#replied = false; this.#answering = false; this.#clock = true;
    this.#inputTurn = null; this.#outputTurn = null;
    this.#dialogue = [];
    try { await this.#persist(); }
    catch (error) {
      // Nothing was sent to the provider, so the previous settled record is still the truth.
      this.#record = previous;
      this.#info.state = "failed"; this.#info.error = "storage-fault";
      throw error;
    }
    this.#poisoned = false;
    let response;
    try {
      response = await (this.transport.fetch ?? fetch)(`${this.endpoint}/openai/v1/live/sessions`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          session: {
            model: this.config.deployment, instructions,
            // The voice is fixed at creation; without one the provider default (marin) speaks.
            ...(voice ? { audio: { output: { voice } } } : {}),
            delegation: { type: "client" },
          },
          transport: { type: "webrtc", sdp: offer.sdp },
        }),
      });
    } catch (error) {
      // No retry: a timed-out non-idempotent POST can leave a billable session.
      this.#info.state = "failed"; this.#info.error = "creation-uncertain";
      this.#record.status = "uncertain";
      await this.#persist();
      const reason = [error?.name, error?.cause?.code ?? error?.message].filter(Boolean).join(": ");
      throw new LiveError("creation-uncertain", `Live creation failed without a response (${reason}); possible billable session, automatic recreation disabled`);
    }
    if (!response.ok) {
      this.#info.state = "failed"; this.#info.error = `http-${response.status}`;
      const detail = redact((await response.text().catch(() => "")).slice(0, 300));
      this.#record.status = response.status >= 400 && response.status < 500 ? "closed" : "uncertain";
      if (this.#record.status === "closed") { this.#record.finalUsageKnown = true; this.#info.finalUsageKnown = true; }
      await this.#persist();
      throw new LiveError(this.#info.error, `Foundry rejected Live creation (HTTP ${response.status}${detail ? `: ${detail}` : ""}); check deployment, audience, tenant and RBAC`);
    }
    let resource;
    try { resource = creationSchema.parse(await response.json()); }
    catch {
      this.#record.status = "uncertain"; this.#info.state = "failed"; this.#info.error = "creation-uncertain";
      await this.#persist();
      throw new LiveError("creation-uncertain", "Provider returned an unreadable creation response; automatic recreation is disabled");
    }
    this.#info.sessionId = resource.session.id;
    this.#record.sessionId = resource.session.id; this.#record.status = "active";
    await this.#persist();
    try {
      await this.#attach(token.token);
      this.#info.state = "active";
      this.#muted = false;
      return { sessionId: resource.session.id, sdp: resource.transport.sdp };
    } catch (error) {
      this.#info.state = "degraded"; this.#info.error = "sideband-attach-failed";
      throw error;
    }
  }

  async #attach(token) {
    const url = `${this.endpoint.replace("https:", "wss:")}/openai/v1/live/sessions/${encodeURIComponent(this.#info.sessionId ?? "")}/attach`;
    const options = { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 15_000, maxPayload: 1024 * 1024 };
    const socket = (this.transport.socket ?? ((target, settings) => new WebSocket(target, settings)))(url, options);
    this.#socket = socket;
    socket.on("message", (raw) => {
      this.#received = this.#received.then(async () => {
        if (this.#socket !== socket) return;
        await this.#receive(JSON.parse(raw.toString()));
      }).catch(() => {
        this.#info.error = "provider-event-or-storage-failure"; this.#info.state = "degraded"; socket.close();
        this.#publish({ kind: "error", sessionId: this.#info.sessionId ?? "", code: this.#info.error });
      });
    });
    socket.on("error", (error) => {
      if (this.#socket !== socket) return;
      this.#info.error = "sideband-transport-error";
      const status = /Unexpected server response: (\d{3})/.exec(error.message)?.[1];
      this.#info.transportStatus = status ? Number(status) : null;
    });
    socket.on("close", () => {
      // The provider may close immediately after its final frame; finish durable processing first.
      this.#received = this.#received.then(() => {
        if (this.#socket !== socket) return;
        for (const waiter of this.#waits.values()) { clearTimeout(waiter.timer); waiter.reject(new LiveError("sideband-closed", "Sideband closed before acknowledgement")); }
        this.#waits.clear();
        if (this.#record.status !== "closed" && this.#info.state !== "failed") this.#info.state = "degraded";
        this.#publish({ kind: "disconnected", sessionId: this.#info.sessionId ?? "" });
      });
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(new LiveError("sideband-unavailable", "Unable to attach the trusted Sideband observer")));
    });
  }

  async #receive(value) {
    const event = eventSchema.parse(value);
    this.#info.eventCounts[event.type] = (this.#info.eventCounts[event.type] ?? 0) + 1;
    const sessionId = this.#info.sessionId ?? "";
    if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
      const text = z.string().max(8000).parse(event.delta);
      const input = event.type === "session.input_transcript.delta";
      const start = typeof event.start_ms === "number" ? event.start_ms : undefined;
      const end = typeof event.end_ms === "number" ? event.end_ms : undefined;
      // Timestamps are trusted only while they move forward on one clock. A jump back means a per-item timebase;
      // from then on, and whenever timestamps are missing, delegations and assistant replies are the boundaries.
      const backwards = start !== undefined && start + 250 < (input ? this.#lastInputEnd : this.#lastOutputEnd);
      if (backwards) this.#clock = false;
      const timed = start !== undefined && this.#clock;
      let afterInput = false;
      if (input) {
        // A delegation consumed everything said so far, so whatever follows is a new request.
        if (!this.#info.input || this.#consumed || backwards || (timed ? start - this.#lastInputEnd >= 1500 : this.#replied)) {
          if (this.#info.input) this.#info.input += "\n\n";
          this.#inputBoundary = this.#info.input.length;
          this.#utterance++; this.#consumed = false;
          this.#outputBreak = true;
          this.#info.turns.push(this.#inputTurn = { role: "user", text: "" });
        }
        this.#info.input += text; this.#inputTurn.text += text;
        this.#lastInputEnd = end ?? this.#lastInputEnd; this.#replied = false;
      } else {
        const at = end ?? start;
        // Without a usable clock, a reply that begins after caller speech answers it until the caller speaks again.
        if (!this.#replied) this.#answering = Boolean(this.#info.input);
        afterInput = at !== undefined && this.#clock && this.#lastInputEnd > 0 ? at >= this.#lastInputEnd : this.#answering;
        const paragraph = !this.#info.output || this.#outputBreak || (timed && start - this.#lastOutputEnd >= 1500);
        if (this.#info.output && paragraph) this.#info.output += "\n\n";
        if (paragraph) this.#info.turns.push(this.#outputTurn = { role: "assistant", text: "" });
        this.#info.output += text; this.#outputTurn.text += text; this.#info.outputVersion++;
        this.#lastOutputEnd = end ?? this.#lastOutputEnd; this.#outputBreak = false; this.#replied = true;
      }
      const role = input ? "user" : "assistant";
      const last = this.#dialogue.at(-1);
      if (last?.role === role) last.text += text;
      else this.#dialogue.push({ role, text });
      this.#compactTranscript();
      const timing = { startMs: start ?? null, endMs: end ?? null };
      if (input) this.#publish({ kind: "transcript", sessionId, text, ...timing,
        utterance: this.#info.input.slice(Math.max(this.#inputCursor, this.#inputBoundary)).trim(), utteranceId: this.#utterance });
      else this.#publish({ kind: "output-transcript", sessionId, text, ...timing, afterInput });
    } else if (event.type === "session.delegation.created") {
      const delegation = z.object({ id: z.string().max(160), target: z.literal("client") }).parse(event.delegation);
      if (!this.#info.delegations.includes(delegation.id)) {
        this.#info.delegations.push(delegation.id);
        const text = this.#info.input.slice(Math.max(this.#inputCursor, this.#inputBoundary)).trim();
        this.#inputCursor = this.#info.input.length; this.#consumed = true;
        this.#publish({ kind: "delegation", sessionId, delegationId: delegation.id, utteranceId: this.#utterance, text, dialogue: this.#recentDialogue(24_000) });
      }
    } else if (event.type === "session.usage.updated" || event.type === "session.closed") {
      const usage = z.object({ seconds: z.number().nonnegative() }).parse(event.usage);
      this.#info.seconds = Math.max(this.#info.seconds, usage.seconds);
      this.#record.sessionSeconds = this.#info.seconds;
      if (event.type === "session.closed") {
        if (!this.#record.finalUsageKnown) this.#settle(this.#info.seconds);
        this.#info.finalUsageKnown = true;
        this.#info.state = "disconnected";
        this.#record.finalUsageKnown = true; this.#record.status = "closed";
        this.#info.closeReason = typeof event.reason === "string" ? event.reason : "unknown";
      }
      await this.#persist();
    } else if (event.type === "session.started") {
      const session = z.object({ expires_at: z.number().optional() }).parse(event.session);
      if (session.expires_at) this.#info.expiresAt = session.expires_at;
    } else if (event.type === "error") {
      const detail = z.object({ code: z.string().optional() }).parse(event.error);
      this.#info.error = (detail.code ?? "provider-error").slice(0, 120);
      // The error carries no command ID. Control events are serialized, so it can only be about the one in flight;
      // with none in flight it is reported without failing anything.
      const [expected, waiter] = [...this.#waits].at(-1) ?? [];
      this.#publish({ kind: "error", sessionId, code: this.#info.error, command: waiter?.type ?? null });
      if (waiter) {
        clearTimeout(waiter.timer); this.#waits.delete(expected);
        waiter.reject(new LiveError("provider-error", `Provider rejected ${waiter.type} (${this.#info.error})`));
      }
    }
    const waiter = this.#waits.get(event.type);
    if (waiter) { clearTimeout(waiter.timer); this.#waits.delete(event.type); waiter.resolve(); }
  }

  // Long conversations keep only a recent transcript window; the assistant owns longer-term summaries.
  #compactTranscript() {
    const keep = 32_000;
    if (this.#info.input.length > keep) {
      const cut = this.#info.input.length - keep / 2;
      this.#info.input = this.#info.input.slice(cut);
      this.#inputCursor = Math.max(0, this.#inputCursor - cut);
      this.#inputBoundary = Math.max(0, this.#inputBoundary - cut);
    }
    if (this.#info.output.length > keep) this.#info.output = this.#info.output.slice(this.#info.output.length - keep / 2);
    // A trimmed turn may still receive the rest of its utterance; it is simply no longer shown.
    let shown = this.#info.turns.reduce((sum, turn) => sum + turn.text.length, 0);
    while (this.#info.turns.length > 200 || shown > keep) shown -= this.#info.turns.shift().text.length;
    if (this.#dialogue.length > 200) this.#dialogue = this.#dialogue.slice(-100);
  }
  #recentDialogue(limit) {
    const turns = [];
    for (let i = this.#dialogue.length - 1; i >= 0 && turns.length < 20; i--) {
      const turn = this.#dialogue[i];
      const text = turn.text.length > limit / 2 ? `…${turn.text.slice(-(limit / 2))}` : turn.text;
      if (JSON.stringify([{ role: turn.role, text }, ...turns]).length > limit) break;
      turns.unshift({ role: turn.role, text });
    }
    return JSON.stringify(turns);
  }

  #command(type, expected, fields = {}, sessionId = this.#info.sessionId) {
    const pending = this.#commands.then(async () => {
      if (sessionId !== this.#info.sessionId) throw new LiveError("stale-binding", "Context belongs to a previous Live session");
      if (this.#poisoned && type !== "session.close") throw new LiveError("acknowledgement-unknown", "Only session close is allowed after an uncertain acknowledgement");
      if (this.#socket?.readyState !== WebSocket.OPEN) throw new LiveError("sideband-unavailable", "Trusted control stream is not connected");
      // An append can be acknowledged only after the model finishes speaking, so it gets a longer window than close.
      const acknowledged = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#waits.delete(expected);
          this.#info.error = "acknowledgement-unknown"; this.#info.state = "degraded";
          this.#poisoned = true;
          reject(new LiveError("acknowledgement-unknown", "Provider acknowledgement timed out; do not retry the append"));
        }, this.transport.acknowledgementTimeoutMs ?? (type === "session.close" ? 10_000 : 60_000));
        this.#waits.set(expected, { type, resolve, reject, timer });
      });
      this.#socket.send(JSON.stringify({ type, ...fields }));
      await acknowledged;
    });
    this.#commands = pending.then(() => {}, () => {});
    return pending;
  }

  async stopSpeaking() { this.#muted = true; }
  async resumeSpeaking() { this.#muted = false; }
  async appendContext(context) {
    if (context.sessionId !== this.#info.sessionId || this.#info.state !== "active") {
      throw new LiveError("live-unavailable", "Live context targets an inactive session");
    }
    if (!context.text || context.text.length > 1200) throw new LiveError("invalid-context", "Live context must be a bounded application update");
    const channel = context.silent || this.#muted ? "thinking" : "commentary";
    await this.#command(`session.${channel}.append`, `session.${channel}.appended`,
      { content: context.text, delegation_id: context.delegationId ?? null }, context.sessionId);
  }
  async close() {
    if (this.#closing) return this.#closing;
    const operation = this.#closeProvider();
    this.#closing = operation;
    try { await operation; } finally { this.#closing = undefined; }
  }

  async #closeProvider() {
    if (this.#record.status === "closed") { this.#socket?.close(); return; }
    if (!this.#info.sessionId) throw new LiveError("close-unconfirmed", "Creation outcome is unknown and no provider session ID is available");
    this.#info.state = "closing";
    try {
      if (this.#socket?.readyState !== WebSocket.OPEN) {
        const token = await this.credential.getToken(audience);
        await this.#attach(token.token);
      }
      // Closing must not wait out a pending append; that append's outcome becomes unknown.
      for (const [expected, waiter] of this.#waits) {
        clearTimeout(waiter.timer); this.#waits.delete(expected); this.#poisoned = true;
        waiter.reject(new LiveError("acknowledgement-unknown", "Session close interrupted a pending acknowledgement; do not retry the append"));
      }
      await this.#command("session.close", "session.closed");
    } catch (error) {
      if (this.#info.transportStatus !== 404 && this.#info.transportStatus !== 410) throw error;
      // A previously recorded resource is now absent. This proves absence, not final usage.
      this.#record.status = "closed";
      this.#record.unknownFinalUsageSessions++;
      this.#info.state = "disconnected";
      this.#info.error = "final-usage-unavailable";
      await this.#persist();
    } finally {
      this.#socket?.close();
      if (this.#record.status !== "closed") { this.#info.state = "failed"; this.#info.error = "close-unconfirmed"; }
    }
  }
}
