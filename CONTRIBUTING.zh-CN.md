# 参与贡献

[English](CONTRIBUTING.md) | 简体中文

感谢你帮助改进 Live Assistant。欢迎提交 issue 和 pull request；较大的改动请先开 issue 讨论方案。

## 开发环境

需要 Linux、`tmux` 3.4 和 Node.js 22.19+ 或 24+。`npm ci` 还会把固定的 Node 22.19.0 安装到 `node_modules/.bin/node`，npm 脚本使用它。没有构建步骤。

```sh
npm ci
npm test                          # unit and integration tests with a real tmux; no model calls
npx playwright install chromium   # once, for the browser test
npm run test:browser              # headless Chromium against a temporary backend
```

自动化测试只使用 shell 和测试替身 CLI，不需要安装 Claude Code、Codex、Copilot、DSH，也不需要 Azure 账号。`npm run test:live` 驱动真实的 GPT-Live 会话，**会产生费用**，需要你自己的 Azure AI Foundry 部署，提交 pull request 时不要求运行。各测试覆盖的内容和人工测试清单见 [README](README.zh-CN.md#测试) 和[运行指南](docs/live-assistant.zh-CN.md)。

## 修改代码

- 改动保持小而聚焦，沿用现有风格：ES 模块（`.mjs`）、无构建步骤、请求用 `zod` 校验、尽量少的运行时依赖。新增依赖请先在 issue 中讨论。
- 行为变化需要测试（`tests/*.test.mjs` 或 `scripts/test-assistant-browser.mjs`）。修复 bug 时尽量先写一个会失败的测试。不要 mock 掉被测的核心行为。
- 代码、注释、提交信息和日志用英文。网页界面和语音提示目前是中文。
- 文档中英双语：`README.md` / `README.zh-CN.md` 以及 `docs/*.md` / `docs/*.zh-CN.md`。行为或配置变化时两种语言都要更新；只能写一种语言时请在 pull request 中说明，我们会协助补齐。
- Azure AI Foundry 只通过 Entra ID（`AzureCliCredential`）访问，不要加入 API key 认证。
- 保持[威胁模型](docs/threat-model.zh-CN.md)中的安全模型：只有用户的按钮或语音决定能批准提案，模型输出和终端文字永远不能。

## 秘密与私有数据

不要提交 `.env`、`.live-assistant/` 状态目录、密码、token、密钥、真实的 tenant 或订阅 ID、私有资源的端点或对话转写。示例中使用 `<voice-resource>` 这类占位符，附到 issue 的日志先脱敏。

## Pull request

从 `main` 拉分支，说明改了什么、为什么，并列出运行过的测试（pull request 模板中有检查项）。CI 会运行 `npm test` 和 `npm run test:browser`。

提交贡献即表示你同意贡献内容按 [MIT 许可证](LICENSE) 授权。
