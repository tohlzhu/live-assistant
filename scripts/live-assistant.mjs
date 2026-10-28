import { delimiter, resolve } from "node:path";
import { startAssistant } from "../packages/live-assistant/src/server.mjs";

const directory = resolve(process.env.LIVE_ASSISTANT_STATE ?? ".live-assistant");
const workspace = resolve(process.env.LIVE_ASSISTANT_WORKSPACE ?? `${directory}/workspace`);
// Sessions may start in the workspace or below any of these roots (PATH-style list).
const roots = (process.env.LIVE_ASSISTANT_ROOTS ?? "").split(delimiter).filter(Boolean).map((root) => resolve(root));
// Everything but the password is only a default here: the page's settings dialog overrides it without a restart.
const app = await startAssistant({
  directory, workspace, roots, password: process.env.LIVE_ASSISTANT_PASSWORD,
  port: Number(process.env.LIVE_ASSISTANT_PORT ?? 8787),
  ...(process.env.LIVE_ASSISTANT_UPLOAD_MB ? { uploadLimit: Number(process.env.LIVE_ASSISTANT_UPLOAD_MB) * 1024 * 1024 } : {}),
  ...(process.env.LIVE_ASSISTANT_VERIFY_TIMEOUT ? { verifyTimeout: Number(process.env.LIVE_ASSISTANT_VERIFY_TIMEOUT) * 1000 } : {}),
  ...(process.env.LIVE_ASSISTANT_ORIGIN ? { origin: process.env.LIVE_ASSISTANT_ORIGIN } : {}),
  harness: {
    dshProfile: process.env.LIVE_ASSISTANT_DSH_PROFILE ?? "dsh-tui",
    dshToken: process.env.LIVE_ASSISTANT_DSH_FOUNDRY_TOKEN === "1",
    hooks: process.env.LIVE_ASSISTANT_HOOKS !== "0",
  },
  // Each model names its own Foundry resource, so they may sit in different regions.
  foundry: {
    subscription: process.env.AZURE_SUBSCRIPTION_NAME ?? "",
    liveEndpoint: process.env.FOUNDRY_LIVE_ENDPOINT ?? "",
    deployment: process.env.FOUNDRY_LIVE_DEPLOYMENT ?? "gpt-live-1", voice: process.env.FOUNDRY_LIVE_VOICE ?? "marin",
    ttsEndpoint: process.env.FOUNDRY_TTS_ENDPOINT ?? "",
    ttsDeployment: process.env.FOUNDRY_TTS_DEPLOYMENT ?? "gpt-4o-mini-tts", ttsVoice: process.env.FOUNDRY_TTS_VOICE ?? "alloy",
    intentEndpoint: process.env.FOUNDRY_INTENT_ENDPOINT ?? "",
    intentDeployment: process.env.FOUNDRY_INTENT_DEPLOYMENT ?? "gpt-6.1-sol",
    intentEffort: process.env.FOUNDRY_INTENT_EFFORT ?? "low",
  },
});
console.log(`live assistant is listening at ${app.origin}. Login credentials are not logged. Web shutdown leaves terminal sessions running.`);
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  void app.close().catch((error) => { console.error(`Shutdown incomplete: ${error.message}`); process.exitCode = 1; });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
