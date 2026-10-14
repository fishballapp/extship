# extship

**Publish a browser extension to the Chrome Web Store from CI, with a short-lived access token.**
A CLI, and the Effect library it is built on, over the Chrome Web Store API v2. No keys and no
refresh tokens: CI mints a one-hour token (keyless, through Workload Identity Federation) and hands
it to extship. Needs Node 24 or later.

```sh
pnpm add -D extship   # or: npm install --save-dev extship
```

```sh
export CHROME_WEB_STORE_ACCESS_TOKEN="$(…)"   # a token with the chromewebstore scope
npx extship chrome publish --publisher-id <id> --item-id <id> --zip extension.zip --publish-type staged
npx extship chrome status --publisher-id <id> --item-id <id>
```

## What `publish` does

1. Reads `version` from the `manifest.json` in the zip, and the item's status from the store. If
   that version is already published, or submitted and pending review or staged, it says so and
   exits 0: rerunning a release is safe. If the store holds a newer version, it fails with
   `StaleVersionError` and touches nothing, so rerunning an old build never withdraws a newer one.
2. Cancels an open submission (pending review or staged) of an older version, since the store
   takes no upload while one is open.
3. Uploads the zip. If the store is still processing it, polls the status every 5 seconds, for up
   to 10 minutes; a failed or unfinished upload fails the command.
4. Submits it for review: `--publish-type default` goes live once approved, `staged` waits for you
   to publish it from the dashboard (within 30 days of approval). Prints the store's warnings.

`--dry-run` stops after reading the status, which proves the token and the IDs.

## The CLI contract

- **The token comes from `CHROME_WEB_STORE_ACCESS_TOKEN` only.** There is no flag (another process
  can read argv), no `.env` file and no other variable. It is never printed: a failure carries the
  store's response body, never a request's headers.
- **Progress goes to stderr; the result is JSON on stdout.** `publish` prints
  `{"outcome": "submitted" | "already-on-store" | "dry-run", "version", …}`; `status` prints the
  store's status.
- **A failure prints one JSON line on stderr and exits 1:**

  ```json
  {"error":{"code":"StoreResponseError","message":"POST /v2/publishers/…/items/…:publish answered 400","status":400,"body":{"error":{…}}}}
  ```

  `code` is `StoreResponseError` (the store answered outside 2xx; `body` is its answer),
  `StoreUnreachableError` (no answer, or a request timed out; a write may have landed),
  `UnexpectedResponseError`, `UploadFailedError`, `InvalidPackageError` (no readable manifest
  version in the zip), `MissingTokenError` or `UsageError`.
- Every request has a timeout: 30 seconds, 3 minutes for the upload.

## One-time Google Cloud setup

The store lets **one service account per publisher** act for every item that publisher owns. CI
impersonates it through Workload Identity Federation, so no key exists anywhere. A direct WIF
principal can't be registered on the dashboard, hence the service account in between.

From a checkout of this repository, [`scripts/setup-gcp.sh`](scripts/setup-gcp.sh) does all of it,
and is safe to rerun. Right after creating a project, Google can deny its owner
`iam.workloadIdentityPools.create` for a minute; wait and rerun. No billing account is needed:

```sh
scripts/setup-gcp.sh <project-id> <owner/repo> .github/workflows/publish.yml
```

The third argument is the one workflow that may mint a token. It must run on `main`.

Step by step, for reference (the script fills in the values):

```sh
gcloud projects create "$PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
gcloud services enable --project="$PROJECT_ID" chromewebstore.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com

# No roles, no key.
gcloud iam service-accounts create chrome-web-store --project="$PROJECT_ID"

gcloud iam workload-identity-pools create github --project="$PROJECT_ID" --location=global
gcloud iam workload-identity-pools providers create-oidc github-actions --project="$PROJECT_ID" \
  --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.job_workflow_ref=assertion.job_workflow_ref" \
  --attribute-condition="assertion.repository_id == '$REPO_ID' && assertion.ref == 'refs/heads/main' && assertion.job_workflow_ref == '$REPO/$WORKFLOW@refs/heads/main'"

gcloud iam service-accounts add-iam-policy-binding \
  "chrome-web-store@$PROJECT_ID.iam.gserviceaccount.com" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$REPO_ID"
```

Then add the service account's email on the [developer dashboard](https://chrome.google.com/webstore/devconsole),
in the Account section.

- **The condition pins the repository by its numeric ID** (`gh api repos/<owner/repo> --jq .id`),
  which survives a rename, plus the `main` branch and the one workflow that publishes. Only a run
  matching all three can mint a token.
- **The provider's resource name uses the project _number_**, not its ID.
- **Keep the credentials out of the zip:** build the zip before authenticating, or pass
  `create_credentials_file: false`, as below.

## GitHub Actions

This is `.github/workflows/publish.yml`, the workflow the setup above names. `npm run zip` stands for
whatever command writes your `extension.zip`.

```yaml
name: Publish

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v6
      - run: npm ci && npm run zip
      - uses: actions/upload-artifact@v7
        with: { name: extension, path: extension.zip }

  publish:
    needs: build
    runs-on: ubuntu-latest
    permissions: { contents: read, id-token: write }
    concurrency: { group: chrome-publish, cancel-in-progress: false }
    steps:
      - uses: actions/download-artifact@v8
        with: { name: extension }
      - uses: actions/setup-node@v6
        with: { node-version: 24 }
      - id: auth
        uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0
        with:
          workload_identity_provider: projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/providers/github-actions
          service_account: chrome-web-store@<PROJECT_ID>.iam.gserviceaccount.com
          token_format: access_token
          access_token_scopes: https://www.googleapis.com/auth/chromewebstore
          create_credentials_file: false
      - run: npx extship chrome publish --publisher-id <id> --item-id <id> --zip extension.zip --publish-type staged
        env:
          CHROME_WEB_STORE_ACCESS_TOKEN: ${{ steps.auth.outputs.access_token }}
```

The build runs in a job without `id-token`, so nothing it runs can mint a token. None of the IDs
above is a secret: the provider's condition is what guards publishing.

## Library

```ts
import { ChromeWebStore, publish } from 'extship';
import { Effect } from 'effect';

publish({ item: { publisherId, itemId }, zip, publishType: 'STAGED_PUBLISH', isDryRun: false })
  .pipe(Effect.provide(ChromeWebStore.layer)); // zip: a Uint8Array; needs an HttpClient
```

`ChromeWebStore` is the v2 API as an Effect service (`fetchStatus`, `cancelSubmission`, `upload`,
`publish`); `manifestVersion` reads a zip's version; `heldVersions`, `compareVersions` and
`isCancellable` are the pure decisions `publish` makes.

## Licence

MIT
