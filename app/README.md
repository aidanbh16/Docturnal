# Docturnal app backend

This folder holds the backend for the Docturnal GitHub App. It runs as a Cloudflare Worker and receives GitHub webhooks at `POST /webhook`.

The backend only makes GitHub API calls. It never reads source code. It does these things:

- When you install the app, it puts each selected repository on a Cloudflare Queue. For each repository, it commits `.github/workflows/docturnal.yml` to the default branch and starts the first run. If the default branch is protected, it opens a pull request titled "Set up Docturnal" from the `docturnal/setup` branch instead, and starts the first run when you merge it.
- When the Action pushes `docturnal/update`, it opens a pull request titled "Docturnal: comments and documentation", or updates the open one. The pull request description comes from `.docturnal/last-run.md` on that branch.
- Every hour at minute 7, a cron trigger starts the nightly run for each installation whose chosen local hour has arrived, with its comment level. Without saved settings, that is midnight, New York time, with medium comments.
- It serves an optional settings page at `/setup`, where someone who can manage the installation signs in with GitHub and chooses the time, time zone, and comment level. Settings live in Cloudflare KV and hold nothing but those values and the repository list. Each repository has its own empty key, `install:<id>:repo:<owner>/<name>`, which webhooks create and delete without reading anything first. The settings page writes only `install:<id>:settings`. Because nothing is read and written back, webhooks and settings saves that arrive together cannot overwrite each other. The hourly cron lists keys by prefix to find each installation's repositories, and uninstalling deletes every key with the `install:<id>:` prefix.
- If a repository has an earlier workflow with its own schedule, it proposes the new one once, in a pull request titled "Update Docturnal workflow".
- It never overwrites an existing workflow file without a pull request.

## Secrets

The Worker reads five secrets: the three below, plus `CLIENT_ID` and `CLIENT_SECRET` for signing in to the settings page. `DEPLOY.md` covers all five. Set each one with Wrangler; never put them in `wrangler.toml` or in code.

| Secret | Value |
| --- | --- |
| `APP_ID` | The app ID from the GitHub App settings page. |
| `PRIVATE_KEY` | The app's private key, in PKCS#8 format. |
| `WEBHOOK_SECRET` | The webhook secret you set on the GitHub App settings page. |

```sh
npx wrangler secret put APP_ID
npx wrangler secret put PRIVATE_KEY < private-key-pkcs8.pem
npx wrangler secret put WEBHOOK_SECRET
```

### Convert the private key to PKCS#8

GitHub gives you a private key in PKCS#1 format (it starts with `-----BEGIN RSA PRIVATE KEY-----`). Workers sign the app's tokens with WebCrypto, which only reads PKCS#8 keys (they start with `-----BEGIN PRIVATE KEY-----`). Convert the key with OpenSSL:

```sh
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in private-key.pem -out private-key-pkcs8.pem
```

If the Worker gets a PKCS#1 key, it logs a message that says to convert it and ignores the webhook.

## Variables

`wrangler.toml` sets two variables that are not secret:

- `ACTION_REPOSITORY`: the repository that publishes the Docturnal Action, such as `owner/docturnal`. The workflow file uses `<ACTION_REPOSITORY>@v1`. Until you set it, the app skips installs and logs why.
- `GITHUB_API_URL`: the GitHub API address. Leave it as `https://api.github.com`.

## Develop and test

```sh
npm install
npm test            # Webhook tests against a mock GitHub API
npm run typecheck
```

To try the Worker locally, put test values in `.dev.vars` (it is in `.gitignore`), start the mock GitHub API, and point `GITHUB_API_URL` at it:

```sh
node tests/mock-github.mjs --serve --port 8788
npx wrangler dev
```
