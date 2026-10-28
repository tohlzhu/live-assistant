# Security policy

English | [简体中文](SECURITY.zh-CN.md)

Live Assistant turns browser actions into input for a local shell and CLIs: anyone who can log in to the page has the shell
permissions of the user running it. Read the [threat model](docs/threat-model.md) for the trust boundaries, controls and known
residual risks before deploying it.

## Supported versions

This is a development prototype. Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please do **not** open a public issue, discussion or pull request for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**.
Include the affected commit, the steps to reproduce, the impact you observed and any suggested fix.
Do not include real passwords, tokens, keys, endpoints of private resources or conversation transcripts; use placeholders.

This is a personal project maintained on a best-effort basis. We aim to acknowledge reports within 7 days and will
credit reporters in the fix unless they ask otherwise.

## Scope

In scope: authentication and session handling, Host/Origin checks, proposal and approval logic (anything that lets
model output, terminal text or another page approve an action), the PermissionRequest hook channel, file upload and
download path checks, redaction of content sent to models, and leakage of credentials into argv, logs, state files or
web responses.

Out of scope, as described in the threat model: multi-user access control, defending against malicious processes of the
same operating-system user, and deployments that expose the port directly to the internet.
