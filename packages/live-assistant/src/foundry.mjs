import { AzureCliCredential } from "@azure/identity";
import { redact } from "./text.mjs";

export const audience = "https://cognitiveservices.azure.com/.default";

export function foundryOrigin(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".openai.azure.com") || url.pathname !== "/"
    || url.username || url.password || url.search || url.hash) throw new Error("Use the authorized Foundry HTTPS root");
  return url.origin;
}

export function foundryCredential(subscription) {
  return new AzureCliCredential(subscription ? { subscription } : {});
}

// Text-to-speech through the Foundry OpenAI v1 route with an Entra bearer token.
export function createSpeech({
  endpoint, subscription, deployment = "gpt-4o-mini-tts", voice: defaultVoice = "alloy", credential = foundryCredential(subscription), fetch: request = fetch,
}) {
  const origin = foundryOrigin(endpoint);
  return async (text, { voice = defaultVoice, format = "mp3", instructions = "用自然、简洁的普通话播报。" } = {}) => {
    const input = String(text).trim();
    if (!input) throw new Error("Speech text is empty");
    const token = await credential.getToken(audience);
    const response = await request(`${origin}/openai/v1/audio/speech`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: deployment, input, voice, response_format: format, instructions }),
    });
    if (!response.ok) throw new Error(`Speech HTTP ${response.status}: ${redact((await response.text()).slice(0, 300))}`);
    return { type: response.headers.get("content-type") ?? (format === "wav" ? "audio/wav" : "audio/mpeg"), data: Buffer.from(await response.arrayBuffer()) };
  };
}
