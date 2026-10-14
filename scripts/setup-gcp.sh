#!/usr/bin/env bash
# One-time Google Cloud setup for publishing to the Chrome Web Store from GitHub Actions, keyless:
# GitHub's OIDC token → Workload Identity Federation → the service account registered on the store's
# dashboard → a one-hour access token with the chromewebstore scope. Safe to rerun: each step creates
# what is missing and brings the provider's condition up to date.
#
#   scripts/setup-gcp.sh <project-id> <owner/repo> <workflow path>
#
# Needs gcloud (signed in as someone who can create projects) and gh (to look up the repository's
# numeric ID). The workflow path is the one workflow that may mint a token: only that workflow, on
# main, in that repository, can.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <project-id> <owner/repo> <workflow path>" >&2
  exit 2
fi
PROJECT_ID="$1"
REPO="$2"
WORKFLOW="$3"

POOL=github
PROVIDER=github-actions
SERVICE_ACCOUNT_NAME=chrome-web-store
SERVICE_ACCOUNT="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# The numeric ID survives a rename or transfer of the repository; its name doesn't.
REPO_ID="$(gh api "repos/${REPO}" --jq .id)"

if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud projects create "$PROJECT_ID" --name="Chrome Web Store publishing"
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

gcloud services enable --project="$PROJECT_ID" \
  chromewebstore.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com

# No roles and no key: it only acts on the store, which grants it access by email on the dashboard.
if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" --project="$PROJECT_ID" \
    --display-name="Chrome Web Store publisher" \
    --description="Publishes to the Chrome Web Store from GitHub Actions; no key, impersonated through WIF"
fi

if ! gcloud iam workload-identity-pools describe "$POOL" --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --project="$PROJECT_ID" --location=global \
    --display-name="GitHub Actions"
fi

CONDITION="assertion.repository_id == '${REPO_ID}' && assertion.ref == 'refs/heads/main' && assertion.job_workflow_ref == '${REPO}/${WORKFLOW}@refs/heads/main'"
PROVIDER_FLAGS=(
  --project="$PROJECT_ID"
  --location=global
  --workload-identity-pool="$POOL"
  --issuer-uri="https://token.actions.githubusercontent.com"
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.job_workflow_ref=assertion.job_workflow_ref"
  --attribute-condition="$CONDITION"
)
if gcloud iam workload-identity-pools providers describe "$PROVIDER" --project="$PROJECT_ID" \
  --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" "${PROVIDER_FLAGS[@]}"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" "${PROVIDER_FLAGS[@]}" \
    --display-name="${REPO}"
fi

# Lets a token that passed the provider's condition impersonate the service account.
gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository_id/${REPO_ID}" \
  >/dev/null

cat <<EOF

Done. Two steps left:

1. Paste these into the env block of ${WORKFLOW}:

  CWS_WIF_PROVIDER: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}
  CWS_SERVICE_ACCOUNT: ${SERVICE_ACCOUNT}

2. On the Chrome Web Store developer dashboard, in the Account section, add the service account:

  ${SERVICE_ACCOUNT}
EOF
