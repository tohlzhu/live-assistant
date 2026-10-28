# Live Assistant

[English](README.md) | 简体中文

终端为主、语音为辅的独立任务助手。Shell、Claude Code、Codex、GitHub Copilot CLI 和 DSH（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）作为**当前 shell 中已安装、已配置好的原生 CLI**，继承 Live Assistant 的环境变量，运行在本机专属 tmux 的持久 PTY 中；浏览器 tab、Web 后端和语音连接都不拥有它们的生命周期。GPT-Live（`gpt-live-1`）负责对话，`gpt-6.1-sol` 把对话解释成**编号提案**，由人批准后才写入终端。新出现的待确认项可以通过 TTS（`gpt-4o-mini-tts`）朗读。

这是 **human-in-loop 的开发原型，不是生产服务**：系统不设执行次数、时效或调用上限，何时停止由使用者决定。文档：[架构](docs/architecture.zh-CN.md)、[威胁模型](docs/threat-model.zh-CN.md)、[设计决策 ADR-0002](docs/adr/0002-independent-live-assistant.zh-CN.md)、[运行指南](docs/live-assistant.zh-CN.md)。网页界面和语音助手目前使用中文。

## 环境要求

| 依赖 | 说明 |
|---|---|
| Linux + `tmux` 3.4 | 必需；助手使用专属 socket，不影响用户已有的 tmux |
| Node.js 22.19 | `npm ci` 会把固定版本安装到 `node_modules/.bin/node`，npm 脚本自动使用它，无需构建 |
| Harness CLI | `claude`、`codex`、`copilot`、`dsh` 由用户自行安装、登录和配置（模型、权限模式、沙箱等），助手**不写入它们的配置、不配置模型路由**，只按 PATH 查找并以无额外参数的方式启动（Claude/Codex 仅追加 hook 参数，见下文）。不在 PATH 中的 harness 在“新建 session”菜单中标注“未找到”，不能启动 |
| DSH | 若 `dsh` 安装在 nvm 管理的 Node 22 下，启动助手前先 `nvm use 22`，使它出现在 PATH 中。助手以 TUI 方式启动 `dsh --profile dsh-tui`，进入后按 Esc 并用 `/model` 选择 Foundry 模型 |
| Azure CLI | 语音、解释器、TTS 以及可选的 DSH 临时 token 需要 `az login`（Entra ID）；不使用 API key |
| Foundry 部署 | `gpt-live-1`（实时语音）、`gpt-6.1-sol`（语音与“交给助手”的意图解释）、`gpt-4o-mini-tts`（朗读）。纯终端使用不需要；每个模型都可选，部署名可以用环境变量覆盖 |
| Chromium | 仅测试需要：默认使用当前 Playwright 版本安装的 Chromium（`npx playwright install chromium`），或通过 `LIVE_ASSISTANT_CHROMIUM` 指定 |
| `espeak-ng` | 仅 `npm run test:live` 需要，用于合成测试语音 |

### Harness 启动方式

每个 session 继承启动 Live Assistant 时的 shell 环境变量（`npm run` 注入的 `npm_*`、`INIT_CWD` 和 `node_modules/.bin` PATH 前缀会被去掉，因此使用的是你 shell 里的 CLI，而不是仓库依赖），另加 `LIVE_SESSION_ID`、`LIVE_HOOK_SOCKET`。环境通过 tmux client 环境传递，不出现在命令行参数或磁盘文件中。每个新 session 还会读取当时的 `~/.bashrc`：shell 是交互式 bash，自己读取；其他 harness 经 `/bin/bash -ic 'exec "$0" "$@"' <命令>` 启动（交互模式才能越过 Ubuntu `~/.bashrc` 开头的非交互 `return`，`exec` 保留 CLI 的退出码）。因此修改 `~/.bashrc` 后新建 session 即生效，已运行的 session 不变；rc 只能新增或覆盖变量，从 rc 删掉的变量若已在继承环境中仍会保留。harness 是否已安装仍按继承的 PATH 判断。注意 `~/.bashrc` 中 export 的密钥也会进入每个 harness 进程。

各 CLI 对其工具子进程另有自己的环境策略：DSH 会从它启动的 shell/skill 子进程中去掉名称匹配 `KEY|PASSWORD|SECRET|TOKEN`（不区分大小写）的变量，因此 DSH 进程本身能看到例如 `EXAMPLE_API_KEY` 这样的变量，但它执行的 skill 脚本拿不到；DSH 目前没有放行白名单配置。Codex 的默认沙箱禁止联网，命令会先报 DNS 解析失败，再经权限卡片申请联网执行。

| Harness | 启动命令 |
|---|---|
| shell | `/bin/bash -i`（读取 `~/.bashrc`：彩色提示符、别名、补全、nvm 等） |
| claude | `claude`（启用 hook 时追加 `--settings '<PermissionRequest hook JSON>'`） |
| codex | `codex`（启用 hook 时追加 `-c hooks.PermissionRequest=...`，首次需在 CLI 内信任该 hook） |
| copilot | `copilot`（无 hook，权限提示靠屏幕识别） |
| dsh | `dsh --profile <LIVE_ASSISTANT_DSH_PROFILE>`，默认 `dsh-tui`；`LIVE_ASSISTANT_DSH_FOUNDRY_TOKEN=1` 时在创建 session 时取一个 Entra 临时 token 作为该进程的 `FOUNDRY_TOKEN` |

DSH 临时 token 等价于 `az account get-access-token --resource https://cognitiveservices.azure.com --subscription "$AZURE_SUBSCRIPTION_NAME"`，只存在于该 DSH 进程的环境中（不进 tmux 全局环境、参数、状态文件或日志），约 1 小时过期；过期后新建 DSH session 即可。之后改用长期端点时关闭该开关即可。

### 工作目录

新建 session 时会弹出对话框选择工作目录：

- **默认目录**：`<LIVE_ASSISTANT_WORKSPACE>/<harness>-work`，例如 `codex-work`，不存在时自动创建。
- **自定义目录**：绝对路径，或相对于工作区的路径。必须位于工作区或 `LIVE_ASSISTANT_ROOTS` 列出的某个根目录（含子目录）之内；符号链接按真实路径检查，越界返回 403。不存在的目录会被创建。

## 配置

非机密配置可以写在仓库根目录的 `.env`（npm 脚本通过 `--env-file-if-exists` 读取），参考 [.env.example](.env.example)。**密码、token 和密钥不要写进任何文件。**

| 变量 | 默认 | 说明 |
|---|---|---|
| `LIVE_ASSISTANT_PASSWORD` | — | 必需，至少 16 字符，只放在进程环境里 |
| `AZURE_SUBSCRIPTION_NAME` | 当前 az 默认订阅 | 显式传给 AzureCliCredential（语音、解释器、TTS 和 DSH 临时 token），不修改共享的 az 默认订阅；它只决定取 token 的 tenant，所以同一 tenant 内其他订阅里的 Foundry 资源也可用 |
| `FOUNDRY_LIVE_ENDPOINT` | 未设置 | 实时语音所在 Foundry 资源的 `https://<resource>.openai.azure.com`；三个模型各自指定资源，可以分布在不同 region。某个模型未设置 endpoint 时它显示为不可用，都未设置时只提供终端 |
| `FOUNDRY_LIVE_DEPLOYMENT` | `gpt-live-1` | 实时语音部署 |
| `FOUNDRY_LIVE_VOICE` | `marin` | 实时语音音色（`session.audio.output.voice`），每次连接创建时固定，改后下次连接语音生效；非法名称由 Foundry 拒绝 |
| `FOUNDRY_TTS_ENDPOINT` | 未设置 | 朗读所在 Foundry 资源 |
| `FOUNDRY_TTS_DEPLOYMENT` | `gpt-4o-mini-tts` | 朗读部署（`/openai/v1/audio/speech`） |
| `FOUNDRY_TTS_VOICE` | `alloy` | 朗读音色，取值以 TTS 部署支持的音色为准 |
| `FOUNDRY_INTENT_ENDPOINT` | 未设置 | 意图解释所在 Foundry 资源；未设置时语音和文字委派都无法解析 |
| `FOUNDRY_INTENT_DEPLOYMENT` | `gpt-6.1-sol` | 意图解释部署，只接受 `gpt-` 开头的部署名（需要遵守严格 JSON schema），例如 `gpt-6-luna` |
| `FOUNDRY_INTENT_EFFORT` | `low` | 意图解释的 `reasoning.effort`：`none/minimal/low/medium/high/xhigh`；各模型支持的取值不同（`gpt-6.1-sol` 不支持 `none`），不支持时请求返回 HTTP 400 |
| `LIVE_ASSISTANT_STATE` | `.live-assistant` | 私有状态：`sessions.json`、`events.jsonl`、`live-transcript.jsonl`、`live.json`、用量记录、tmux 与 hook socket |
| `LIVE_ASSISTANT_WORKSPACE` | `<STATE>/workspace` | Live Assistant 的工作区；默认 session 目录 `<harness>-work` 建在这里，它本身总是允许的根目录 |
| `LIVE_ASSISTANT_ROOTS` | 空 | 额外允许启动 harness 的根目录，用 `:` 分隔，例如 `/home/me/src:/home/me/projects`；启动时必须存在 |
| `LIVE_ASSISTANT_DSH_PROFILE` | `dsh-tui` | DSH 启动使用的 profile |
| `LIVE_ASSISTANT_DSH_FOUNDRY_TOKEN` | `0` | 设为 `1` 时为每个新 DSH session 获取 Entra 临时 token 并注入 `FOUNDRY_TOKEN` |
| `LIVE_ASSISTANT_PORT` | `8787` | 只监听 `127.0.0.1` |
| `LIVE_ASSISTANT_ORIGIN` | loopback | 经 HTTPS 反向代理访问时，填写浏览器使用的精确 origin |
| `LIVE_ASSISTANT_VERIFY_TIMEOUT` | `600` | 独立验收命令超时（秒） |
| `LIVE_ASSISTANT_UPLOAD_MB` | `2048` | 单个上传文件的大小上限（MiB） |
| `LIVE_ASSISTANT_HOOKS` | `1` | 设为 `0` 时不向 Claude/Codex 注入 PermissionRequest hook，只靠屏幕识别 |
| `LIVE_ASSISTANT_CHROMIUM` | Playwright 自带 | `test:browser` / `test:live` 使用的 Chromium |

除 `LIVE_ASSISTANT_PASSWORD`、`LIVE_ASSISTANT_STATE`、`LIVE_ASSISTANT_PORT`、`LIVE_ASSISTANT_ORIGIN` 和 `LIVE_ASSISTANT_CHROMIUM` 外，上表的环境变量只是默认值：登录后点右上角头像 → “设置”即可在页面上修改各模型的 Foundry endpoint、订阅、部署、音色、工作区、允许的根目录、DSH、hook、验收超时和上传上限，保存后立即生效，无需重启或登录服务器。页面修改保存在 `<STATE>/settings.json`，只记录与默认值不同的项；单项“恢复默认”或“全部恢复默认”会删除对应覆盖。保存前整体校验，任一项无效（如根目录不存在）则不做任何改动。语音已连接时，更改实时语音相关项会提示重新连接；更改实时语音的 endpoint 或订阅必须先断开语音，朗读和意图解释的 endpoint 可以直接修改。已运行的 session 保留创建时的 hook 设置。启动时若已保存的覆盖无法应用（如根目录已删除），服务回退到默认值并在状态栏报告故障。两个音色下拉框旁的“试听”按钮分别用当前所选音色朗读一句示例：实时语音试听会开一个不采集麦克风的短 GPT-Live 会话（最长 30 秒，计入 Live 用量），朗读试听调用一次 TTS。

## 启动

```sh
npm ci
nvm use 22                     # if dsh lives under nvm; sessions inherit this shell's environment
az login                       # needed for the FOUNDRY_*_ENDPOINT models or LIVE_ASSISTANT_DSH_FOUNDRY_TOKEN=1
read -rsp 'password (16+ chars): ' LIVE_ASSISTANT_PASSWORD; export LIVE_ASSISTANT_PASSWORD
LIVE_ASSISTANT_ROOTS="$HOME/projects" npm run assistant
```

在本机浏览器打开 `http://127.0.0.1:8787`。远程使用时建立 SSH 隧道，例如 `ssh -L 8787:127.0.0.1:8787 <vm>`。麦克风需要 localhost 或 HTTPS 安全上下文。用 Ctrl-C 停止 Web 后端时，终端 session 会继续运行；下次用同一状态目录启动会重新接上。session 继承的是**启动这次后端时**的环境，修改 shell 环境后需重启后端才对新 session 生效。

基本用法：

- **新建 session**：点“新建 session ▾”展开 harness 菜单（“未找到”的不可选；方向键移动、Esc 或点别处收起），点中哪个就新建哪种 session，随后在对话框中选默认目录或自定义目录。
- **键盘接管**：打字或在 TUI 中点击会直接进入原生 CLI 并自动接管键盘，同时作废该 session 中尚未决定的助手输入/按键/终端确认卡片。命令栏按钮在“接管键盘 / 交还键盘”之间切换（高亮表示你拥有键盘）；交还只释放拥有权，不恢复已作废的卡片，并把输入焦点移到“任务 / 反馈”输入框（之后打字不会再进入终端、重新接管）。鼠标移动、滚轮、焦点切换和终端自动应答仍转发给 CLI，但不算接管、不作废卡片。
- **复制与粘贴**：CLI 的鼠标跟踪保持原样（shell 以外的 TUI 会接收点击和拖动，因此直接拖动不能选中文本）。需要复制时点命令栏的“选择复制”（高亮）：下一次按下-拖动-松开只在页面中选择文本，松开即写入剪贴板并提示行数与字符数，按钮随即复位；期间鼠标事件不会发给 harness，Esc 取消。“复制屏幕”复制当前 session 可见屏幕的文本（自动换行的行会拼回一行）并提示成功。粘贴使用浏览器右键菜单的“粘贴”；Ctrl+V 仍作为 `^V` 发给 CLI，Ctrl+C 仍是中断，均不用于剪贴板。
- **交给助手**：输入框的请求会连同运行中的 session 清单（名称、备注、harness）和当前页面的 session 一起交给解释器，不点名时发给当前页面的 session；同名 session 用 tab 备注区分。识别不出目标或内容时，报错栏显示“Clarification required: …”并说明缺什么，不生成卡片。
- **提案与报错**：待确认卡片总在右栏最上方，红色报错在其下方，不遮挡卡片也不阻塞新卡片；后端错误消除后报错自动隐藏，终端附着后“终端尚未附着”自动隐藏。对已作废/已处理的编号说“批准 N”时，助手会告诉语音模型和页面该提案的状态与原因，不再报错中断。向语音模型追加上下文时最多等待 60 秒确认（模型说话期间确认可能延后）；仍超时（`acknowledgement-unknown`）后不再追加，需要“断开语音”后重连，断开不会被未确认的追加阻塞；终端和卡片不受影响。语音会话未确认关闭时（包括“连接失败”），按钮始终提供“断开语音”。
- **上传与下载文件**：命令栏“上传文件”可一次选多个文件，逐个保存到当前 session 的**当前工作路径**（shell 中 `cd` 后随之变化，其他 harness 为其进程所在目录），完成后提示保存路径与大小，并告知语音助手（只告知路径和大小，不读取内容）。同名文件直接报错、不覆盖，请自行改名或删除后再传；上传中断或超限不会留下半截文件。“下载文件”填写相对当前工作路径的文件路径（或绝对路径），由浏览器保存；只支持单个普通文件，目录请先在 shell 中打包。上传与下载的路径都必须位于工作区或 `LIVE_ASSISTANT_ROOTS` 之内。
- **语音控制**：“语音助手”标题旁的状态胶囊显示未连接/连接中/已连接/连接失败等状态。“连接语音”连接后变为红框的“断开语音”（同一个按钮）；“麦克风 开/关”与“助手声音 开/关”是开关，文字与高亮表示当前状态，仅在连接后可用，断开重连后恢复为“开”。
- **终端尺寸**：终端占满黑色区域并随浏览器窗口自适应；没人接管键盘时，正在查看的页面直接决定原生 PTY 的尺寸，另一页面接管键盘时以它的尺寸为准。
- **关闭 tab**：tab 上的 × 会终止该 session 的进程并关闭 tab，无需确认；顶部“终止进程”只结束进程、保留 tab 以便查看最后输出。
- **待确认卡片**：助手代输入、按键、新建/终止 session、终端确认（`[y/N]`、CLI 菜单、信任对话框）和原生权限请求，都显示为“N.”编号卡片（编号在 1–99 间循环，跳过仍待决或执行中的编号），可选择批准、拒绝、始终允许或在终端处理（页面切到该 session 并把键盘焦点放进终端）。
- **焦点所在的终端不打扰**：输入焦点在某个 session 的终端里（且浏览器窗口在前台）时，该 session 的终端确认和原生权限请求隐藏起来，不弹卡片、不朗读，语音助手也不提醒；点击 tab 名称会直接把键盘焦点放进该终端。焦点离开时仍在等待的项以原编号重新弹出（不会变成新编号）；在终端里打字或点“在终端处理”才结束卡片并交给原生提示。由你发起的代输入、新建/关闭等提案不受影响。
- **语音按键**：说出键名即可让助手向 session 发送按键或组合键，例如“按 Esc，再输入 :wq 回车”“按 Ctrl+C”“按三次下箭头”；批准“按键”卡片后按顺序发送（方向键、F1–F12 等按终端当前模式编码）。只说效果（“退出 vim”）时助手会问要按哪些键；终端无法区分的组合（如 Ctrl+Enter、Ctrl+Shift+字母）会被拒绝。
- **语音决策**：说“批准 N”“拒绝 N”“始终允许 N”（也可以说“好的，批准 3 号提案吧”“拒绝提案 12”；否定、疑问、引述和长句不算授权，被隐藏的卡片同样可按编号决定）；说“等待反馈”会清除始终允许，并作废当前待决项。
- **语音切换与关闭**：说“切到 codex”页面会直接切换到该 session（无需批准，不发送任何输入）；让助手向某个 session 发内容或新建 session 时，如果你要求“切过去/打开看看”，页面也会跟过去（新建的在批准并启动后切换）。说“关闭 codex 的 tab”会生成“关闭 tab”卡片，批准后终止进程（如仍在运行）并关闭 tab。
- **首次进入新目录**：Claude、Copilot 会询问是否信任该目录，Codex 会询问是否信任 live hook；这些都是原生提示，在终端里或通过卡片处理。

## 测试

### 自动化测试

| 命令 | 费用 | 内容 |
|---|---|---|
| `npm test` | 无 | `tests/assistant.test.mjs`、`tests/live.test.mjs` 与 `tests/settings.test.mjs`：页面设置（各模型独立 endpoint、校验、语音连接时的限制与持久化）、真实 tmux PTY、环境继承与秘密不外泄、默认/自定义工作目录与根目录限制、未安装 harness、关闭 tab、hook 进程与 socket、HTTP/WebSocket、文件上传下载（不覆盖、越界、大小上限、跨站）、附着快照序号、终端里打字结束权限卡片、焦点所在终端的确认隐藏/离开后以原编号重新提醒/打字后转交终端且原生菜单不成新卡片、语音决定的整句识别与隐藏卡片的编号决定、“交给助手”带运行中 session 清单且不完整意图转为澄清、按键提案（键名规范化、拒绝终端无法区分的组合、真实 tmux 送达字节含应用光标模式、始终允许与接管作废）与不可见控制字符输入转为澄清、验收进程、Live 协议（本地 WebSocket 替身）；模型使用注入的替身 |
| `npm run test:browser` | 无 | headless Chromium：“未找到”标注、新建对话框（默认/自定义目录，创建后键盘焦点进入新终端）、键盘、多 tab、× 关闭 tab 并终止进程、终端占满并随窗口缩放且 PTY 尺寸跟随（末行不被外框遮挡）、语音切换页面焦点、编号卡片批准、按键卡片（逐步内容、始终允许、Ctrl+A 等组合键送达）、“在终端处理”切到目标 session 并聚焦终端、焦点在终端时权限请求隐藏、离开焦点后原编号卡片重现、点击 tab 名称聚焦终端、在终端按键结束卡片、语音控件状态（不可用/已连接、开关切换、断开复位）、上传（同名报错）与下载、刷新保留 PID、窄屏、全屏 TUI、鼠标、选择复制（拖选期间 TUI 收不到鼠标、Esc 取消、之后点击恢复转发）、复制屏幕、粘贴、Ctrl-C、独立验收表单与输出、交给助手（Ctrl+Enter、提交中状态与防重复提交）、对话按轮次交替显示（翻看时不被打断）、顶部栏合并命令与服务器状态、同源图标、头像菜单与设置对话框（默认值展示、无效 endpoint 报错不关闭、单项/全部恢复默认、保存后持久化）、登出（同一登录的其他 tab 同时回到登录页）、tab 颜色与备注（刷新后保留）、tab 折行 |
| `npm run test:live [-- --mandarin]` | **付费**（Live） | 合成语音进入真实 `gpt-live-1`，语音提案 → 卡片批准 → 真实 shell；需要 `FOUNDRY_LIVE_ENDPOINT`、`FOUNDRY_INTENT_ENDPOINT` 与 `espeak-ng` |

首个公开版本（v0.2）发布前：`npm test` 与 `npm run test:browser` 全部通过；`test:live` 英文模式在实时语音与意图解释分属不同 region 资源的配置下通过，普通话模式未运行。

自动化测试只使用 shell 和测试替身 CLI，不需要安装 claude/codex/copilot/dsh，也不调用模型。付费脚本每次新建独立状态目录，结束时清理自己创建的终端，结果写到 `.live-assistant/voice-acceptance-*/result.json`。

### 真实 harness 手工测试

```sh
nvm use 22                     # if dsh is installed under nvm's Node 22
command -v claude codex copilot dsh
az login                       # only for the DSH token switch
read -rsp 'password: ' LIVE_ASSISTANT_PASSWORD; export LIVE_ASSISTANT_PASSWORD
LIVE_ASSISTANT_STATE=/tmp/live-manual LIVE_ASSISTANT_ROOTS=/tmp \
  LIVE_ASSISTANT_DSH_FOUNDRY_TOKEN=1 AZURE_SUBSCRIPTION_NAME='<foundry-subscription-name>' \
  npm run assistant
```

1. 点“新建 session ▾”，菜单中四个 harness 都可选；临时把某个 CLI 移出 PATH 后重启，应显示“（未找到）”且不可选。
2. 依次新建 claude、codex、copilot、dsh（默认目录），状态栏显示 `/tmp/live-manual/workspace/<harness>-work`，各自出现原生启动/信任界面，无需任何模型路由配置。
3. dsh 进入 TUI：按 Esc，`/model` 选择 Foundry 模型并发一条消息，确认使用临时 token 能得到回复。
4. 在 shell session 中执行 `echo $HOME $PATH`，应与启动后端的 shell 一致（无 `node_modules/.bin` 前缀）。
5. 自定义目录填 `/tmp/x/y` 可以创建；填 `/etc` 应提示超出允许的根目录。
6. 点 tab 上的 ×：tab 消失，`ps` 中对应进程结束；顶部“终止进程”结束进程但保留 tab。
7. Claude/Codex 触发一次需要权限的工具调用，确认出现“工具权限”卡片，批准/拒绝后 CLI 中生效。

更多人工验收项见[运行指南中的人工测试清单](docs/live-assistant.zh-CN.md#人工测试清单)。

## 风险与限制

- **Web 页面等于本机 shell 权限**：只监听 loopback，用密码登录，并检查 Origin。不要把端口直接暴露到公网；远程访问只走 SSH 隧道或自行配置的 HTTPS 反向代理。
- **CLI 使用真实权限和你的配置**：harness 以当前用户身份、按你自己的 CLI 配置（模型、权限模式、沙箱）运行，并继承启动后端时的全部环境变量（包括其中的任何凭据）。助手不会绕过原生权限和沙箱，但“始终允许”会对同一 session 中完全相同的提示、输入或按键序列持续自动放行，直到撤销、等待反馈或进程退出。请只对可重复的安全操作使用。
- **工作目录限制只约束启动位置**：根目录检查只决定 session 从哪里启动，CLI 和 shell 启动后仍能访问用户权限内的任何路径。
- **屏幕识别不是强审批协议**：`[y/N]` 和菜单识别基于屏幕内容，卡片会标注“请核对终端”。只有通过 hook 的权限请求才是结构化的，而且需要 CLI 支持并信任该 hook（Copilot 没有 hook）。
- **费用没有硬上限**：语音连接保持期间 Live 持续计费，这是 human-in-loop 设计的取舍，不用时请点“断开语音”。界面只显示已知用量，不等于完整账单；harness 自身的模型费用由各 CLI 的配置决定，不在界面统计中。
- **单写者**：一个状态目录只能有一个 Web 后端，第二个后端在改动任何状态前被拒绝；多个浏览器可以共享它。tmux 或 VM 重启后，原进程会被标记为 lost，系统不会重放任何输入。
- **尚未验收**：真人语音与物理麦克风/扬声器、长时间噪声/回声、真实 CLI 中 hook 的端到端行为、浏览器中 6000 字中文粘贴，都需要人工测试。

## 参与贡献与安全

欢迎提交 issue 和 pull request，开发环境与提交要求见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。安全问题请按 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 私下报告，不要公开提 issue。

## 许可证

[MIT](LICENSE)。第三方素材的声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
