# ChatGPT Markdown Collector

A validation-first wrapper around a pinned `chatgpt-exporter` executable. The exporter owns API access and Markdown generation; this project only runs it, validates the staged result, and publishes referenced Markdown/assets. The pinned upstream authentication mechanism is not suitable for unattended production without periodic human renewal; see below.

## Usage

Copy `config.example.yaml` to `config.yaml`, set the pinned executable, and provide its token through `token_command` (an argv list) or the compatible `CHATGPT_TOKEN` environment variable:

```sh
chatgpt-markdown-collector sync --config ./config.yaml
chatgpt-markdown-collector verify --config ./config.yaml
chatgpt-markdown-collector status --config ./config.yaml
```

Each project mapping is run separately with the upstream 1.1.0 arguments `backup`, `-o`, `--incremental`, `--download-files`, `--project`, `--concurrency`, and `--delay`. Set `output: .` to publish a project at the output root; other mappings publish below their configured prefix. `token_command` runs without a shell, has `token_command_timeout_ms`, and uses only trimmed stdout; provider failures are classified as nonzero, timeout, empty, or malformed. Diagnostics are discarded. Persistent raw incremental JSON and Markdown stay unchanged under `state/upstream-export/<project>`. During staged publication, Markdown larger than `publication.max_markdown_bytes` becomes a small conversation index with ordered Obsidian transclusions plus deterministic, message-boundary `.part-NNNN.md` notes. Equal hashes preserve output mtimes, stable message anchors support links, and only stale collector-owned part files are removed after a complete replacement publishes. An owner-aware lock prevents overlap and reclaims locks whose recorded process is gone. Raw runs and manifests stay under `state`; only validated `.md` files and locally referenced assets reach `output`. A failed, expired, rate-limited, interrupted, or invalid run preserves prior valid publication. Configured roots and published paths are checked after symlink resolution.

The collector records run times, SHA-256 hashes, project counts and added/changed/unchanged comparisons, upstream identity, auth/publication/error/skipped details, and failure classifications in `state/manifest.json` and `state/collector-state.json`.

## Authentication status and renewal

The pinned exporter accepts a ChatGPT web-session **bearer access token** from
`CHATGPT_TOKEN` (or, less safely, `--token`). It does not support cookies, a
cookie jar, OAuth, refresh tokens, browser login, or renewable session state.
Its documented acquisition flow is the `accessToken` field at
`https://chatgpt.com/api/auth/session` in an already authenticated browser.
There is no newer upstream revision that adds renewal.

Before an export, the collector checks JWT shape/expiry and calls the same
conversation endpoint used by the exporter. `status` distinguishes absent,
malformed, apparently expired, HTTP 401/403 rejection, endpoint change, network
failure, rate limiting, and ready credentials. It reports only expiration and
classification—never token contents, cookies, authorization headers, or raw
response bodies. Authentication intervention exits with code 3; prior valid
output and `manifest.json` remain untouched.

For the least-burdensome supported fallback, copy a fresh `accessToken` from the
authenticated browser and enter it without shell history:

```sh
read -rsp 'ChatGPT access token: ' CHATGPT_TOKEN; printf '\n'; export CHATGPT_TOKEN
chatgpt-markdown-collector status --config ./config.yaml
```

Success reports `auth.classification: credential-ready`. Run `sync`, then
`unset CHATGPT_TOKEN`. This remains an alerted manual-renewal workflow, not a
production-ready renewable login. Do not copy browser profiles, store account
passwords/2FA, or build generic cookie extraction around this interface.

### Optional local browser helper

The optional `chatgpt-local-auth` helper keeps a separate, explicitly named
Playwright profile. It never automates passwords or 2FA, accepts only the
official `https://chatgpt.com/` session, and rejects repository paths and normal
browser profiles. The login command is headful so the account owner completes
login; token, status, and revoke are headless:

```sh
chatgpt-local-auth login --profile /var/lib/chatgpt-local-auth --browser-executable "$(command -v google-chrome)"
chatgpt-local-auth status --profile /var/lib/chatgpt-local-auth --browser-executable "$(command -v google-chrome)"
chatgpt-local-auth token --profile /var/lib/chatgpt-local-auth --browser-executable "$(command -v google-chrome)"
chatgpt-local-auth revoke --profile /var/lib/chatgpt-local-auth --browser-executable "$(command -v google-chrome)"
```

If `--browser-executable` is omitted, the helper falls back to `CHATGPT_BROWSER_EXECUTABLE`.
Only the `token` command writes the bearer token to stdout (for direct use by
the provider); other diagnostics are JSON or stderr. Configure the collector
with `token_command: ["chatgpt-local-auth", "token", "--profile", "/var/lib/chatgpt-local-auth", "--browser-executable", "/usr/bin/google-chrome"]`, or rely on the `CHATGPT_BROWSER_EXECUTABLE` environment variable.
Use `--timeout-ms` to bound an operation. Keep the profile outside this repo,
and do not put passwords, 2FA codes, or exported cookies in documentation.

## Nix and Docker

Use `nix develop`, `nix flake check`, `nix build .#collector`, `nix build .#upstream`, or `nix build .#oci`. The flake pins nixpkgs, Node 22, the wrapper dependencies, and upstream revision `c0185e8937b7e3d19a5f1f34aab5d49fa8d1aa7e`; the Nix runtime includes the pinned exporter and has no build-time network dependency. The Nix OCI image keeps `/data` and `/state` as persistent volumes. The standalone `Dockerfile` is a generic Node image only: it packages this wrapper, not `chatgpt-exporter`; provide an exporter executable in `PATH` or configure its path when using that Dockerfile. Use `nix build .#oci` when the pinned combined image is required.
