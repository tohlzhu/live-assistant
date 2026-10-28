# Live Assistant：运行、恢复与验收

[English](live-assistant.md) | 简体中文

## 启动

需要本机 `tmux` 3.4。`npm ci` 会把固定的 Node 22.19.0 安装到 `node_modules/.bin/node`，npm 脚本自动使用它；没有构建步骤。不修改系统服务。claude、codex、copilot、dsh 由用户自行安装和配置，助手只在 PATH 中查找并启动它们；如果 dsh 装在 nvm 管理的 Node 22 下，启动前先 `nvm use 22`。

```sh
nvm use 22
# Keep the application password in the process environment, not a file or log.
read -rsp 'live assistant password (16+ characters): ' LIVE_ASSISTANT_PASSWORD
export LIVE_ASSISTANT_PASSWORD
npm run assistant
```

默认只监听 `127.0.0.1:8787`。打开对应 loopback URL，使用上述密码登录。登录有效期 8 小时；右上角头像菜单中的“登出”会作废本次登录并断开所有用同一登录打开的页面，终端 session 继续运行。同一栏显示服务器 CPU 占用、内存已用量和工作区所在磁盘的占用比例，每 5 秒更新；悬停可看负载、总量与可用量、tmux 服务 PID 及每个运行中 session 的 pane PID。远程访问使用已授权的 SSH loopback 隧道，或自行配置 HTTPS 代理并设置精确的 `LIVE_ASSISTANT_ORIGIN`；不要直接把有 shell 执行权限的接口暴露到公网。浏览器使用 HTTPS 或 localhost 安全上下文采集麦克风。

| 配置 | 说明 |
|---|---|
| `LIVE_ASSISTANT_PASSWORD` | 必需，至少 16 字符，仅进程环境；不放 Foundry token/API key |
| `LIVE_ASSISTANT_STATE` | 默认 `.live-assistant`，私有状态与 tmux socket |
| `LIVE_ASSISTANT_WORKSPACE` | 默认该目录下 `workspace`；默认 session 目录 `<harness>-work` 建在这里，总是允许的根目录 |
| `LIVE_ASSISTANT_ROOTS` | 额外允许启动 harness 的根目录（`:` 分隔，含子目录），启动时必须存在 |
| `LIVE_ASSISTANT_DSH_PROFILE` | DSH profile，默认 `dsh-tui` |
| `LIVE_ASSISTANT_DSH_FOUNDRY_TOKEN` | 设为 `1` 时为每个新 DSH session 获取 Entra 临时 token 作为 `FOUNDRY_TOKEN` |
| `LIVE_ASSISTANT_PORT` | 默认 8787；测试用随机端口，避免干扰已有服务 |
| `LIVE_ASSISTANT_ORIGIN` | 可选，受信浏览器的精确 scheme/host/port |
| `FOUNDRY_LIVE_ENDPOINT` / `FOUNDRY_TTS_ENDPOINT` / `FOUNDRY_INTENT_ENDPOINT` | 实时语音、朗读、意图解释各自所在授权 Foundry 资源的 HTTPS OpenAI 根端点，可以在不同 region，参考 `.env.example`；未设置的模型不可用 |
| `AZURE_SUBSCRIPTION_NAME` | 显式传给 AzureCliCredential，不切换共享默认订阅；只决定 token 的 tenant，各资源须在同一 tenant 且已授予调用者 Azure AI 角色 |
| `FOUNDRY_LIVE_DEPLOYMENT` | 默认 `gpt-live-1` |
| `FOUNDRY_LIVE_VOICE` | 默认 `marin`；实时语音音色，创建连接时固定，下次连接语音生效 |
| `FOUNDRY_TTS_DEPLOYMENT` | 默认 `gpt-4o-mini-tts`；用于待确认提醒朗读（`/api/speech`） |
| `FOUNDRY_TTS_VOICE` | 默认 `alloy`；朗读音色 |
| `FOUNDRY_INTENT_DEPLOYMENT` | 默认 `gpt-6.1-sol`；只接受 `gpt-` 开头的部署名 |
| `FOUNDRY_INTENT_EFFORT` | 默认 `low`；意图解释的思考强度，取值 `none/minimal/low/medium/high/xhigh`，模型不支持的取值由 Foundry 返回 400 |
| `LIVE_ASSISTANT_VERIFY_TIMEOUT` | 独立验收超时秒数，默认 600 |
| `LIVE_ASSISTANT_HOOKS` | 设为 `0` 时不给 Claude/Codex 注入 PermissionRequest hook，仅用屏幕识别 |
| `LIVE_ASSISTANT_CHROMIUM` | `test:browser` / `test:live` 使用的 Chromium 路径，默认当前 Playwright 版本安装的 Chromium |

除密码、状态目录、端口、origin 和 Chromium 路径外，上表的环境变量都是默认值，可在头像菜单 → “设置”中覆盖并立即生效（保存在 `<STATE>/settings.json`，详见 [README](../README.zh-CN.md#配置)）；更改实时语音的 endpoint 或订阅前需先断开语音（朗读和意图解释的 endpoint 不需要），音色旁的“试听”按钮用所选音色朗读示例（实时语音试听是一次短 GPT-Live 会话，计入用量）。

未配置 Foundry 时终端仍可用，语音、朗读和模型驱动任务管理明确显示不可用。配置 Foundry 并完成原生 Entra 登录后，实时模型使用 `gpt-live-1`，意图解释默认使用 `gpt-6.1-sol`（思考强度 `low`），朗读使用 TTS 部署。不静默选择替代模型，不使用 API key。

各 harness 使用的模型由 CLI 自己的配置决定，助手不配置模型路由：Claude、Codex、Copilot 直接按用户配置启动；DSH 以 `dsh --profile dsh-tui` 进入 TUI，按 Esc 后用 `/model` 选择 Foundry 模型。session 继承启动后端时的 shell 环境（去掉登录密码 `LIVE_ASSISTANT_PASSWORD`、`npm run` 注入的变量与 PATH 前缀），环境经 tmux client 环境传递，不出现在命令行参数或磁盘中。开启 DSH token 开关时，token 只注入该 DSH 进程，约 1 小时过期，过期后新建 DSH session 即可。

## 使用：human-in-loop

本软件不是无限自动循环：由用户决定何时停止。系统不设执行次数、条数、授权次数/时效或月度调用上限；只保留防止进程崩溃的字节级缓冲。

- **终端**：点“新建 session ▾”在展开的菜单中选择 harness（未安装的标注“未找到”，不可选）新建 session，在对话框中选择默认目录 `<workspace>/<harness>-work` 或允许根目录内的自定义目录（越界返回 403；符号链接按真实路径检查）；点击 tab 切换，直接打字即操作原生 CLI（打字或点击会自动接管键盘，并使该 session 中尚未决定的输入/按键/终端确认提案失效；鼠标移动、滚轮、焦点与终端应答只转发、不算接管。命令栏按钮在“接管键盘 / 交还键盘”间切换，交还不恢复已作废的提案，并把输入焦点移到“任务 / 反馈”输入框）。键鼠、控制键、粘贴（自动分片）、resize、原生信任/权限提示均由真实 terminal/CLI 处理。终端占满黑色区域并随窗口自适应：无人接管键盘时由正在查看的页面决定 PTY 尺寸，有人接管时以接管页面为准。其他 session 持续执行，各 session 的操作互不阻塞。
- **Tab 标识**：tab 默认无色，点击名称左侧的小圆点，从 8 种预设色中选择（或选“无”清除），选中 tab 的下边线和终端边框也会使用该颜色；双击 tab 名称可添加或修改备注（最多 40 字符，Enter 保存，Esc 取消，清空即删除）。颜色和备注会立即保存，刷新后保留，并作为 session 摘要的一部分交给助手，但不影响授权。状态为 running 时 tab 上不显示状态词，只有 terminated 等其他状态才显示；tab 过多时折行显示，不出现横向滚动条。
- **文件**：“上传文件”把所选文件逐个保存到当前 session 的当前工作路径（tmux `pane_current_path`，shell 中 `cd` 后随之变化），同名报错不覆盖，大小上限 `LIVE_ASSISTANT_UPLOAD_MB`（默认 2048），完成后静默告知语音助手路径与大小；“下载文件”按相对当前工作路径的路径（或绝对路径）下载单个普通文件。两者都要求路径位于允许的根目录内。
- **编号提案**：助手代输入、按键、新建/终止 session、识别到的终端确认（`[y/N]`、Codex/Claude 菜单、信任对话框）以及原生权限请求都显示为“N.”编号卡片（编号 1–99 循环，跳过仍待决或已批准执行中的编号；语音按纯数字读，例如“3 号”），可同时存在多张，按任意顺序决定。按钮：批准 / 拒绝 / 始终允许 / 在终端处理（仅原生权限请求）。卡片注明“解析期间你操作过该终端”时请再核对。
- **焦点所在的终端不打扰**：页面输入焦点在某个 session 的终端里（且该浏览器窗口在前台）时，这个 session 产生的终端确认和原生权限请求只隐藏、不弹卡片、不朗读，并告知语音助手不要提醒（hook 继续等待）。点击 tab 名称会把键盘焦点放进该 session 的终端，与点“在终端处理”一样触发隐藏。焦点离开时仍在等待的项以**原编号**重新弹出并提醒，不会生成新卡片。在该终端里打字（或点“在终端处理”）才真正结束卡片：hook 放弃、原生提示接管，随后出现的原生菜单在你按 Enter 前不会再识别成新卡片。助手代输入、新建/关闭等由你发起的提案不受影响。
- **始终允许**：对同一 session 中完全相同的提示、输入或按键序列持续自动放行，不计次、不限时；“撤销”按钮、“等待反馈”、进程退出或终止会清除。旧授权不跨 session。
- **原生权限 hook**：Claude Code 通过 `--settings`、Codex 通过 `-c hooks.PermissionRequest=...` 注入本地 hook。hook 经 `hook.sock`（权限 600）把请求交给你决定；选择“在终端处理”或 Web 后端不可用时 hook 不输出，原生提示照常出现；点“在终端处理”后页面会切到该 session 并把键盘焦点放进终端，可直接在原生提示中操作；直接在终端里回答原生提示时，对应卡片随第一次按键结束。Codex 对非托管 hook 需要在 CLI 内用 `/hooks` 信任一次。
- **语音**：连接后可要求新建 session、追加/修改/继续、按键、查询状态或取消。按键须说出键名，例如“给 vim 按 Esc，再输入 :wq 回车”“按 Ctrl+C”“按三次下箭头”“按 Shift+Tab”：卡片标题为“按键”，内容逐步列出（`Escape → ":wq" → Enter`），批准后按顺序发送，支持可见字符、Enter/Esc/Tab/Space/Backspace、方向键、Home/End、PageUp/PageDown、Insert/Delete、F1–F12 及 Ctrl/Alt/Shift 组合；只描述效果（“退出 vim”“中断它”）时助手会问要按哪些键。终端无法区分的组合（Ctrl+Enter、Shift+Enter、Shift+Esc、Ctrl+Tab、Ctrl+Backspace、Ctrl+Shift+字母、Shift+非字母）会被说明并拒绝，不会改发成别的键。决定用“批准 N / 拒绝 N / 始终允许 N”（支持中文数字，也接受“好的，批准 3 号提案吧”“拒绝提案 12”“不同意 5 号”这类整句；焦点在终端而被隐藏的卡片也可按编号决定）；只有一张待决卡片时可省略编号。整句必须只由客套词、决定词、编号和“提案/号/吧”等组成：否定（“不批准 3 号”）、疑问（“批准 3 号吗”）、引述（“他说批准”）、一句多项和夹在长句中的决定词都不算授权，助手自己的话和沉默也不授权；没被识别时语音助手会请你按“批准 N”再说一遍。“等待用户意见/等待反馈/暂停当前会话”立即清除焦点 session 的始终允许并作废其待决提案，不冻结进程。“切到某 session”直接切换页面（不发送内容、不需批准）；发送或新建时要求“切过去”，页面会跟随（新建的在批准启动后切换）；“关闭某 tab”生成“关闭 tab”卡片，批准后终止进程并关闭 tab。
- **复制与粘贴**：CLI 的鼠标跟踪保持原样（shell 以外的 TUI 会接收点击和拖动，因此直接拖动不能选中文本）。需要复制时点命令栏的“选择复制”（高亮）：下一次按下-拖动-松开只在页面中选择文本，松开即写入剪贴板并提示行数与字符数，按钮随即复位；期间鼠标事件不会发给 harness，Esc 取消。“复制屏幕”复制当前 session 可见屏幕的文本（自动换行的行会拼回一行）并提示成功。粘贴使用浏览器右键菜单的“粘贴”；Ctrl+V 仍作为 `^V` 发给 CLI，Ctrl+C 仍是中断，均不用于剪贴板。
- **交给助手**：输入框的文字连同运行中的 session 清单（名称、备注、harness）和当前页面的 session 交给解释器；不点名 session 时发给当前页面的 session。同名 session（例如两个 shell）请用备注区分。无法确定目标或内容时不生成卡片，报错栏显示“Clarification required: …”说明缺什么。
- **卡片与报错的顺序**：卡片在右栏顶部，报错在其下方且不浮动；后端错误消除后自动隐藏。语音决定指向已不在待决状态的编号时，助手回报该编号的状态与原因（例如“用户接管了终端”）并回应该次 delegation；解释失败、语音决定没生效或客户端已直接处理过同一句话时同样回应 delegation，语音模型不会一直等待。
- **朗读提醒**：勾选“朗读待确认提醒”后，新出现的卡片由 TTS 朗读编号与内容摘要（偏好保存在本浏览器）。
- **对话文本**：右侧栏按说话顺序逐轮显示“你：/助手：”，交给助手处理（委派）后或停顿超过 1.5 秒另起一轮，转写没有可用时间戳时助手回复后也另起一轮；停在底部时随新语音滚动，向上翻看时不被打断。
- **上下文压缩**：发给 Live 和解释器的终端内容先去除 spinner、计时器、边框并去重，每个 session 只发送新增行；目录只发送变化的 session；超长转写折叠旧内容，而不是报错或拒绝。用户终端本身保留原始输出。

“语音助手”标题旁的状态胶囊显示连接状态（未连接、连接中…、已连接、连接受损、连接失败、正在断开…；失败原因显示在控件下方）。“连接语音 / 断开语音”是同一个按钮，连接后变为红框的“断开语音”；“麦克风 开/关”“助手声音 开/关”是开关，文字和高亮始终表示当前状态，未连接时不可用。关闭助手声音只停播放（提醒改为静默上下文）；关闭麦克风只停采集；断开语音只关闭 Provider 会话，重连后两个开关都恢复为“开”。关闭或刷新页面、关闭 Web 后端都不终止终端。只有明确终止、关闭 tab 或批准取消提案才结束指定 session：tab 上的 × 终止进程并关闭 tab（不再确认，终止未确认时 tab 保留并报错）；顶部“终止进程”结束进程但保留 tab。

### 托管 run 与独立验收

追加、修改和继续经授权后产生新的 managed run，旧 run 标记 `superseded`，不冒充旧执行已取消；按键只操控当前任务，不新建 run。原生终端输出只携带 processRunId、observationId 和递增 sequence；混合 CLI 输出不猜测为某个任务的完成事件。

“独立验收”只执行用户明确提供并确认的本地命令，绑定 runId；结果为 passed/failed/unknown/stale。超时可配置（默认 10 分钟），命令在独立进程中运行、不出现在终端里；输出保留尾部（最多 16000 字符），可在状态行下方展开“验收输出（尾部）”查看，进行中可点击“取消验收”。新的输入使迟到结果标为 stale；重复 operation ID 不重跑；重启后未确认的验收标为 unknown、不重放。`passed` 只证明该次命令通过。

## 恢复与资源

新建 session 的初始任务在启动输出稳定后才送达；送达前若你接管键盘，该任务被放弃。Web 后端退出时关闭 Live 会话和观察器，保留 tmux session；再次使用同一状态目录启动会重新观察原进程，已批准但未确认送达的提案标为 uncertain、待决提案作废，不重投输入。tmux/VM 重启后不存在的进程标记 lost。

状态保存在 `sessions.json`（v2，自动从 v1 迁移；只保留最近已决提案/操作作为工作集），完整历史追加到 `events.jsonl`，Live 转写与委派边界脱敏后追加到 `live-transcript.jsonl`（只在本机，超过 4 MiB 轮转），Live 会话记录与月度用量在 `live.json`，解释器用量在 `interpreter-usage.json`。已关闭的 tab 在 `sessions.json` 中标记 `closed`，不再出现在界面与 Live 目录中。各文件说明见[架构](architecture.zh-CN.md#状态与恢复)。

通过界面逐个终止或关闭不再需要的 session；仅关闭 Web 进程不会清理它们。tmux server 在没有 session 时随 Web 后端退出；不使用全局 `tmux kill-server` 或按进程名批量 kill。

## 验证命令

```sh
npm test               # unit and integration tests, no model calls
npm run test:browser   # headless Chromium against a temporary backend

# Paid: real gpt-live-1 session in an isolated state directory under .live-assistant/.
npm run test:live
npm run test:live -- --mandarin
# Reuse previously accepted Mandarin audio; the new Live workflow still runs for real.
npm run test:live -- --mandarin --mandarin-fixtures .live-assistant/<accepted-voice-evidence>
```

`test:browser` 和 `test:live` 默认启动当前 Playwright 版本安装的 Chromium，也可通过 `LIVE_ASSISTANT_CHROMIUM` 指定已有 Chromium，保留 Chromium sandbox。`test:live` 需要 `FOUNDRY_LIVE_ENDPOINT`、`FOUNDRY_INTENT_ENDPOINT`、`az login` 和本地 `espeak-ng`；缺少工具时报错，不把音频测试跳过为通过。普通话模式使用独立的 GPT-Live 会话生成单句音频，必须核对完整转录和关闭回执，生成重复语句算失败；也可以显式复用有成功证据、转录匹配的既有音频，不伪造新的生成记录。脚本每次使用独立状态目录，结果写入其中的 `result.json`，退出时逐个清理新增终端并确认 Live 已关闭。

真实 Claude Code / Codex / Copilot / DSH 的启动、推理与 hook 行为没有自动化脚本，按 [README 的“真实 harness 手工测试”](../README.zh-CN.md#真实-harness-手工测试)和下面的人工测试清单验收。

## 人工测试清单

1. `npm ci`（Node 22.19+ 或 24+），`nvm use 22`，设置 `LIVE_ASSISTANT_PASSWORD`、三个 `FOUNDRY_*_ENDPOINT`、`AZURE_SUBSCRIPTION_NAME`，`az login` 后 `npm run assistant`，经 SSH 隧道打开 `http://127.0.0.1:8787`。
2. 新建 Codex session，先在 CLI 内执行 `/hooks` 信任 live hook；先把焦点放到“任务 / 反馈”输入框，再让它运行一条需要审批的命令，确认页面出现“N. 工具权限”卡片，分别试“批准/拒绝/在终端处理/始终允许”。再让它连续申请几条命令，卡片出现后直接在终端原生菜单中选择并回车，确认每张卡片在你按键后关闭、语音助手不再提醒；然后把焦点留在终端里再触发一次，确认不出现卡片、原生菜单照常可用（hook 等待期间原生菜单是否显示取决于 CLI，需在此确认）；不作答就切到别的 tab 或点“任务 / 反馈”输入框，确认弹出的是原编号卡片且带“在终端处理”。
3. 新建 Claude Code session，重复第 2 步（无需 `/hooks`）。新建 Copilot session，确认其原生权限菜单被识别为“终端确认”卡片。新建 DSH session，Esc 后 `/model` 选 Foundry 模型并完成一次对话。
4. 在 spinner 持续转动时批准一张卡片，确认不会因输出变化而失效；同时开两张卡片，按相反顺序决定。
5. 勾选“朗读待确认提醒”，确认新卡片被朗读；连接语音，确认状态胶囊依次显示“连接中…”“已连接”、按钮变为“断开语音”，切换“麦克风”“助手声音”时文字在开/关间变化；说“批准 1 / 拒绝 2 / 等待反馈”，确认效果与卡片一致；再说“切到另一个 session”“关闭它的 tab”，确认页面切换、卡片批准后 tab 关闭。
6. 在 claude/copilot 等鼠标跟踪 TUI 中点“选择复制”拖选一段文字，松开后粘贴到别处核对；再点“复制屏幕”核对整屏文本。
7. 粘贴 6000 字中文到 shell（例如 `cat > paste.txt` 后粘贴），确认不断线且内容完整。
8. 长时间对话（多个 session、长输出）后询问状态，观察助手是否仍抓住要点。

## 已取得的证据与验收边界

自动化测试的覆盖范围见 [README 的“测试”](../README.zh-CN.md#测试)。真人中文和实际麦克风/扬声器、长时/噪声/回声、真实 CLI 中 hook 的端到端行为需人工测试；纯终端没有跨进程强审批原子性与通用暂停能力，不据此宣称生产就绪。Live/模型/CLI 的已知用量不等于完整美元账单。
