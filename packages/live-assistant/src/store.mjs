import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, appendFileSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";

export class JsonStore {
  constructor(file, initial) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { this.value = JSON.parse(readFileSync(file, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw new Error("State is unreadable; refusing to overwrite it", { cause: error });
      this.value = structuredClone(initial);
    }
    this.failed = false;
  }
  save() {
    if (this.failed) throw new Error("State storage requires recovery");
    try {
      writeFileSync(`${this.file}.pending`, JSON.stringify(this.value), { mode: 0o600 });
      const fd = openSync(`${this.file}.pending`, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(`${this.file}.pending`, this.file);
      const directory = openSync(dirname(this.file), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (cause) {
      this.failed = true;
      throw new Error("Durable state write failed; further mutations are blocked", { cause });
    }
  }
}

// One backend per state directory. The lock is a Linux abstract-namespace socket named after the directory's real
// path: binding is atomic and the kernel frees it when the process exits, so there is no stale file and no PID reuse.
export async function lockDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(realpathSync(directory)).digest("hex").slice(0, 40);
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise((done, fail) => { server.once("error", fail); server.listen(`\0live-assistant-state-${key}`, done); });
  } catch (error) {
    if (error.code === "EADDRINUSE") throw new Error(`State directory ${directory} is already used by another live assistant backend`);
    throw error;
  }
  server.unref();
  return { release: () => new Promise((done) => server.close(() => done())) };
}

export class Serial {
  tail = Promise.resolve();
  run(action) {
    const result = this.tail.then(action);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

// Errors carry an HTTP status so the server can distinguish missing targets from stale decisions.
export function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

// With a `limit` the log rolls over to `<file>.1` once it would exceed that many bytes, so a diagnostic log stays bounded.
export class EventLog {
  constructor(file, { limit = Infinity } = {}) {
    this.file = file; this.limit = limit;
    try { this.size = statSync(file).size; } catch { this.size = 0; }
  }
  append(entry) {
    const line = `${JSON.stringify({ at: Date.now(), ...entry })}\n`;
    if (this.size > 0 && this.size + Buffer.byteLength(line) > this.limit) { renameSync(this.file, `${this.file}.1`); this.size = 0; }
    appendFileSync(this.file, line, { mode: 0o600 });
    this.size += Buffer.byteLength(line);
  }
}
