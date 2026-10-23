# Deploy the Docturnal app

These steps take you from nothing to a working install: you deploy the Worker to Cloudflare, create the GitHub App from `manifest.json`, connect the two, and test the app on a throwaway repository. Plan on about 20 minutes, plus one Docturnal run.

## Before you begin

You need:

- Node.js 20 or later, and git.
- A Cloudflare account. The free plan is enough.
- A GitHub account or organization to own the app.
- This repository pushed to GitHub as a **public** repository, such as `you/docturnal`. Other repositories run the Action from it, so it must be public. Step 3 explains the `v1` tag the workflow uses.

Run every command in this guide from the `app` folder:

```sh
cd app
npm install
```

## 1. Log in to Cloudflare

```sh
npx wrangler login
```

A browser window opens. Allow Wrangler to access your account, then check that the login worked:

```sh
npx wrangler whoami
```

The output shows your account name and ID.

## 2. Set the Action repository

Open `wrangler.toml` and set `ACTION_REPOSITORY` to the repository that publishes the Action:

```toml
ACTION_REPOSITORY = "you/docturnal"
```

The app writes this value into the workflow file it adds to each repository, as `uses: you/docturnal@v1`. Until you set it, the app skips installs and logs `ACTION_REPOSITORY is not set`.

## 3. Publish the v1 tag

The workflow runs `you/docturnal@v1`, so that tag must exist before the first run. If you have not published a release yet, tag the current commit from the repository root:

```sh
git tag v1
git push origin v1
```

To move the tag to a newer commit later, run `git tag -f v1` and `git push -f origin v1`.

## 4. Deploy the Worker

The Worker sets up each repository from a Cloudflare Queue, one repository per message, so an install with many repositories never has to finish within one request. Queues are included in the Workers Free plan. Create the setup queue and its dead letter queue once:

```sh
npx wrangler queues create docturnal-setup
npx wrangler queues create docturnal-setup-failed
```

A repository whose setup still fails after 10 retries moves to `docturnal-setup-failed`, so you can see what failed.

Next, create the KV namespace that holds each installation's settings: its run time, time zone, comment level, and repository list. KV is also included in the Workers Free plan.

```sh
npx wrangler kv namespace create docturnal-settings
```

The output includes an `id`. Open `wrangler.toml` and replace `REPLACE_WITH_KV_NAMESPACE_ID` with it:

```toml
[[kv_namespaces]]
binding = "SETTINGS"
id = "0f2b6c1d8e7a4b3c9d5e6f7a8b9c0d1e"
```

`wrangler.toml` also sets the cron trigger, `crons = ["7 * * * *"]`. Every hour at minute 7, the Worker starts the nightly run for each installation whose chosen local hour has arrived. Without saved settings, that is midnight, New York time. You do not need to change it. Then deploy:

```sh
npx wrangler deploy
```

If your Cloudflare account has no `workers.dev` subdomain yet, Wrangler asks you to choose one. The output ends with the Worker's URL, for example:

```
https://docturnal.you.workers.dev
```

If the deploy fails with an error about the KV namespace, check that you replaced `REPLACE_WITH_KV_NAMESPACE_ID` in `wrangler.toml`. Copy the Worker URL; you need it in the next step. The Worker has no secrets yet, so it answers webhooks with `500 Not configured`. That is expected until step 6.

## 5. Register the GitHub App

Start the registration page:

```sh
node scripts/register.mjs
```

Open http://localhost:8790 and fill in the form:

1. **Worker URL**: the URL from step 4.
2. **Action repository**: the same value as in step 2.
3. **App name**: `Docturnal`. App names are unique across GitHub, so if the name is taken, GitHub asks you for another one on the next page.
4. **Owner**: your personal account, or the organization that should own the app.

Click **Create the app on GitHub**. GitHub shows the app it is about to create. Check that the permissions read:

- Actions: read and write
- Contents: read and write
- Metadata: read-only
- Pull requests: read and write
- Workflows: read and write

Also check that **Request user authorization (OAuth) during installation** is selected, and that the **Callback URL** and **Setup URL** are your Worker URL followed by `/setup`. After someone installs the app, GitHub asks them to sign in and then sends them to the optional settings page. With OAuth during installation selected, GitHub uses the Callback URL for that redirect, so both point to `/setup`.

Then click **Create GitHub App**. GitHub sends you back to the registration page, which shows the app ID, the install link, and the commands for the next step. Keep the page open.

You must finish this step within one hour of clicking **Create GitHub App**, because the code GitHub returns expires. If the page cannot reach GitHub, it shows a `curl` command to run instead; paste the command's output into the page.

> The app subscribes to `push` and `pull_request` events. GitHub sends `installation` and `installation_repositories` events to every app automatically, so the manifest does not list them.

## 6. Set the Worker secrets

On the registration page:

1. Click **Download private-key-pkcs8.pem**, **Download webhook-secret.txt**, and **Download client-secret.txt**.
2. Move the three files into the `app` folder. Git ignores all three names.
3. Run the commands the page shows. They set five secrets: the app ID, the private key, and the webhook secret for the GitHub API and webhooks, and the OAuth client ID and client secret for signing in to the settings page. They look like this, with your app's values:

   macOS, Linux, or Git Bash:

   ```sh
   echo 123456 | npx wrangler secret put APP_ID
   npx wrangler secret put PRIVATE_KEY < private-key-pkcs8.pem
   npx wrangler secret put WEBHOOK_SECRET < webhook-secret.txt
   echo Iv23liAbCdEf | npx wrangler secret put CLIENT_ID
   npx wrangler secret put CLIENT_SECRET < client-secret.txt
   ```

   Windows PowerShell:

   ```powershell
   "123456" | npx wrangler secret put APP_ID
   Get-Content -Raw private-key-pkcs8.pem | npx wrangler secret put PRIVATE_KEY
   Get-Content -Raw webhook-secret.txt | npx wrangler secret put WEBHOOK_SECRET
   "Iv23liAbCdEf" | npx wrangler secret put CLIENT_ID
   Get-Content -Raw client-secret.txt | npx wrangler secret put CLIENT_SECRET
   ```

4. Check that all five secrets exist: `APP_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `PRIVATE_KEY`, and `WEBHOOK_SECRET`.

   ```sh
   npx wrangler secret list
   ```

5. Delete the three files, and stop the registration page with Ctrl+C:

   ```sh
   rm private-key-pkcs8.pem webhook-secret.txt client-secret.txt
   ```

GitHub gives the private key in PKCS#1 format, and the Worker needs PKCS#8. The page converts the key for you. If you ever download a new key from the app settings, convert it yourself before you set it:

```sh
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in private-key.pem -out private-key-pkcs8.pem
npx wrangler secret put PRIVATE_KEY < private-key-pkcs8.pem
```

## 7. Check the webhook URL

The registration page already set the webhook URL. Check it, and update it if the Worker's URL changes later, for example when you add a custom domain:

1. Open the app's settings page (the **Settings** link on the registration page, or **GitHub settings > Developer settings > GitHub Apps > Docturnal > Edit**).
2. Under **Webhook**, check that **Active** is selected and that **Webhook URL** is your Worker URL followed by `/webhook`, such as `https://docturnal.you.workers.dev/webhook`. If you change it, click **Save changes**.
3. Open the **Advanced** tab. Under **Recent Deliveries**, find the `ping` delivery. It failed with status 500 because the secrets were not set yet. Click it, then click **Redeliver**. The new delivery shows status **200**.

A 401 response here means the webhook secret in Cloudflare does not match the app's. Repeat step 6 for `WEBHOOK_SECRET`.

## 8. Test-install on a throwaway repository

1. Create a new repository, such as `you/docturnal-test`, owned by the same account or organization that owns the app. The app is private until step 9, and a private app can only be installed on its owner's account. Give the repository a README and one or two small source files, for example a short JavaScript file with a couple of functions.
2. In a terminal, start following the Worker's logs and leave it running:

   ```sh
   npx wrangler tail
   ```

3. Open the install link from the registration page (`https://github.com/apps/<app-name>/installations/new`). Choose **Only select repositories**, select `docturnal-test`, and click **Install**. GitHub asks you to authorize the app, then opens Docturnal's settings page.
4. Within about half a minute, the log shows these lines:

   ```
   install 12345678: queued 1 repository for setup
   real-api check: GET /repos/you/docturnal-test/contents/.github%2Fworkflows%2Fdocturnal.yml?ref=main -> 404 (path style encoded)
   real-api check: PUT /repos/you/docturnal-test/contents/.github%2Fworkflows%2Fdocturnal.yml -> 201 (path style encoded)
   setup you/docturnal-test: added .github/workflows/docturnal.yml to main, first run queued
   dispatch you/docturnal-test: started the first run on main with medium comments
   ```

   The dispatch line comes about 15 seconds after the setup line, to give GitHub time to register the new workflow. If GitHub needs longer, you see `workflow not registered yet, will retry in 30s` first; that is normal.

5. Confirm the path encoding from the two `real-api check` lines. The Worker sends the workflow path with encoded slashes (`%2F`) and logs the first read and the first create in each Worker instance:

   - **`PUT ... -> 201`**: GitHub accepts the encoded path. Nothing to do.
   - **`PUT ... -> 404`** (and the setup line says `failed, Not Found`): GitHub rejected the encoded path. In `wrangler.toml`, set `CONTENTS_PATH_STYLE = "plain"`, run `npx wrangler deploy`, then remove the test repository from the installation and add it again. The `real-api check` lines now show `/contents/.github/workflows/docturnal.yml` with `-> 201`.

   The `GET ... -> 404` line is expected on a new repository, because the workflow file does not exist yet.

6. In the test repository, check that:
   - The default branch has a new commit, "Add the Docturnal workflow", that adds `.github/workflows/docturnal.yml`. The file has no schedule; the app starts it.
   - The **Actions** tab shows a running **Docturnal** workflow, started by your app, with the input `comment-level: medium`.

7. Check the settings page that GitHub opened after the install:
   - The log shows `setup 12345678: signed in for you`.
   - The page shows a time, a time zone set to your browser's, four comment levels, and a **Save** button.
   - Unless your browser is set to New York time, the log also shows `setup 12345678: saved the browser's time zone, <your time zone>`, and the page says your time zone is saved. This happens only while the settings are still the defaults.
   - To test the schedule, choose the next full hour in your time zone and click **Save**. The page confirms the new time, and the log shows `saved`. At minute 7 of that hour, the log shows `cron ...: 1 installation due, queued 1 run`, then `started the nightly run`.
   - If you close the page without saving, Docturnal runs at midnight in your browser's time zone, with medium comments. If nobody opens the page, it runs at midnight, New York time.

8. When the first run finishes, usually within 10 to 30 minutes, the log shows:

   ```
   push you/docturnal-test: opened pull request #1
   ```

   The repository now has a pull request titled "Docturnal: comments and documentation", opened by your app. Its description lists the comments added and the docs written, and ends with a **Change Docturnal settings** link. Open the link: GitHub asks you to sign in again, then shows the settings page.

The install works if you see the workflow commit, the pull request, and the settings page.

### Optional: test a protected branch

1. In another throwaway repository, add a branch ruleset or branch protection rule on `main` that requires a pull request before merging.
2. Add that repository to the installation (**Settings > Applications > Docturnal > Configure > Repository access**).
3. The log shows `setup you/docturnal-protected: main is protected, opened setup pull request #1`, and the repository has a pull request titled "Set up Docturnal".
4. Merge it. The log shows `setup pull request #1 merged, first run queued`, then `started the first run on main`.

### Clean up

Uninstall the app from the test repositories (**Settings > Applications > Docturnal > Configure > Uninstall**), then delete the repositories.

## 9. Make the app public

`manifest.json` creates the app as private, so only its owner can install it while you test. When the test install works, make it public so anyone can install it:

1. Open the app's settings page: **GitHub settings > Developer settings > GitHub Apps > Docturnal > Edit**. For an organization's app, start from the organization's **Settings > Developer settings > GitHub Apps**.
2. Open the **Advanced** tab.
3. Under **Danger zone**, click **Make public**, then confirm.

The app's public page, `https://github.com/apps/<app-name>`, now shows an **Install** button to everyone. Existing installs keep working. You can make the app private again from the same place, but only while no account other than the owner has it installed.

## If something goes wrong

Each webhook writes one line to `npx wrangler tail`. Find the line in this table:

| Log line | What to do |
| --- | --- |
| `rejected, not configured (missing ...)` | Set the missing secret (step 6). If it names the `SETUP_QUEUE` or `SETTINGS` binding, create the queue or KV namespace and deploy again (step 4). |
| `setup: not configured (missing CLIENT_ID, ...)` | Set `CLIENT_ID` and `CLIENT_SECRET` (step 6). The settings page answers 503 until you do. |
| `setup ...: GitHub sign-in failed` | `CLIENT_SECRET` does not match the app's client secret. Generate a new one on the app settings page and set it again (step 6). |
| `setup ...: rejected, the signed-in user cannot access this installation` | The person who signed in cannot manage that installation. That is the intended check; sign in with an account that can. |
| `cron ...: 0 installations due` every hour | Normal outside each installation's chosen hour. If a run never starts, check the time and time zone on the settings page. |
| `rejected, bad signature` | The webhook secrets do not match. Set `WEBHOOK_SECRET` again from the app settings (step 6). |
| `PRIVATE_KEY is in PKCS#1 format` | Convert the key with `openssl pkcs8` and set it again (step 6). |
| `skipped, ACTION_REPOSITORY is not set` | Set `ACTION_REPOSITORY` in `wrangler.toml` and deploy again (steps 2 and 4). |
| `real-api check: PUT ... -> 404` | Set `CONTENTS_PATH_STYLE = "plain"` (step 8). |
| `will retry in ...` | GitHub had a temporary error or a rate limit. The queue tries again on its own, up to 10 times. |
| `gave up after 11 attempts` | The repository is in the `docturnal-setup-failed` queue. Fix the cause in the line, then remove the repository from the installation and add it again. |
| `failed to queue work` | Cloudflare Queues was unavailable. In the app's **Advanced** settings, redeliver the failed delivery. |
| `failed, Resource not accessible by integration` | The app is missing a permission. Compare its permissions with the list in step 5. |
| `started the first run`, but the run fails at the Docturnal step | The `v1` tag is missing, or the Action repository is private (step 3). |
| No log line at all | Check the webhook URL and the recent deliveries (step 7). |

## Update the app later

- To deploy a code change: `npx wrangler deploy`.
- To rotate the private key: generate a new key on the app settings page, convert it, and set `PRIVATE_KEY` again (step 6). Then delete the old key on the settings page.
- To rotate the webhook secret: set a new secret on the app settings page, then set `WEBHOOK_SECRET` to the same value. This also signs everyone out of the settings page.
- To rotate the client secret: generate a new client secret on the app settings page, set `CLIENT_SECRET` to it, then delete the old one.
