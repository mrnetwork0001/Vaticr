#!/usr/bin/env bash
#
# Deploy the Vaticr forecasting API to a VPS, driven from this machine.
#
#   ./scripts/deploy-vps.sh root@203.0.113.10 --check --domain usevaticr.xyz
#   ./scripts/deploy-vps.sh root@203.0.113.10 --domain usevaticr.xyz --email you@mail.com
#
# This is a thin wrapper. It copies the tree up and runs vps-bootstrap.sh on
# the server, so there is exactly one implementation of the install and one
# set of safety rules - including the shared-box guarantees documented at the
# top of that script.
#
# Files are pushed over SSH rather than pulled with `git clone`, because the
# repository is private: cloning on the server would mean leaving a GitHub
# credential there.

set -euo pipefail

TARGET="${1:-}"
shift || true

if [[ -z "$TARGET" ]]; then
  echo "usage: $0 user@host [--check] [--domain NAME] [--email ADDR] [--api-only] [--with-bot]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE=/opt/vaticr

echo "==> Checking SSH to $TARGET"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" \
  'echo "  connected: $(hostname), $(. /etc/os-release && echo "$PRETTY_NAME")"' || {
  echo "Cannot reach $TARGET over SSH with key auth. Try: ssh-copy-id $TARGET" >&2
  exit 1
}

echo "==> Uploading to $STAGE"
ssh "$TARGET" "mkdir -p $STAGE"
# The web app is built on the server, so the whole tree goes up - minus every
# local artefact, and minus .env, which must never leave this machine.
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude '.venv' \
  --exclude '__pycache__' --exclude '*.pyc' --exclude '.env' --exclude '.env.local' \
  --exclude 'artifacts' --exclude 'cache' \
  "$REPO_ROOT/" "$TARGET:$STAGE/"

echo "==> Running the bootstrap on the server"
# shellcheck disable=SC2029  # the arguments are meant to expand here
ssh -t "$TARGET" "sudo bash $STAGE/scripts/vps-bootstrap.sh $*"
