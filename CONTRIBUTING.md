# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping improve Live Assistant. Issues and pull requests are welcome; for larger changes, please open an issue
first so we can agree on the approach.

## Development setup

You need Linux with `tmux` 3.4 and Node.js 22.19+ or 24+. `npm ci` also installs the pinned Node 22.19.0 into
`node_modules/.bin/node`, which the npm scripts use. There is no build step.

```sh
npm ci
npm test                          # unit and integration tests with a real tmux; no model calls
npx playwright install chromium   # once, for the browser test
npm run test:browser              # headless Chromium against a temporary backend
```

The automated tests use only a shell and test-double CLIs, so you do not need Claude Code, Codex, Copilot, DSH or an
Azure account. `npm run test:live` drives a real GPT-Live session and is **paid**; it needs your own Azure AI Foundry
deployments and is never required for a pull request. See the [README](README.md#testing) and the
[runbook](docs/live-assistant.md) for what each test covers and the manual checklist.

## Making changes

- Keep changes small and focused, and follow the existing style: ES modules (`.mjs`), no build step, `zod` for request
  validation, and as few runtime dependencies as possible. Discuss new dependencies in an issue first.
- Behavior changes need tests (`tests/*.test.mjs` or `scripts/test-assistant-browser.mjs`). Bug fixes should start with a
  failing test where practical. Do not mock away the behavior under test.
- Code, comments, commit messages and logs are in English. The web UI and voice prompts are currently Chinese.
- Documentation is bilingual: `README.md` / `README.zh-CN.md` and `docs/*.md` / `docs/*.zh-CN.md`. When behavior or
  configuration changes, update both languages; if you can write only one, say so in the pull request and we will help.
- Azure AI Foundry is accessed only through Entra ID (`AzureCliCredential`); do not add API key authentication.
- Preserve the safety model in the [threat model](docs/threat-model.md): only the user's buttons or spoken decisions approve
  proposals, and model output or terminal text never does.

## Secrets and private data

Never commit `.env`, the `.live-assistant/` state directory, passwords, tokens, keys, real tenant or subscription IDs,
endpoints of private resources, or conversation transcripts. Use placeholders such as `<voice-resource>` in examples, and
redact logs before attaching them to an issue.

## Pull requests

Branch from `main`, describe what changed and why, and list the tests you ran (the pull request template has a checklist).
CI runs `npm test` and `npm run test:browser`.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
