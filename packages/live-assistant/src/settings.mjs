import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { JsonStore } from "./store.mjs";
import { intentDeployment, intentEffort } from "./assistant.mjs";
import { foundryOrigin } from "./foundry.mjs";

// Built-in voices published for GPT-Live (audio.output.voice) and for the speech API; the page offers them in a
// menu, and a stored custom voice ID (voice_...) is kept as an extra option.
export const liveVoices = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse",
  "quartz", "ripple", "vesper", "willow", "stone", "gleam", "meridian", "bossa", "tempo", "beacon", "delta", "cinder",
  "nuri", "juni", "flitz", "brise", "sillage", "nira", "harema", "shida", "noeul"];
export const ttsVoices = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"];

const name = z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/, "Use a deployment name of letters, digits, '.', '_' or '-'");
const voice = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Use a voice name or custom voice ID");
const path = z.string().trim().min(1).max(4096).refine(isAbsolute, "Use an absolute path");
const endpoint = z.union([z.literal(""), z.string().trim().max(200).refine((value) => {
  try { return Boolean(foundryOrigin(value)); } catch { return false; }
}, "Use the Foundry HTTPS root, such as https://<resource>.openai.azure.com/")]);
// Everything except the login password can be changed from the page; the password stays in the process environment.
// Each model names its own Foundry resource, so they may sit in different regions; one subscription selects the az login tenant.
export const settingsSchema = z.strictObject({
  subscription: z.string().trim().max(200),
  liveEndpoint: endpoint,
  liveDeployment: name,
  liveVoice: voice,
  ttsEndpoint: endpoint,
  ttsDeployment: name,
  ttsVoice: voice,
  intentEndpoint: endpoint,
  intentDeployment,
  intentEffort,
  workspace: path,
  roots: z.array(path).max(32),
  dshProfile: name,
  dshToken: z.boolean(),
  hooks: z.boolean(),
  verifyTimeout: z.number().positive().max(86400),
  uploadMb: z.number().positive().max(1024 * 1024),
});
export const voiceName = voice;
export const settingsPatch = z.partialRecord(z.enum(Object.keys(settingsSchema.shape)), z.unknown());

// Page overrides live in <state>/settings.json above the environment defaults; null removes an override.
export class Settings {
  constructor(directory, defaults) {
    this.defaults = settingsSchema.parse(defaults);
    this.store = new JsonStore(join(directory, "settings.json"), {});
    // A stored value that no longer validates is ignored (and reported) instead of keeping the backend from starting.
    this.ignored = [];
    for (const [key, value] of Object.entries(this.store.value)) {
      if (!settingsSchema.shape[key]?.safeParse(value).success) { delete this.store.value[key]; this.ignored.push(key); }
    }
    this.values = settingsSchema.parse({ ...this.defaults, ...this.store.value });
  }
  merge(patch) {
    try { return this.#merge(patch); }
    catch (error) {
      // The page shows which field is wrong and why, instead of a generic invalid-request error.
      if (error instanceof z.ZodError) throw Object.assign(new Error(error.issues.map((issue) => `${issue.path.join(".") || "settings"}: ${issue.message}`).join("; ")), { status: 400 });
      throw error;
    }
  }
  #merge(patch) {
    const overrides = { ...this.store.value };
    for (const [key, value] of Object.entries(settingsPatch.parse(patch))) {
      if (value === null) delete overrides[key]; else overrides[key] = value;
    }
    const values = settingsSchema.parse({ ...this.defaults, ...overrides });
    // An override equal to its default is dropped so later environment changes apply again.
    for (const key of Object.keys(overrides)) {
      if (JSON.stringify(values[key]) === JSON.stringify(this.defaults[key])) delete overrides[key]; else overrides[key] = values[key];
    }
    return { values, overrides };
  }
  commit({ values, overrides }) {
    this.store.value = overrides; this.store.save();
    this.values = values;
  }
  overridden() { return Object.keys(this.store.value); }
  view() {
    return { values: this.values, defaults: this.defaults, overridden: this.overridden(), ignored: this.ignored, liveVoices, ttsVoices };
  }
}
