# Live Assistant

English | [简体中文](README.zh-CN.md)

A standalone task assistant that is terminal-first, with voice as a secondary channel. Shell, Claude Code, Codex, GitHub Copilot CLI and DSH ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)) run as **native CLIs that are already installed and configured in the current shell**. They inherit Live Assistant's environment variables and run in persistent PTYs inside a dedicated local tmux; browser tabs, the web backend and the voice connection do not own their lifecycle. GPT-Live (`gpt-live-1`) handles the conversation, and `gpt-6.1-sol` interprets the conversation into **numbered proposals**, which are written to the terminal only after a human approves them. Newly pending items can be read aloud via TTS (`gpt-4o-mini-tts`).

This is a **human-in-the-loop development prototype, not a production service**: the system sets no limits on execution count, duration or calls, and when to stop is up to the user. Docs: [Architecture](docs/architecture.md), [Threat model](docs/threat-model.md), [Design decision ADR-0002](docs/adr/0002-independent-live-assistant.md), [Operations guide](docs/live-assistant.md). The web UI and the voice assistant currently use Chinese.

## Requirements

| Dependency | Notes |
|---|---|
| Linux + `tmux` 3.4 | Required; the assistant uses a dedicated socket and does not affect the user's existing tmux |
| Node.js 22.19 | `npm ci` installs the pinned version into `node_modules/.bin/node`, the npm scripts use it automatically, and no build is needed |
| Harness CLI | `claude`, `codex`, `copilot` and `dsh` are installed, logged in and configured by the user (model, permission mode, sandbox, etc.). The assistant **does not write their configuration and does not configure model routing**; it only looks them up on PATH and starts them without extra arguments (Claude/Codex only get hook arguments appended, see below). A harness that is not on PATH is marked "Not found" (`未找到`) in the "New session" (`新建 session`) menu and cannot be started |
| DSH | If `dsh` is installed under an nvm-managed Node 22, run `nvm use 22` before starting the assistant so that it is on PATH. The assistant starts `dsh --profile dsh-tui` as a TUI; once inside, press Esc and use `/model` to choose a Foundry model |
| Azure CLI | Voice, the intent interpreter, TTS and the optional DSH temporary token require `az login` (Entra ID); no API keys are used |
| Foundry deployments | `gpt-live-1` (live voice), `gpt-6.1-sol` (intent interpreter for voice and "Hand off to the assistant"), `gpt-4o-mini-tts` (read-aloud). Not needed for the terminal itself; each model is optional and its deployment can be overridden with environment variables |
| Chromium | Needed only for tests: by default the Chromium installed for the current Playwright version is used (`npx playwright install chromium`), or set one with `LIVE_ASSISTANT_CHROMIUM` |
| `espeak-ng` | Needed only for `npm run test:live`, to synthesize test speech |

### How harnesses are started

Each session inherits the shell environment variables present when Live Assistant was started (the `npm_*` variables, `INIT_CWD` and the `node_modules/.bin` PATH prefix injected by `npm run` are removed, so the CLIs from your shell are used, not repository dependencies), plus `LIVE_SESSION_ID` and `LIVE_HOOK_SOCKET`. The environment is passed through the tmux client environment and never appears in command-line arguments or files on disk. Each new session also reads `~/.bashrc` as it is at that moment: the shell is an interactive bash and reads it itself; other harnesses are started via `/bin/bash -ic 'exec "$0" "$@"' <command>` (only interactive mode gets past the non-interactive `return` at the top of Ubuntu's `~/.bashrc`, and `exec` preserves the CLI's exit code). So after you edit `~/.bashrc`, the change takes effect in newly created sessions, while running sessions are unchanged; the rc can only add or override variables, and a variable removed from the rc is still kept if it is already in the inherited environment. Whether a harness is installed is still determined by the inherited PATH. Note that secrets exported in `~/.bashrc` also reach every harness process.

Each CLI also has its own environment policy for its tool subprocesses: DSH removes variables whose names match `KEY|PASSWORD|SECRET|TOKEN` (case-insensitive) from the shell/skill subprocesses it starts, so the DSH process itself can see a variable such as `EXAMPLE_API_KEY`, but the skill scripts it runs cannot; DSH currently has no allowlist setting to let variables through. Codex's default sandbox blocks network access, so a command first fails with a DNS resolution error and then requests networked execution through a permission card.

| Harness | Launch command |
|---|---|
| shell | `/bin/bash -i` (reads `~/.bashrc`: colored prompt, aliases, completion, nvm, etc.) |
| claude | `claude` (with hooks enabled, `--settings '<PermissionRequest hook JSON>'` is appended) |
| codex | `codex` (with hooks enabled, `-c hooks.PermissionRequest=...` is appended; the first time, you need to trust the hook inside the CLI) |
| copilot | `copilot` (no hook; permission prompts rely on screen recognition) |
| dsh | `dsh --profile <LIVE_ASSISTANT_DSH_PROFILE>`, default `dsh-tui`; with `LIVE_ASSISTANT_DSH_FOUNDRY_TOKEN=1`, an Entra temporary token is obtained when the session is created and used as that process's `FOUNDRY_TOKEN` |

The DSH temporary token is equivalent to `az account get-access-token --resource https://cognitiveservices.azure.com --subscription "$AZURE_SUBSCRIPTION_NAME"`. It exists only in that DSH process's environment (not in the tmux global environment, arguments, state files or logs) and expires after about 1 hour; once it expires, just create a new DSH session. If you later switch to a long-lived endpoint, simply turn this switch off.

### Working directories

When you create a new session, a dialog asks you to choose its working directory:

- **Default directory**: `<LIVE_ASSISTANT_WORKSPACE>/<harness>-work`, e.g. `codex-work`; it is created automatically if it does not exist.
- **Custom directory**: an absolute path, or a path relative to the workspace. It must be inside the workspace or one of the roots listed in `LIVE_ASSISTANT_ROOTS` (subdirectories included); symlinks are checked by their real path, and a path outside these bounds returns 403. A directory that does not exist is created.

## Configuration

Non-secret configuration can go in `.env` at the repository root (the npm scripts read it via `--env-file-if-exists`); see [.env.example](.env.example). **Do not write passwords, tokens or keys into any file.**

| Variable | Default | Description |
|---|---|---|
| `LIVE_ASSISTANT_PASSWORD` | — | Required, at least 16 characters, kept only in the process environment |
| `AZURE_SUBSCRIPTION_NAME` | Current az default subscription | Passed explicitly to AzureCliCredential (voice, intent interpreter, TTS and the DSH temporary token) without changing the shared az default subscription; it only determines the tenant the token is obtained from, so Foundry resources in other subscriptions within the same tenant also work |
| `FOUNDRY_LIVE_ENDPOINT` | Not set | `https://<resource>.openai.azure.com` of the Foundry resource that hosts live voice; each of the three models specifies its own resource, so they can be spread across different regions. A model whose endpoint is not set is shown as unavailable; if none is set, only the terminal is provided |
| `FOUNDRY_LIVE_DEPLOYMENT` | `gpt-live-1` | Live voice deployment |
| `FOUNDRY_LIVE_VOICE` | `marin` | Live voice speaker voice (`session.audio.output.voice`), fixed when each connection is created; a change takes effect on the next voice connection; invalid names are rejected by Foundry |
| `FOUNDRY_TTS_ENDPOINT` | Not set | Foundry resource that hosts read-aloud |
| `FOUNDRY_TTS_DEPLOYMENT` | `gpt-4o-mini-tts` | Read-aloud deployment (`/openai/v1/audio/speech`) |
| `FOUNDRY_TTS_VOICE` | `alloy` | Read-aloud voice; valid values are the voices the TTS deployment supports |
| `FOUNDRY_INTENT_ENDPOINT` | Not set | Foundry resource that hosts the intent interpreter; when it is not set, neither voice nor text delegations can be interpreted |
| `FOUNDRY_INTENT_DEPLOYMENT` | `gpt-6.1-sol` | Intent interpreter deployment; only deployment names starting with `gpt-` are accepted (the model must follow a strict JSON schema), e.g. `gpt-6-luna` |
| `FOUNDRY_INTENT_EFFORT` | `low` | The intent interpreter's `reasoning.effort`: `none/minimal/low/medium/high/xhigh`; supported values differ by model (`gpt-6.1-sol` does not support `none`), and an unsupported value makes the request return HTTP 400 |
| `LIVE_ASSISTANT_STATE` | `.live-assistant` | Private state: `sessions.json`, `events.jsonl`, `live-transcript.jsonl`, `live.json`, usage records, tmux and hook sockets |
| `LIVE_ASSISTANT_WORKSPACE` | `<STATE>/workspace` | Live Assistant's workspace; the default session directories `<harness>-work` are created here, and it is itself always an allowed root |
| `LIVE_ASSISTANT_ROOTS` | Empty | Additional roots where harnesses may be started, separated by `:`, e.g. `/home/me/src:/home/me/projects`; they must exist at startup |
| `LIVE_ASSISTANT_DSH_PROFILE` | `dsh-tui` | Profile used to start DSH |
| `LIVE_ASSISTANT_DSH_FOUNDRY_TOKEN` | `0` | When set to `1`, an Entra temporary token is obtained for each new DSH session and injected as `FOUNDRY_TOKEN` |
| `LIVE_ASSISTANT_PORT` | `8787` | Listens only on `127.0.0.1` |
| `LIVE_ASSISTANT_ORIGIN` | loopback | When accessed through an HTTPS reverse proxy, set this to the exact origin the browser uses |
| `LIVE_ASSISTANT_VERIFY_TIMEOUT` | `600` | Timeout for independent verification commands (seconds) |
| `LIVE_ASSISTANT_UPLOAD_MB` | `2048` | Size limit for a single uploaded file (MiB) |
| `LIVE_ASSISTANT_HOOKS` | `1` | When set to `0`, no PermissionRequest hook is injected into Claude/Codex, and only screen recognition is used |
| `LIVE_ASSISTANT_CHROMIUM` | Bundled with Playwright | Chromium used by `test:browser` / `test:live` |

Except for `LIVE_ASSISTANT_PASSWORD`, `LIVE_ASSISTANT_STATE`, `LIVE_ASSISTANT_PORT`, `LIVE_ASSISTANT_ORIGIN` and `LIVE_ASSISTANT_CHROMIUM`, the environment variables in the table above are only defaults: after signing in, click the avatar in the top-right corner → "Settings" (`设置`) to change, in the page, each model's Foundry endpoint, subscription, deployment and voice, the workspace, the allowed roots, DSH, hooks, the verification timeout and the upload limit; changes take effect as soon as they are saved, with no need to restart or log in to the server. Changes made in the page are saved in `<STATE>/settings.json`, which records only items that differ from the defaults; a per-item "Restore default" (`恢复默认`) or "Restore all defaults" (`全部恢复默认`) removes the corresponding overrides. Everything is validated as a whole before saving, and if any item is invalid (e.g. a root does not exist), nothing is changed. While voice is connected, changing live voice settings prompts you to reconnect; changing the live voice endpoint or subscription requires disconnecting voice first, while the read-aloud and intent interpreter endpoints can be changed directly. Running sessions keep the hook setting they were created with. If saved overrides cannot be applied at startup (e.g. a root has been deleted), the service falls back to the defaults and reports the fault in the status bar. The "Preview" (`试听`) button next to each of the two voice dropdowns reads a sample sentence in the currently selected voice: the live voice preview opens a short GPT-Live session that does not capture the microphone (at most 30 seconds, counted toward Live usage), and the read-aloud preview makes one TTS call.

## Getting started

```sh
npm ci
nvm use 22                     # if dsh lives under nvm; sessions inherit this shell's environment
az login                       # needed for the FOUNDRY_*_ENDPOINT models or LIVE_ASSISTANT_DSH_FOUNDRY_TOKEN=1
read -rsp 'password (16+ chars): ' LIVE_ASSISTANT_PASSWORD; export LIVE_ASSISTANT_PASSWORD
LIVE_ASSISTANT_ROOTS="$HOME/projects" npm run assistant
```

Open `http://127.0.0.1:8787` in a browser on this machine. For remote use, set up an SSH tunnel, e.g. `ssh -L 8787:127.0.0.1:8787 <vm>`. The microphone requires a localhost or HTTPS secure context. When you stop the web backend with Ctrl-C, the terminal sessions keep running; the next start with the same state directory reattaches them. Sessions inherit the environment from **when this backend run was started**, so after changing the shell environment you need to restart the backend for it to apply to new sessions.

Basic usage:

- **New session**: click "New session ▾" (`新建 session ▾`) to open the harness menu (entries marked "Not found" (`未找到`) cannot be selected; arrow keys move, and Esc or clicking elsewhere closes it). Clicking an entry creates a session of that kind, and you then choose the default directory or a custom directory in the dialog.
- **Keyboard takeover**: typing or clicking in the TUI goes straight to the native CLI and automatically takes over the keyboard, and at the same time invalidates that session's undecided assistant input/keypress/terminal confirmation cards. The command bar button toggles between "Take over the keyboard / Hand back the keyboard" (`接管键盘 / 交还键盘`) (highlighted means you own the keyboard). Handing back only releases ownership, does not restore invalidated cards, and moves the input focus to the "Task / Feedback" (`任务 / 反馈`) input box (typing after that no longer goes to the terminal or takes it over again). Mouse movement, the scroll wheel, focus changes and terminal auto-replies are still forwarded to the CLI, but they do not count as a takeover and do not invalidate cards.
- **Copy and paste**: the CLI's mouse tracking is left as is (TUIs other than the shell receive clicks and drags, so a plain drag cannot select text). To copy, click "Select to copy" (`选择复制`) in the command bar (it becomes highlighted): the next press-drag-release only selects text in the page; on release, the selection is written to the clipboard with a notice showing the line and character counts, and the button resets; meanwhile mouse events are not sent to the harness, and Esc cancels. "Copy screen" (`复制屏幕`) copies the text of the current session's visible screen (soft-wrapped lines are joined back into one line) and shows a success notice. To paste, use "Paste" in the browser's context menu; Ctrl+V is still sent to the CLI as `^V` and Ctrl+C is still interrupt, and neither is used for the clipboard.
- **Hand off to the assistant** (`交给助手`): a request in the input box is passed to the intent interpreter together with the list of running sessions (name, note, harness) and the current page's session; if no session is named, it goes to the current page's session, and sessions with the same name are told apart by their tab notes. If the target or content cannot be identified, the error bar shows "Clarification required: …" explaining what is missing, and no card is created.
- **Proposals and errors**: pending cards are always at the top of the right column, with red errors below them, so errors neither cover cards nor block new ones; an error hides automatically once the backend error clears, and "Terminal not attached yet" (`终端尚未附着`) hides automatically once the terminal attaches. When you say "批准 N" (approve N) for a number that has already been invalidated or handled, the assistant tells the voice model and the page that proposal's status and the reason, instead of interrupting with an error. When context is appended to the voice model, it waits up to 60 seconds for acknowledgement (acknowledgement may be delayed while the model is speaking); if it still times out (`acknowledgement-unknown`), no more context is appended and you need to "Disconnect voice" (`断开语音`) and reconnect; disconnecting is not blocked by unacknowledged appends, and the terminal and cards are unaffected. While the voice session has not been confirmed closed (including "Connection failed" (`连接失败`)), the button always offers "Disconnect voice".
- **Uploading and downloading files**: "Upload files" (`上传文件`) in the command bar lets you select several files at once and saves each of them to the current session's **current working path** (in the shell it follows `cd`; for other harnesses it is the directory of their process). When done, a notice shows the saved path and size, and the voice assistant is informed (only of the path and size; the content is not read). A file with the same name is reported as an error and is not overwritten; rename or delete it yourself and upload again. An interrupted or oversized upload leaves no partial file. For "Download file" (`下载文件`), enter a file path relative to the current working path (or an absolute path), and the browser saves it; only a single regular file is supported, so archive directories in the shell first. Both upload and download paths must be inside the workspace or `LIVE_ASSISTANT_ROOTS`.
- **Voice controls**: the status pill next to the "Voice assistant" (`语音助手`) heading shows states such as Not connected / Connecting / Connected / Connection failed (`未连接` / `连接中` / `已连接` / `连接失败`). Once connected, "Connect voice" (`连接语音`) becomes a red-outlined "Disconnect voice" (`断开语音`) (it is the same button). "Microphone on/off" (`麦克风 开/关`) and "Assistant audio on/off" (`助手声音 开/关`) are toggles whose text and highlight show the current state; they are available only while connected and return to "on" after disconnecting and reconnecting.
- **Terminal size**: the terminal fills the black area and adapts to the browser window. When nobody has taken over the keyboard, the page being viewed directly determines the native PTY size; when another page has taken over the keyboard, its size wins.
- **Closing a tab**: the × on a tab terminates that session's process and closes the tab, with no confirmation; "Terminate process" (`终止进程`) at the top only ends the process and keeps the tab so you can view the last output.
- **Pending cards**: assistant-typed input, keypresses, creating/terminating sessions, terminal confirmations (`[y/N]`, CLI menus, trust dialogs) and native permission requests are all shown as numbered "N." cards (numbers cycle through 1–99, skipping numbers that are still pending or executing). On each card you can approve, reject, always allow, or "Handle in terminal" (`在终端处理`) (the page switches to that session and puts keyboard focus in the terminal).
- **The focused terminal is not interrupted**: while input focus is in a session's terminal (and the browser window is in the foreground), that session's terminal confirmations and native permission requests are hidden: no card pops up, nothing is read aloud, and the voice assistant does not remind you. Clicking a tab's name puts keyboard focus directly in that terminal. Items still pending when focus leaves pop up again with their original numbers (they do not get new numbers); only typing in the terminal or clicking "Handle in terminal" (`在终端处理`) ends the card and hands it over to the native prompt. Proposals you initiated, such as assistant-typed input or creating/closing sessions, are not affected.
- **Voice keypresses**: say key names to have the assistant send keys or key combinations to a session, e.g. "按 Esc，再输入 :wq 回车" (press Esc, then type :wq and Enter), "按 Ctrl+C" (press Ctrl+C), "按三次下箭头" (press the Down arrow three times). After you approve the "Keypress" (`按键`) card, the keys are sent in order (arrow keys, F1–F12 and so on are encoded according to the terminal's current mode). If you only describe the effect ("退出 vim", quit vim), the assistant asks which keys to press; combinations the terminal cannot distinguish (such as Ctrl+Enter or Ctrl+Shift+letter) are rejected.
- **Voice decisions**: say "批准 N" (approve N), "拒绝 N" (reject N) or "始终允许 N" (always allow N) (you can also say "好的，批准 3 号提案吧" (OK, approve proposal 3) or "拒绝提案 12" (reject proposal 12); negations, questions, quotations and long sentences do not count as authorization, and hidden cards can be decided by number as well). The English keywords approve / confirm / reject / always allow are recognized as well. Saying "等待反馈" (wait for feedback) clears always allow and invalidates the currently pending items.
- **Voice switching and closing**: saying "切到 codex" (switch to codex) switches the page directly to that session (no approval needed, and no input is sent). When you ask the assistant to send content to a session or to create a session, if you also ask it to "切过去/打开看看" (switch over / open it so I can see), the page follows as well (a new session is switched to after it is approved and started). Saying "关闭 codex 的 tab" (close codex's tab) creates a "Close tab" (`关闭 tab`) card; approving it terminates the process (if it is still running) and closes the tab.
- **First visit to a new directory**: Claude and Copilot ask whether to trust the directory, and Codex asks whether to trust the live hook; these are all native prompts, handled in the terminal or through cards.

## Testing

### Automated tests

| Command | Cost | Coverage |
|---|---|---|
| `npm test` | None | `tests/assistant.test.mjs`, `tests/live.test.mjs` and `tests/settings.test.mjs`: page settings (independent endpoint per model, validation, restrictions and persistence while voice is connected), real tmux PTY, environment inheritance and no secret leakage, default/custom working directories and root restrictions, uninstalled harnesses, closing tabs, hook process and socket, HTTP/WebSocket, file upload/download (no overwrite, out-of-bounds paths, size limit, cross-site), attach snapshot sequence numbers, typing in the terminal ending permission cards, hiding confirmations for the focused terminal / re-alerting with the original number after focus leaves / handing over to the terminal after typing without the native menu becoming a new card, whole-sentence recognition of voice decisions and deciding hidden cards by number, "Hand off to the assistant" (`交给助手`) carrying the running-session list and turning incomplete intents into clarifications, keypress proposals (key-name normalization, rejecting combinations the terminal cannot distinguish, bytes delivered through real tmux including application cursor mode, always allow and invalidation on takeover) and turning input with invisible control characters into clarifications, verification processes, Live protocol (local WebSocket test double); models use injected test doubles |
| `npm run test:browser` | None | headless Chromium: "Not found" (`未找到`) marking, new-session dialog (default/custom directory; keyboard focus enters the new terminal after creation), keyboard, multiple tabs, × closing a tab and terminating the process, terminal filling the area and resizing with the window with the PTY size following (last line not hidden by the frame), voice switching page focus, numbered card approval, keypress cards (step-by-step content, always allow, delivery of combinations such as Ctrl+A), "Handle in terminal" (`在终端处理`) switching to the target session and focusing the terminal, permission requests hidden while focus is in the terminal, cards reappearing with the original number after focus leaves, clicking a tab name focusing the terminal, pressing keys in the terminal ending cards, voice control states (unavailable/connected, toggling, reset on disconnect), upload (same-name error) and download, PID kept across refresh, narrow screen, full-screen TUI, mouse, select to copy (the TUI receives no mouse events during the drag selection, Esc cancels, forwarding resumes on later clicks), copy screen, paste, Ctrl-C, independent verification form and output, hand off to the assistant (Ctrl+Enter, submitting state and duplicate-submit prevention), conversation shown in alternating turns (not interrupted while scrolling back), top bar combining commands and server status, same-origin icons, avatar menu and settings dialog (display of defaults, invalid endpoint error without closing, per-item/all restore defaults, persistence after saving), sign-out (other tabs with the same login return to the sign-in page at the same time), tab colors and notes (kept after refresh), tab wrapping |
| `npm run test:live [-- --mandarin]` | **Paid** (Live) | Synthesized speech goes into the real `gpt-live-1`: voice proposal → card approval → real shell; requires `FOUNDRY_LIVE_ENDPOINT`, `FOUNDRY_INTENT_ENDPOINT` and `espeak-ng` |

Before the first public release (v0.2): `npm test` and `npm run test:browser` all passed; `test:live` in English mode passed with a configuration where live voice and the intent interpreter are on resources in different regions; Mandarin mode was not run.

The automated tests use only the shell and test-double CLIs; they do not need claude/codex/copilot/dsh installed and do not call models. The paid script creates a separate state directory on each run, cleans up the terminals it created when it finishes, and writes its results to `.live-assistant/voice-acceptance-*/result.json`.

### Manual testing with real harnesses

```sh
nvm use 22                     # if dsh is installed under nvm's Node 22
command -v claude codex copilot dsh
az login                       # only for the DSH token switch
read -rsp 'password: ' LIVE_ASSISTANT_PASSWORD; export LIVE_ASSISTANT_PASSWORD
LIVE_ASSISTANT_STATE=/tmp/live-manual LIVE_ASSISTANT_ROOTS=/tmp \
  LIVE_ASSISTANT_DSH_FOUNDRY_TOKEN=1 AZURE_SUBSCRIPTION_NAME='<foundry-subscription-name>' \
  npm run assistant
```

1. Click "New session ▾" (`新建 session ▾`); all four harnesses are selectable in the menu. After temporarily moving one CLI off PATH and restarting, it should show "(Not found)" (`（未找到）`) and be unselectable.
2. Create claude, codex, copilot and dsh sessions in turn (default directory); the status bar shows `/tmp/live-manual/workspace/<harness>-work`, each shows its native startup/trust screen, and no model routing configuration is needed.
3. dsh enters its TUI: press Esc, choose a Foundry model with `/model` and send a message, confirming that you get a reply using the temporary token.
4. In a shell session, run `echo $HOME $PATH`; the output should match the shell that started the backend (no `node_modules/.bin` prefix).
5. A custom directory of `/tmp/x/y` can be created; `/etc` should be reported as outside the allowed roots.
6. Click the × on a tab: the tab disappears and the corresponding process is gone from `ps`; "Terminate process" (`终止进程`) at the top ends the process but keeps the tab.
7. Trigger a tool call that needs permission in Claude/Codex, confirm that a "Tool permission" (`工具权限`) card appears, and that approving/rejecting takes effect in the CLI.

For more manual verification items, see the [manual test checklist in the operations guide](docs/live-assistant.md#manual-test-checklist).

## Risks and limitations

- **The web page equals local shell access**: it listens only on loopback, requires a password to sign in, and checks Origin. Do not expose the port directly to the internet; for remote access, use only an SSH tunnel or an HTTPS reverse proxy you configure yourself.
- **CLIs run with real permissions and your configuration**: harnesses run as the current user with your own CLI configuration (model, permission mode, sandbox), and inherit all environment variables from when the backend was started (including any credentials among them). The assistant does not bypass native permissions or sandboxes, but "Always allow" (`始终允许`) keeps automatically approving exactly identical prompts, input or key sequences in the same session until it is revoked, "等待反馈" (wait for feedback) is said, or the process exits. Use it only for repeatable, safe operations.
- **Working-directory restrictions only constrain where sessions start**: the root check only decides where a session starts from; once started, CLIs and the shell can still access any path within the user's permissions.
- **Screen recognition is not a strong approval protocol**: `[y/N]` and menu recognition is based on screen content, and such cards are labeled "Please check the terminal" (`请核对终端`). Only permission requests that go through a hook are structured, and that requires the CLI to support the hook and trust it (Copilot has no hook).
- **No hard cost cap**: Live bills continuously while the voice connection is open; this is a trade-off of the human-in-the-loop design, so click "Disconnect voice" (`断开语音`) when you are not using it. The UI shows only known usage, which is not the complete bill; the harnesses' own model costs depend on each CLI's configuration and are not included in the UI's statistics.
- **Single writer**: a state directory can have only one web backend, and a second backend is rejected before it changes any state; multiple browsers can share it. After a tmux or VM restart, the original processes are marked as lost, and the system never replays any input.
- **Not yet verified**: real human speech with physical microphones/speakers, prolonged noise/echo, end-to-end hook behavior in real CLIs, and pasting 6000 Chinese characters in the browser all still need manual testing.

## Contributing and security

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for the development environment and submission requirements. Please report security issues privately as described in [SECURITY.md](SECURITY.md), and do not open a public issue.

## License

[MIT](LICENSE). Notices for third-party assets are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
