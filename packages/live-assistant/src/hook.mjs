#!/usr/bin/env node
// Native PermissionRequest hook for Claude Code and Codex. It forwards the request to the live assistant
// over a local socket and waits for the human decision. Any failure abstains silently so the native prompt appears.
import { connect } from "node:net";

const socketPath = process.env.LIVE_HOOK_SOCKET;
const sessionId = process.env.LIVE_SESSION_ID;

function abstain() { process.exit(0); }

async function main() {
  if (!socketPath || !sessionId) abstain();
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try { payload = JSON.parse(raw); } catch { abstain(); }
  const socket = connect(socketPath);
  socket.setEncoding("utf8");
  socket.on("error", abstain);
  socket.on("connect", () => socket.write(`${JSON.stringify({
    sessionId, event: payload.hook_event_name ?? "PermissionRequest",
    tool: payload.tool_name ?? "", input: payload.tool_input ?? {},
  })}\n`));
  let reply = "";
  socket.on("data", (chunk) => {
    reply += chunk;
    const newline = reply.indexOf("\n");
    if (newline === -1) return;
    let decision;
    try { decision = JSON.parse(reply.slice(0, newline)); } catch { abstain(); }
    socket.end();
    if (decision.behavior !== "allow" && decision.behavior !== "deny") abstain();
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: decision.behavior === "deny" ? { behavior: "deny", message: decision.message ?? "Rejected by the user in live assistant." } : { behavior: "allow" },
    } }));
    process.exit(0);
  });
  socket.on("close", abstain);
}

main().catch(abstain);
