# Real Credential Smoke Test

This is an opt-in local check. It never stores or prints the token. Keep credentials in an ignored `.env.local` file, for example:

```sh
CHATGPT_TOKEN=replace-with-a-short-lived-token
```

Copy the example configuration first, set one real project id and name, then run exactly:

```sh
set -a; . ./.env.local; set +a; nix run .#default -- sync --config ./config.yaml && nix run .#default -- verify --config ./config.yaml
```

The command uses the pinned `chatgpt-exporter` supplied by the flake runtime and publishes only after validation. Remove the token from the shell with `unset CHATGPT_TOKEN` when finished. Do not commit `.env.local`, `config.yaml`, `state/`, or `output/`.

Live credential execution is intentionally outside automated verification. No credential value is documented here, and this check was not run as part of the repository verification.
