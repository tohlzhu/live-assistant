/* global Terminal, FitAddon */
"use strict";
const $ = (id) => document.getElementById(id);
let focusOnAttach = null, ws, terminal, fit, focused = localStorage.getItem("live-focus"), owner = false, current, snapshotReady = false, lastSize = "", attached = null, attaching = false, pendingOutput = [];
let pc, stream, muted = false, micMuted = false, connecting = false, previewing = false;
let seenProposals = null, speechQueue = Promise.resolve(), verifying = null, dismissed = null, held = false, errorSource = null, focusRequest = 0;
// Banners never cover decision cards (those sit above them). A backend banner follows assistant.error and an
// attachment banner clears once the terminal is attached, so stale errors do not linger.
const fail = (error, source = "local") => { $("error-text").textContent = error.message; $("error").hidden = false; errorSource = source; };
const clearError = (source) => { if (errorSource === source) { $("error").hidden = true; errorSource = null; } };
const keyboard = () => {
  $("claim").textContent = owner ? "交还键盘" : "接管键盘";
  $("claim").setAttribute("aria-pressed", String(owner));
};
// One-shot "select and copy": the next drag only selects text and copies on release. While it is armed every mouse
// event over the terminal stops here, so xterm emits no mouse report and the harness cannot track the pointer.
let selecting = false, selectFrom = null, copyTimer = null;
const selectMode = (on) => {
  selecting = on; selectFrom = null;
  $("select").setAttribute("aria-pressed", String(on));
  $("terminal").classList.toggle("selecting", on);
  if (on) notice("拖动选择文本，松开即复制；期间 harness 收不到鼠标。Esc 取消。", false, 0);
  else if (copyTimer === null) $("copy-status").hidden = true;
};
function notice(text, failed = false, ms = 3000) {
  clearTimeout(copyTimer); copyTimer = null;
  $("copy-status").textContent = text; $("copy-status").classList.toggle("failed", failed); $("copy-status").hidden = false;
  if (ms) copyTimer = setTimeout(() => { copyTimer = null; $("copy-status").hidden = true; terminal?.clearSelection(); }, ms);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; }
  catch {
    // Without the async clipboard (or its permission) fall back to the legacy copy command in the same gesture.
    const area = document.createElement("textarea");
    area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
    document.body.append(area); area.select();
    const done = document.execCommand("copy");
    area.remove(); terminal?.focus();
    if (!done) throw new Error("浏览器不允许写入剪贴板");
  }
}
const lineCount = (text) => text.split("\n").length;
function cell(event) {
  const rect = terminal.element.querySelector(".xterm-screen").getBoundingClientRect();
  const clamp = (value, max) => Math.min(max - 1, Math.max(0, value));
  return {
    col: clamp(Math.floor((event.clientX - rect.left) / (rect.width / terminal.cols)), terminal.cols),
    row: clamp(Math.floor((event.clientY - rect.top) / (rect.height / terminal.rows)), terminal.rows) + terminal.buffer.active.viewportY,
  };
}
function selectTo(to) {
  const [a, b] = [selectFrom, to].sort((x, y) => x.row - y.row || x.col - y.col);
  terminal.select(a.col, a.row, (b.row - a.row) * terminal.cols + b.col - a.col + 1);
}
// Selection runs on pointer events: cancelling pointerdown suppresses the compatibility mouse events xterm reports from.
const guarded = ["mousedown", "mousemove", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "wheel", "pointerdown", "pointermove", "pointerup"];
for (const type of guarded) window.addEventListener(type, (event) => {
  if (!selecting || !terminal || (!selectFrom && !$("terminal").contains(event.target))) return;
  event.stopPropagation(); event.preventDefault();
  if (type === "pointerdown" && event.button === 0) { selectFrom = cell(event); terminal.clearSelection(); }
  else if (type === "pointermove" && selectFrom) selectTo(cell(event));
  else if (type === "pointerup" && selectFrom) {
    selectTo(cell(event));
    const text = terminal.getSelection();
    selectMode(false);
    if (!text.trim()) { notice("没有选中文本"); return; }
    copyText(text).then(() => notice(`已复制 ${lineCount(text)} 行、${text.length} 个字符`), (error) => notice(`复制失败：${error.message}`, true));
  }
}, { capture: true, passive: false });
window.addEventListener("keydown", (event) => {
  if (!selecting || event.key !== "Escape") return;
  // Esc cancels selection mode and is not sent to the harness.
  event.stopPropagation(); event.preventDefault();
  terminal?.clearSelection(); selectMode(false);
}, true);
async function api(path, data) {
  const response = await fetch(`/api/${path}`, data === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? `HTTP ${response.status}`), { status: response.status });
  return result;
}
const action = (fn) => async (event) => { event?.preventDefault(); try { await fn(); } catch (error) { fail(error); } };
function send(data) {
  if (ws?.readyState !== WebSocket.OPEN) throw new Error("终端已断线；请等待重新附着，不会重发键盘输入。");
  ws.send(JSON.stringify(data));
}
// Focuses the terminal of `id`, switching to it first; a switch focuses once its snapshot is shown.
function focusTerminal(id) {
  focusOnAttach = id;
  attach(id);
  if (snapshotReady && attached === id) { focusOnAttach = null; terminal.focus(); }
}
// The backend treats a harness confirmation in the terminal the user is typing in as already seen: it stays quiet,
// and pending ones are handed to that terminal. Focus only counts while this window is the one in front.
let attending = false;
function attention() {
  const on = Boolean(snapshotReady && attached && document.visibilityState === "visible" && document.hasFocus() && document.activeElement === terminal?.textarea);
  if (on === attending || ws?.readyState !== WebSocket.OPEN) return;
  attending = on;
  ws.send(JSON.stringify({ type: "attention", on }));
}
// Focus events settle before activeElement does.
const noticeAttention = () => setTimeout(attention);
function attach(id) {
  if (attached === id && (attaching || snapshotReady)) return;
  attached = id; attaching = true; attending = false;
  if (selecting) selectMode(false);
  focused = id; localStorage.setItem("live-focus", id); snapshotReady = false; owner = false; lastSize = ""; pendingOutput = [];
  send({ type: "attach", sessionId: id });
  void api("focus", { sessionId: id }).catch(fail);
}
const kindLabels = { input: "代输入", keys: "按键", prompt: "终端确认", permission: "工具权限", create: "新建 session", cancel: "终止 session", close: "关闭 tab", verify: "独立验收" };
// Keyed rendering: existing nodes are updated in place so focus, selection and scroll survive state pushes.
function reconcile(container, items, key, create, update) {
  const existing = new Map([...container.children].map((node) => [node.dataset.key, node]));
  const nodes = items.map((item) => {
    const id = key(item);
    let node = existing.get(id);
    existing.delete(id);
    if (!node) { node = create(item); node.dataset.key = id; }
    update(node, item);
    return node;
  });
  for (const node of existing.values()) node.remove();
  nodes.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] ?? null); });
}
function render(state) {
  current = state;
  // Harnesses that are not installed on the backend PATH are shown but cannot be launched.
  reconcile($("harness-menu"), state.harnesses, (harness) => harness.name, () => {
    const item = document.createElement("button"); item.type = "button"; item.setAttribute("role", "menuitem");
    item.onclick = action(() => { closeMenu(); openCreate(item.dataset.key); });
    return item;
  }, (item, harness) => {
    item.textContent = harness.available ? harness.name : `${harness.name}（未找到）`;
    item.title = harness.available ? harness.path : `未在 PATH 中找到 ${harness.command}`;
    item.disabled = !harness.available;
  });
  $("create").disabled = !state.harnesses.some((harness) => harness.available);
  if ($("create").disabled) closeMenu();
  const waiting = state.proposals.filter((proposal) => proposal.state === "pending");
  reconcile($("tabs"), state.sessions, (session) => session.id, (session) => {
    const tab = document.createElement("div"); tab.className = "tab";
    const dot = document.createElement("button"); dot.className = "tab-color"; dot.title = "选择 tab 颜色";
    dot.setAttribute("aria-haspopup", "menu");
    dot.onclick = () => openColors(session.id, dot);
    const button = document.createElement("button"); button.className = "tab-label";
    button.setAttribute("role", "tab");
    for (const part of ["name", "note", "state"]) { const span = document.createElement("span"); span.className = `tab-${part}`; button.append(span); }
    // Choosing a tab puts the keyboard in its terminal, the same as clicking into it.
    button.onclick = action(() => focusTerminal(session.id));
    button.ondblclick = () => editNote(tab, session.id);
    // Closing a tab ends its process; the backend hides the session once termination is confirmed.
    const close = document.createElement("button"); close.className = "tab-close"; close.textContent = "×";
    close.onclick = action(async () => {
      close.disabled = true;
      try { await api("close", { sessionId: session.id, operationId: crypto.randomUUID() }); }
      finally { close.disabled = false; }
    });
    tab.append(dot, button, close);
    return tab;
  }, (tab, session) => {
    const count = waiting.filter((proposal) => proposal.sessionId === session.id).length;
    const button = tab.querySelector(".tab-label");
    // An open tab is normally running, so only a different lifecycle state is spelled out.
    button.querySelector(".tab-name").textContent = session.name;
    button.querySelector(".tab-note").textContent = session.note ?? "";
    button.querySelector(".tab-state").textContent = `${session.state === "running" ? "" : ` · ${session.state}`}${count ? ` · ${count} 待确认` : ""}`;
    button.title = `${session.cwd}\n双击${session.note ? "修改" : "添加"}备注`;
    if (session.color) tab.dataset.color = session.color; else delete tab.dataset.color;
    tab.querySelector(".tab-color").setAttribute("aria-label", `tab 颜色：${colorNames[session.color ?? "none"]}`);
    button.setAttribute("aria-selected", String(session.id === focused));
    tab.classList.toggle("selected", session.id === focused);
    const close = tab.querySelector(".tab-close");
    close.title = session.state === "terminated" ? "关闭 tab" : "终止进程并关闭 tab";
    close.setAttribute("aria-label", `${close.title}：${session.name}`);
  });
  if (!state.sessions.some((session) => session.id === focused)) focused = state.sessions[0]?.id ?? null;
  const selected = state.sessions.find((session) => session.id === focused);
  if (selected?.color) $("terminal").dataset.color = selected.color; else delete $("terminal").dataset.color;
  if (verifying && state.sessions.some((session) => session.verification?.operationId === verifying)) verifying = null;
  $("verification").textContent = verifying
    ? "独立验收进行中……"
    : selected?.verification
      ? `独立验收 ${selected.verification.runId.slice(0, 8)}：${selected.verification.state} · 退出码 ${selected.verification.exitCode ?? "未知"}${selected.verification.reason ? ` · ${selected.verification.reason}` : ""}；仅证明该次命令。`
      : "没有独立验收结果；终端文字“完成”不等于任务验收通过。";
  $("verify-cancel").hidden = !verifying;
  // Command output is untrusted text: render with textContent and only touch it on change so an open <details> keeps its scroll.
  const output = !verifying && selected?.verification ? selected.verification.output || "（无输出）" : null;
  $("verification-details").hidden = output === null;
  if (output !== null && $("verification-output").textContent !== output) $("verification-output").textContent = output;
  $("terminal-status").textContent = selected ? `${selected.harness} / ${selected.id.slice(0, 8)} · ${selected.cwd} · ${selected.state} · ${selected.currentRun ? `任务 ${selected.currentRun.id.slice(0, 8)} / ${selected.currentRun.state}` : "原生终端 / 未关联托管任务"} · ${owner ? "你拥有键盘：打字会作废该终端的待确认输入" : held ? "另一页面拥有键盘；打字即可接管" : "未接管：打字即可接管键盘，鼠标移动不算接管"} · 退出码 ${selected.exitCode ?? "未知"}` : "选择或新建一个终端。关闭页面不会结束进程。";
  voiceControls();
  const live = state.assistant.live;
  // Turns are shown in spoken order, so the latest exchange of both sides stays in view.
  const turns = live.turns ?? [], box = $("transcript"), key = JSON.stringify(turns);
  if (box.dataset.key !== key) {
    const following = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    box.replaceChildren(...turns.map(({ role, text }) => {
      const line = document.createElement("p");
      line.className = role;
      line.textContent = `${role === "user" ? "你" : "助手"}：${text.trim()}`;
      return line;
    }));
    box.dataset.key = key;
    // Reading earlier turns is not interrupted; at the bottom the box follows new speech.
    if (following) box.scrollTop = box.scrollHeight;
  }
  const usage = state.assistant.usage;
  $("usage").textContent = [
    usage.live && state.assistant.live.state !== "disabled" ? `语音本月 ${usage.live.seconds.toFixed(1)} 秒 / ${usage.live.connections} 次连接` : "未配置 Foundry；终端仍可用。",
    usage.interpreter ? `意图解析本月 ${usage.interpreter.requests} 次 / ${usage.interpreter.tokens} tokens` : "",
  ].filter(Boolean).join("\n");
  $("speech").disabled = !state.speech;
  reconcile($("decisions"), waiting, (proposal) => proposal.id, card, (node, proposal) => {
    node.querySelector(".note").hidden = !proposal.changedDuringInterpretation;
  });
  const grants = state.sessions.flatMap((session) => (session.grants ?? []).map((grant) => ({ session, grant })));
  reconcile($("grants"), grants, ({ grant }) => grant.id, ({ session, grant }) => {
    const row = document.createElement("div"); row.className = "grant";
    const text = document.createElement("span");
    const button = document.createElement("button"); button.textContent = "撤销";
    button.onclick = action(() => api("revoke", { sessionId: session.id, grantId: grant.id }));
    row.append(text, button);
    return row;
  }, (row, { session, grant }) => {
    row.querySelector("span").textContent = `始终允许 · ${session.name} · ${kindLabels[grant.kind]} · 已使用 ${grant.uses} 次：${grant.label}`;
  });
  announce(waiting);
  keyboard();
  if (state.assistant.error && state.assistant.error !== dismissed) {
    const hint = live.error === "acknowledgement-unknown" ? "\n语音通道确认超时，已停止向语音模型追加上下文：请点“断开语音”后重新连接。终端和提案卡片不受影响。" : "";
    fail(new Error(state.assistant.error + hint), "backend");
  } else if (!state.assistant.error) clearError("backend");
}
function card(proposal) {
  const container = document.createElement("div"); container.className = "decision";
  const heading = document.createElement("header");
  const number = document.createElement("span"); number.className = "number"; number.textContent = `${proposal.number}.`;
  const title = document.createElement("strong");
  const target = proposal.sessionId ? (proposal.name ?? proposal.sessionId.slice(0, 8)) : proposal.harness;
  title.textContent = `${kindLabels[proposal.kind] ?? proposal.kind} · ${target}${proposal.kind === "prompt" ? "（屏幕识别，请核对终端）" : ""}`;
  heading.append(number, title);
  const note = document.createElement("p"); note.className = "note"; note.textContent = "解析期间你操作过该终端，请确认这仍是你要的输入。";
  const content = document.createElement("pre"); content.textContent = proposal.preview;
  container.append(heading, note, content);
  const buttons = [["批准", true, "once"], ["拒绝", false, "once"]];
  if (["input", "keys", "prompt", "permission"].includes(proposal.kind)) buttons.push(["始终允许", true, "always"]);
  if (proposal.kind === "permission") buttons.push(["在终端处理", false, "terminal"]);
  for (const [label, allowed, mode] of buttons) {
    const button = document.createElement("button"); button.textContent = label;
    button.onclick = action(async () => {
      for (const node of container.querySelectorAll("button")) node.disabled = true;
      try { await api("decision", { proposalId: proposal.id, allowed, mode, operationId: crypto.randomUUID() }); }
      finally { for (const node of container.querySelectorAll("button")) node.disabled = false; }
      // The native prompt now waits in the terminal: show that session and put the keyboard there.
      if (mode === "terminal") focusTerminal(proposal.sessionId);
    });
    container.append(button);
  }
  return container;
}
// Spoken reminders for proposals that appear while the page is open.
function announce(waiting) {
  const fresh = seenProposals ? waiting.filter((proposal) => !seenProposals.has(proposal.id)) : [];
  seenProposals = new Set(waiting.map((proposal) => proposal.id));
  if (!$("speech").checked || !current.speech) return;
  for (const proposal of fresh) {
    const target = proposal.sessionId ? (proposal.name ?? "会话") : `新的 ${proposal.harness}`;
    const text = `第 ${proposal.number} 号待确认：${target}，${kindLabels[proposal.kind] ?? proposal.kind}。${proposal.preview.slice(0, 120)}`;
    speechQueue = speechQueue.then(() => speak(text)).catch(fail);
  }
}
async function speak(text, voice) {
  const response = await fetch("/api/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, ...(voice ? { voice } : {}) }) });
  if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`);
  const url = URL.createObjectURL(await response.blob());
  try {
    const audio = new Audio(url);
    await audio.play();
    await new Promise((done) => { audio.onended = done; audio.onerror = done; });
  } finally { URL.revokeObjectURL(url); }
}
function connectTerminal() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/terminal`);
  ws.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "state") {
      const initial = !current;
      const previousFocus = focused;
      // Follow a switch the voice assistant made; requests from before this page loaded are not replayed.
      const request = event.assistant.focusRequest;
      if (initial) focusRequest = request;
      else if (request !== focusRequest) {
        focusRequest = request;
        if (event.sessions.some((session) => session.id === event.assistant.focused)) focused = event.assistant.focused;
      }
      render(event);
      if ((initial || focused !== previousFocus) && focused) attach(focused);
    }
    if (event.type === "snapshot" && event.sessionId === focused) {
      attaching = false;
      terminal.reset(); terminal.resize(event.cols, event.rows);
      terminal.write(event.data, () => {
        snapshotReady = true; clearError("attach"); resize();
        if (focusOnAttach === event.sessionId) { focusOnAttach = null; terminal.focus(); }
        attention();
      });
      // Output can overtake the snapshot while it is generated; replay only what the snapshot does not contain.
      for (const output of pendingOutput) if (output.observationId === event.observationId && output.sequence > event.sequence) terminal.write(output.data);
      pendingOutput = [];
    }
    if (event.type === "output" && event.sessionId === focused) { if (attaching) pendingOutput.push(event); else terminal.write(event.data); }
    if (event.type === "owner" && event.sessionId === focused) { owner = event.yours; held = event.held; if (owner || !held) resize(); if (current) render(current); else keyboard(); }
    if (event.type === "error") { attaching = false; fail(new Error(event.error)); }
    if (event.type === "stats") renderStats(event);
  };
  ws.onclose = ({ code }) => {
    // 1008: this login was ended (logout in any tab, or expiry); reconnecting cannot succeed, so return to the login form.
    if (code === 1008) { location.replace("/"); return; }
    owner = false; held = false; snapshotReady = false; current = null; keyboard();
    attached = null; attaching = false; attending = false;
    $("terminal-status").textContent = code === 1013
      ? "输出过快，存在显示缺口；harness 继续执行，正在通过有界快照重新附着。"
      : "断线：harness 继续执行，正在重新附着；断线期间输出可能有缺口，不会重发输入。";
    // A refused upgrade (403 after a backend restart or expiry) closes without 1008; ask the API whether the login
    // still exists so the page returns to the login form instead of reconnecting forever.
    setTimeout(async () => {
      try { await api("state"); } catch (error) { if (error.status === 401) { location.replace("/"); return; } }
      connectTerminal();
    }, 1500);
  };
  ws.onopen = () => clearError("terminal");
  ws.onerror = () => fail(new Error("终端连接失败"), "terminal");
}
// Tab color and note: presentation only, stored on the session so every page and reload shows the same.
const colorNames = { none: "无", blue: "蓝", teal: "青", green: "绿", yellow: "黄", orange: "橙", red: "红", purple: "紫", gray: "灰" };
let colorTarget = null;
function openColors(sessionId, anchor) {
  const menu = $("color-menu");
  if (!menu.hidden && colorTarget === sessionId) { closeColors(); return; }
  colorTarget = sessionId;
  const chosen = current?.sessions.find((session) => session.id === sessionId)?.color ?? "none";
  menu.replaceChildren(...Object.entries(colorNames).map(([color, name]) => {
    const item = document.createElement("button");
    item.type = "button"; item.dataset.color = color; item.title = name;
    item.setAttribute("role", "menuitemradio"); item.setAttribute("aria-label", name); item.setAttribute("aria-checked", String(color === chosen));
    item.onclick = action(async () => { closeColors(); await api("tab", { sessionId, color: color === "none" ? null : color }); });
    return item;
  }));
  // Positioned against .terminals (its containing block); a hidden menu has no offsetParent to measure.
  const box = anchor.getBoundingClientRect(), parent = document.querySelector(".terminals").getBoundingClientRect();
  menu.style.left = `${box.left - parent.left}px`; menu.style.top = `${box.bottom - parent.top + 4}px`;
  menu.hidden = false;
  menu.querySelector('[aria-checked="true"]').focus();
}
function closeColors() { $("color-menu").hidden = true; colorTarget = null; }
$("color-menu").onkeydown = (event) => {
  const items = [...$("color-menu").children], index = items.indexOf(document.activeElement);
  if (event.key === "Escape") { event.preventDefault(); closeColors(); }
  else if (["ArrowRight", "ArrowLeft"].includes(event.key)) { event.preventDefault(); items[(index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length].focus(); }
};
document.addEventListener("pointerdown", (event) => { if (!$("color-menu").hidden && !event.target.closest("#color-menu, .tab-color")) closeColors(); });
// Enter or leaving the field saves; Esc cancels. An empty note removes it.
function editNote(tab, sessionId) {
  if (tab.querySelector(".tab-note-input")) return;
  // The double click's first click switched tabs; the note field keeps the keyboard instead of that terminal.
  focusOnAttach = null;
  const label = tab.querySelector(".tab-label"), field = document.createElement("input");
  field.className = "tab-note-input"; field.maxLength = 40; field.placeholder = "备注，回车保存";
  field.value = current?.sessions.find((session) => session.id === sessionId)?.note ?? "";
  field.setAttribute("aria-label", "tab 备注");
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true; field.remove(); label.hidden = false;
    if (save) try { await api("tab", { sessionId, note: field.value }); } catch (error) { fail(error); }
  };
  field.onkeydown = (event) => {
    if (event.key === "Enter") { event.preventDefault(); finish(true); }
    else if (event.key === "Escape") { event.preventDefault(); finish(false); }
  };
  field.onblur = () => finish(true);
  label.hidden = true; label.after(field); field.focus(); field.select();
}
const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)}G`;
const percent = (share) => `${Math.round(share * 100)}%`;
function stat(id, share, value) {
  const node = $(id);
  node.querySelector(".stat-value").textContent = value;
  node.querySelector(".meter span").style.width = percent(Math.min(Math.max(share ?? 0, 0), 1));
  node.dataset.level = share >= 0.9 ? "high" : share >= 0.75 ? "warn" : "ok";
}
// One tooltip for the whole strip; tmux PIDs help locate or clean up processes from a shell.
function renderStats({ cpu, cores, load, memory, disk, tmux }) {
  const used = memory.total - memory.available, diskUsed = disk.total - disk.available;
  stat("stat-cpu", cpu, cpu === null ? "—" : percent(cpu));
  stat("stat-memory", used / memory.total, gib(used));
  stat("stat-disk", diskUsed / disk.total, percent(diskUsed / disk.total));
  const label = (sessionId) => {
    const session = current?.sessions.find((entry) => entry.id === sessionId);
    return session ? `${session.name ?? session.harness} ${sessionId.slice(0, 8)}` : sessionId.slice(0, 8);
  };
  $("server-stats").title = [
    `CPU  ${cpu === null ? "—" : percent(cpu)} · ${cores} 核 · 负载 ${load.map((value) => value.toFixed(2)).join(" / ")}（1/5/15 分钟）`,
    `MEM  已用 ${gib(used)} / 共 ${gib(memory.total)}（${percent(used / memory.total)}），可用 ${gib(memory.available)}`,
    `DISK 已用 ${gib(diskUsed)} / 共 ${gib(disk.total)}（${percent(diskUsed / disk.total)}），可用 ${gib(disk.available)}（工作区所在磁盘）`,
    tmux.pid === null ? "tmux 服务未运行" : `tmux 服务 PID ${tmux.pid}`,
    ...tmux.panes.map((pane) => `  ${label(pane.sessionId)} → PID ${pane.pid}`),
    "每 5 秒更新",
  ].join("\n");
}
function resize() {
  if (!terminal) return;
  fit.fit();
  // The PTY follows this page's size unless another page holds the keyboard.
  if ((held && !owner) || !snapshotReady || ws?.readyState !== WebSocket.OPEN) return;
  // Ended sessions stay viewable as a final snapshot; only a live PTY can be resized.
  if (current?.sessions.find((session) => session.id === focused)?.state !== "running") return;
  const size = `${focused}:${terminal.cols}:${terminal.rows}`;
  if (size === lastSize) return;
  lastSize = size;
  send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
}
// Both the initial state check and a login can call enter() while a slow network delays either reply;
// only the first builds the workspace, otherwise a second terminal and socket hide the attached one.
let entered = false;
async function enter() {
  await api("state");
  if (entered) return;
  entered = true;
  $("login").hidden = true; $("workspace").hidden = false;
  terminal = new Terminal({
    cursorBlink: true, scrollback: 2000, fontSize: 14, allowProposedApi: false,
    fontFamily: "'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace",
    // GitHub Dark colors, matching the page's terminal frame.
    theme: {
      background: "#0d1117", foreground: "#e6edf3", cursor: "#2f81f7", cursorAccent: "#0d1117", selectionBackground: "#3392ff44",
      black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922", blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#ffffff",
    },
  });
  fit = new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open($("terminal")); fit.fit();
  // Typing claims the keyboard on the server; large pastes are split into ordered messages.
  // Mouse, focus and query replies are generated by the terminal itself (e.g. while a TUI tracks the mouse);
  // before attachment they are dropped silently so they cannot mask a real error. Typing still reports it.
  const report = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[[?>=]?[\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;
  const input = (data, binary = false) => {
    if (!snapshotReady) { if (!report.test(data)) fail(new Error("终端尚未附着；断线期间输入不会缓存。"), "attach"); return; }
    // A chunk never ends between the halves of a surrogate pair, which would reach the PTY as two U+FFFD.
    try {
      for (let offset = 0, end; offset < data.length; offset = end) {
        end = Math.min(offset + 4096, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
        send({ type: "input", data: data.slice(offset, end), binary });
      }
    }
    catch (error) { fail(error); }
  };
  terminal.textarea.addEventListener("focus", noticeAttention);
  terminal.textarea.addEventListener("blur", noticeAttention);
  addEventListener("focus", noticeAttention);
  addEventListener("blur", noticeAttention);
  document.addEventListener("visibilitychange", noticeAttention);
  terminal.onData(input);
  terminal.onBinary((data) => input(data, true));
  new ResizeObserver(resize).observe($("terminal"));
  connectTerminal();
}
// A slow login reply must not invite a second submission, which would issue another login and enter() again.
let loggingIn = false;
$("login").onsubmit = action(async () => {
  if (loggingIn) return;
  loggingIn = true; $("login-submit").disabled = true;
  try { await api("login", { password: $("password").value }); $("password").value = ""; await enter(); }
  finally { loggingIn = false; $("login-submit").disabled = false; }
});
// The avatar opens a small account menu: settings and logout.
const accountItems = () => [...$("account-menu").querySelectorAll("button")];
function closeAccount() { $("account-menu").hidden = true; $("avatar").setAttribute("aria-expanded", "false"); }
$("avatar").onclick = () => {
  if (!$("account-menu").hidden) { closeAccount(); return; }
  $("account-menu").hidden = false; $("avatar").setAttribute("aria-expanded", "true");
  accountItems()[0].focus();
};
$("account-menu").onkeydown = (event) => {
  const items = accountItems(), index = items.indexOf(document.activeElement);
  if (event.key === "Escape") { event.preventDefault(); closeAccount(); $("avatar").focus(); }
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  }
};
document.addEventListener("pointerdown", (event) => { if (!$("account-menu").hidden && !event.target.closest(".account")) closeAccount(); });
$("logout").onclick = action(async () => { closeAccount(); await api("logout", {}); location.replace("/"); });
$("open-settings").onclick = () => { closeAccount(); openSettings(); };
// The button ships disabled so an early Enter cannot natively GET-submit the form before this handler exists.
$("login-submit").disabled = false; $("login-submit").removeAttribute("title");
// New sessions start in <workspace>/<harness>-work unless a directory inside an allowed root is chosen.
// "新建 session" opens a harness menu; picking an entry goes straight to the directory dialog for that harness.
const menuItems = () => [...$("harness-menu").querySelectorAll("button:not(:disabled)")];
function closeMenu() { $("harness-menu").hidden = true; $("create").setAttribute("aria-expanded", "false"); }
$("create").onclick = () => {
  if (!$("harness-menu").hidden) { closeMenu(); return; }
  $("harness-menu").hidden = false; $("create").setAttribute("aria-expanded", "true");
  menuItems()[0]?.focus();
};
$("harness-menu").onkeydown = (event) => {
  const items = menuItems(), index = items.indexOf(document.activeElement);
  if (event.key === "Escape") { event.preventDefault(); closeMenu(); $("create").focus(); }
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }
};
document.addEventListener("pointerdown", (event) => { if (!$("harness-menu").hidden && !event.target.closest(".menu-anchor")) closeMenu(); });
function openCreate(harness) {
  $("create-harness").textContent = harness;
  $("create-default").textContent = `${current.workspace}/${harness}-work`;
  $("create-roots").textContent = current.roots.join("、");
  $("create-form").elements.cwd.value = "default";
  $("create-cwd").disabled = true;
  $("create-dialog").returnValue = "";
  $("create-dialog").showModal();
}
$("create-form").onchange = () => {
  const custom = $("create-form").elements.cwd.value === "custom";
  $("create-cwd").disabled = !custom; $("create-cwd").required = custom;
  if (custom) $("create-cwd").focus();
};
$("create-dialog").onclose = action(async () => {
  if ($("create-dialog").returnValue !== "create") return;
  const custom = $("create-form").elements.cwd.value === "custom";
  const session = await api("sessions", {
    harness: $("create-harness").textContent, operationId: crypto.randomUUID(),
    ...(custom ? { cwd: $("create-cwd").value.trim() } : {}),
  });
  // Put the keyboard in the new terminal, so typing goes straight to the harness.
  focusTerminal(session.id);
});
// Toggle: claiming supersedes pending assistant input for this terminal; giving it back only drops ownership.
$("claim").onclick = action(() => {
  if (!focused) throw new Error("请选择 session");
  // Giving the keyboard back moves typing to the request box, so it no longer reaches (and reclaims) the terminal.
  if (owner) { send({ type: "release" }); $("request-text").focus(); }
  else { send({ type: "claim" }); terminal.focus(); }
});
$("select").onclick = action(() => { if (!focused) throw new Error("请选择 session"); selectMode(!selecting); });
$("copy-screen").onclick = action(async () => {
  if (!focused || !terminal) throw new Error("请选择 session");
  // The visible screen only; wrapped rows are joined back into their logical line.
  const buffer = terminal.buffer.active, lines = [];
  for (let row = buffer.viewportY; row < buffer.viewportY + terminal.rows; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
  }
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (!lines.length) { notice("屏幕上没有文本"); return; }
  try { await copyText(lines.join("\n")); notice(`已复制屏幕文本 ${lines.length} 行`); }
  catch (error) { notice(`复制失败：${error.message}`, true); }
});
const bytes = (n) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`;
// Uploads go one by one into the session's current directory; an existing name fails instead of overwriting.
$("upload").onclick = action(() => { if (!focused) throw new Error("请选择 session"); $("upload-input").click(); });
$("upload-input").onchange = action(async () => {
  const files = [...$("upload-input").files], sessionId = focused;
  $("upload-input").value = "";
  for (const file of files) {
    notice(`正在上传 ${file.name}（${bytes(file.size)}）…`, false, 0);
    try {
      const response = await fetch(`/api/upload?${new URLSearchParams({ sessionId, name: file.name })}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      notice(`已上传 ${result.path}（${bytes(result.bytes)}）`, false, 6000);
    } catch (error) { notice(`上传 ${file.name} 失败：${error.message}`, true, 10000); return; }
  }
});
$("download").onclick = action(() => {
  if (!focused) throw new Error("请选择 session");
  $("download-path").value = ""; $("download-dialog").showModal();
});
$("download-dialog").onclose = action(async () => {
  if ($("download-dialog").returnValue !== "download") return;
  const query = new URLSearchParams({ sessionId: focused, path: $("download-path").value.trim() });
  try {
    const response = await fetch(`/api/download?${query}&check=1`);
    const file = await response.json();
    if (!response.ok) throw new Error(file.error ?? `HTTP ${response.status}`);
    const link = document.createElement("a");
    link.href = `/api/download?${query}`; link.download = file.name;
    document.body.append(link); link.click(); link.remove();
    notice(`开始下载 ${file.path}（${bytes(file.size)}）`, false, 6000);
  } catch (error) { notice(`下载失败：${error.message}`, true, 10000); }
});
$("terminate").onclick = action(async () => {
  if (!focused) throw new Error("请选择 session");
  if (window.confirm("终止此 session 的真实进程？tab 会保留，可用 tab 上的 × 关闭。")) await api("terminate", { sessionId: focused, operationId: crypto.randomUUID() });
});
// Interpreting a request waits on the intent model, so show progress and ignore repeat submits until it answers.
$("request").onsubmit = action(async () => {
  const form = $("request"), text = $("request-text"), button = form.querySelector("button");
  if (form.getAttribute("aria-busy") === "true") return;
  if (!text.value.trim()) throw new Error("请先输入要交给助手的任务或反馈");
  form.setAttribute("aria-busy", "true"); text.readOnly = true; button.disabled = true; button.textContent = "正在交给助手…";
  try {
    const { clarification } = await api("request", { text: text.value, sessionId: focused ?? null });
    text.value = "";
    if (clarification) fail(new Error(`Clarification required: ${clarification}`));
  } finally {
    form.removeAttribute("aria-busy"); text.readOnly = false; button.disabled = false; button.textContent = "交给助手";
  }
});
$("request-text").onkeydown = (event) => {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
  event.preventDefault();
  $("request").requestSubmit();
};
$("wait").onclick = action(async () => { if (!focused) throw new Error("请选择 session"); await api("wait", { sessionId: focused }); });
$("error-close").onclick = () => { dismissed = current?.assistant.error ?? null; $("error").hidden = true; errorSource = null; };
$("speech").onchange = () => { try { localStorage.setItem("live-speech", $("speech").checked ? "1" : "0"); } catch {} };
try { $("speech").checked = localStorage.getItem("live-speech") === "1"; } catch {}
$("verify-cancel").onclick = action(async () => { if (verifying) await api("verify-cancel", { operationId: verifying }); });
$("verify").onsubmit = action(async () => {
  const session = current?.sessions.find((entry) => entry.id === focused);
  if (!session) throw new Error("请选择 session");
  const command = $("verify-command").value.trim();
  if (!command) throw new Error("请提供明确的独立验收命令");
  if (!window.confirm(`在当前工作区执行独立验收命令？\n${command}`)) return;
  verifying = crypto.randomUUID();
  render(current);
  try {
    await api("verify", { sessionId: session.id, runId: session.currentRunId ?? session.processRunId, command, operationId: verifying });
  } catch (error) { verifying = null; render(current); throw error; }
});
// The offer is sent with all ICE candidates, since the backend relays it in one request.
async function offer(peer) {
  await peer.setLocalDescription(await peer.createOffer());
  if (peer.iceGatheringState !== "complete") await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("ICE gathering timed out")), 10000);
    const listener = () => { if (peer.iceGatheringState === "complete") { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", listener); done(); } };
    peer.addEventListener("icegatheringstatechange", listener);
  });
  return peer.localDescription.sdp;
}
// One connect/disconnect toggle plus two switches; every label says the current state, not the next action.
const liveLabels = { disabled: "语音不可用", disconnected: "未连接", connecting: "连接中…", active: "已连接", degraded: "连接受损", failed: "连接失败", closing: "正在断开…" };
// A provider session that is not confirmed closed blocks reconnecting, so the toggle offers to close it in any state.
function unsettled(live) {
  return ["connecting", "active", "degraded", "closing"].includes(live?.state) || (live?.state !== "disabled" && live?.closeConfirmed === false);
}
function voiceControls() {
  const live = current?.assistant.live ?? { state: "disabled" };
  const state = connecting ? "connecting" : live.state;
  const linked = Boolean(pc) || unsettled(live);
  $("live-status").dataset.state = state;
  $("live-label").textContent = live.preview && state === "active" ? "试听中…" : liveLabels[state] ?? state;
  $("live-status").title = live.error ?? "";
  $("live-error").hidden = !live.error || live.state === "disabled";
  $("live-error").textContent = live.error ? `语音：${live.error}` : "";
  const connect = $("connect");
  connect.disabled = connecting || live.state === "closing" || (live.state === "disabled" && !pc);
  connect.textContent = connecting ? "连接中…" : live.state === "closing" ? "断开中…" : linked ? "断开语音" : "连接语音";
  connect.classList.toggle("primary", !linked && !connecting);
  connect.classList.toggle("connected", linked && !connecting);
  for (const [id, on, label] of [["mic", !micMuted, "麦克风"], ["mute", !muted, "助手声音"]]) {
    $(id).disabled = !pc || connecting;
    $(id).setAttribute("aria-checked", String(on));
    $(id).textContent = `${label} ${on ? "开" : "关"}`;
  }
  settingsVoices();
}
async function disconnect() {
  try { await api("live/close", {}); }
  finally {
    pc?.close(); stream?.getTracks().forEach((track) => track.stop());
    $("audio").srcObject = null;
    pc = null; stream = null; connecting = false;
    muted = false; micMuted = false; $("audio").muted = false;
    voiceControls();
  }
}
$("connect").onclick = action(async () => {
  if (connecting) return;
  if (pc || (unsettled(current?.assistant.live) && current.assistant.live.state !== "connecting")) { await disconnect(); return; }
  connecting = true; voiceControls();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
    pc = new RTCPeerConnection(); for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pc.ontrack = async ({ streams }) => {
      $("audio").srcObject = streams[0];
      try { await $("audio").play(); } catch { $("play").hidden = false; }
    };
    pc.onconnectionstatechange = () => { if (pc?.connectionState === "failed") fail(new Error("媒体连接失败；终端继续执行。请显式断开后重连。")); };
    const result = await api("live/open", { sdp: await offer(pc) });
    await pc.setRemoteDescription({ type: "answer", sdp: result.sdp });
    // A new connection always starts audible; the backend keeps the last session's choice otherwise.
    muted = false; micMuted = false; $("audio").muted = false;
    await api("live/mute", { muted: false });
  } catch (error) {
    pc?.close(); stream?.getTracks().forEach((track) => track.stop()); pc = null; stream = null;
    throw error;
  } finally { connecting = false; voiceControls(); }
});
$("mute").onclick = action(async () => {
  muted = !muted; $("audio").muted = muted; voiceControls();
  try { await api("live/mute", { muted }); }
  catch (error) { muted = !muted; $("audio").muted = muted; voiceControls(); throw error; }
});
$("mic").onclick = action(() => { micMuted = !micMuted; stream?.getAudioTracks().forEach((track) => { track.enabled = !micMuted; }); voiceControls(); });
$("play").onclick = action(async () => { await $("audio").play(); $("play").hidden = true; });
// Settings: every value except the password; the backend validates, stores and applies them at once.
const settingsForm = $("settings-form");
const settingKeys = ["subscription", "liveEndpoint", "liveDeployment", "liveVoice", "ttsEndpoint", "ttsDeployment", "ttsVoice",
  "intentEndpoint", "intentDeployment", "intentEffort", "workspace", "roots", "dshProfile", "dshToken", "hooks", "verifyTimeout", "uploadMb"];
const liveKeys = ["subscription", "liveEndpoint", "liveDeployment", "liveVoice"];
const shown = (key, value) => key === "roots" ? value.join("、") || "（无）" : typeof value === "boolean" ? (value ? "开" : "关") : String(value) || "（空）";
function settingValue(key) {
  const field = settingsForm.elements[key];
  if (key === "roots") return field.value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (field.type === "checkbox") return field.checked;
  if (field.type === "number") return Number(field.value);
  return field.value.trim();
}
function setSetting(key, value) {
  const field = settingsForm.elements[key];
  if (field.tagName === "SELECT" && ![...field.options].some((option) => option.value === value)) field.append(new Option(value, value));
  if (key === "roots") field.value = value.join("\n");
  else if (field.type === "checkbox") field.checked = value;
  else field.value = String(value);
}
// Each field names its default and offers to restore it while the value differs.
function settingDefaults() {
  const { defaults } = current.settings;
  for (const key of settingKeys) {
    const label = settingsForm.querySelector(`[data-key="${key}"]`);
    let hint = label.querySelector(".default");
    if (!hint) {
      hint = document.createElement("span"); hint.className = "default";
      const text = document.createElement("span"), reset = document.createElement("button");
      reset.type = "button"; reset.textContent = "恢复默认";
      reset.onclick = (event) => { event.preventDefault(); setSetting(key, current.settings.defaults[key]); settingDefaults(); };
      hint.append(text, reset); label.append(hint);
    }
    hint.firstChild.textContent = `默认：${shown(key, defaults[key])}`;
    hint.lastChild.hidden = JSON.stringify(settingValue(key)) === JSON.stringify(defaults[key]);
  }
}
function voiceOptions(select, voices) {
  select.replaceChildren(...voices.map((voice) => new Option(voice, voice)));
}
function openSettings() {
  const { values, ignored } = current.settings;
  voiceOptions(settingsForm.elements.liveVoice, current.settings.liveVoices);
  voiceOptions(settingsForm.elements.ttsVoice, current.settings.ttsVoices);
  for (const key of settingKeys) setSetting(key, values[key]);
  settingDefaults();
  $("settings-status").textContent = ignored.length ? `已忽略无效的已保存设置：${ignored.join("、")}` : "";
  settingsVoices();
  $("settings-dialog").showModal();
}
settingsForm.oninput = () => settingDefaults();
// Live samples use the saved endpoint; a preview cannot run beside a voice connection.
function settingsVoices() {
  if (!current?.settings) return;
  const live = current.assistant.live;
  $("preview-live").disabled = previewing || Boolean(pc) || connecting || live.state === "disabled" || unsettled(live);
  $("preview-tts").disabled = previewing || !current.speech;
}
async function previewRun(button, run) {
  previewing = true; settingsVoices();
  const label = button.textContent; button.textContent = "播放中…";
  try { await run(); }
  finally { previewing = false; button.textContent = label; settingsVoices(); }
}
$("preview-tts").onclick = action(() => previewRun($("preview-tts"), () => speak("你好，这是朗读待确认提醒时使用的声音。", settingValue("ttsVoice"))));
$("preview-live").onclick = action(() => previewRun($("preview-live"), async () => {
  // The microphone is never opened for a sample: the connection sends silence, which keeps the session's audio clock running.
  const peer = new RTCPeerConnection(), audio = new Audio(), context = new AudioContext();
  const silence = context.createMediaStreamDestination();
  const gain = context.createGain(); gain.gain.value = 0;
  const tone = context.createOscillator(); tone.connect(gain).connect(silence); tone.start();
  for (const track of silence.stream.getTracks()) peer.addTrack(track, silence.stream);
  peer.ontrack = ({ streams }) => { audio.srcObject = streams[0]; void audio.play().catch(() => {}); };
  try {
    const result = await api("live/open", { sdp: await offer(peer), voice: settingValue("liveVoice"), preview: true });
    await peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
    await until(() => peer.connectionState === "connected", 15000, "试听连接超时");
    await api("live/preview", {});
    // The transcript streams with the audio: once it has been quiet for a while the sample is over.
    let text = "", changed = Date.now();
    await until(() => {
      const output = current?.assistant.live.output ?? "";
      if (output !== text) { text = output; changed = Date.now(); }
      return text && Date.now() - changed > 2500;
    }, 25000, "试听没有收到语音");
  } finally {
    // Close the provider session first so its final usage is confirmed, then drop the media.
    await api("live/close", {}).catch(() => {});
    peer.close(); audio.srcObject = null; void context.close();
  }
}));
async function until(check, ms, message) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise((done) => setTimeout(done, 200));
  }
}
settingsForm.onsubmit = action(async (event) => {
  if (event?.submitter?.value === "cancel") { $("settings-dialog").close(); return; }
  const values = Object.fromEntries(settingKeys.map((key) => [key, settingValue(key)]));
  const saved = current.settings.values;
  const movedLive = values.liveEndpoint !== saved.liveEndpoint || values.subscription !== saved.subscription;
  const changedLive = liveKeys.some((key) => values[key] !== saved[key]);
  const linked = Boolean(pc) || unsettled(current.assistant.live);
  let reconnect = false;
  if (changedLive && linked) {
    reconnect = window.confirm("语音设置需要重新连接语音才能生效。现在断开并重新连接吗？");
    if (!reconnect && movedLive) throw new Error("更改实时语音的 Foundry endpoint 或订阅前需要先断开语音。");
    if (reconnect) await disconnect();
  }
  current.settings = await api("settings", { values });
  $("settings-dialog").close();
  if (reconnect) $("connect").click();
});
$("settings-defaults").onclick = () => { for (const key of settingKeys) setSetting(key, current.settings.defaults[key]); settingDefaults(); };
void api("state").then(enter).catch((error) => { if (!/Authentication required/.test(error.message)) fail(error); });
