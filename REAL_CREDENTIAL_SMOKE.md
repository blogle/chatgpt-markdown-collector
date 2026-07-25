# Real Credential Smoke Test

This is an opt-in local check. It never stores or prints the token. The pinned
upstream accepts only a short-lived bearer access token and has no refresh or
cookie-session mechanism. Obtain `accessToken` from
`https://chatgpt.com/api/auth/session` in an already authenticated browser.
Prefer entering it without shell history:

```sh
read -rsp 'ChatGPT access token: ' CHATGPT_TOKEN; printf '\n'; export CHATGPT_TOKEN
```

Copy the example configuration first, set one real project id and name, then run exactly:

```sh
nix run .#default -- status --config ./config.yaml && nix run .#default -- sync --config ./config.yaml && nix run .#default -- verify --config ./config.yaml
```

The command uses the pinned `chatgpt-exporter` supplied by the flake runtime and publishes only after validation. A ready status reports `credential-ready`; authentication intervention exits with code 3. Remove the token from the shell with `unset CHATGPT_TOKEN` when finished. Do not commit `.env.local`, `config.yaml`, `state/`, or `output/`.

Live credential execution is intentionally outside automated verification. No credential value is documented here, and this check was not run as part of the repository verification.
