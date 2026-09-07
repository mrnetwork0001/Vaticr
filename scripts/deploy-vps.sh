#!/usr/bin/env bash
#
# Deploy the Vaticr forecasting API to a VPS, driven from this machine.
#
#   ./scripts/deploy-vps.sh root@203.0.113.10 --check
#   ./scripts/deploy-vps.sh root@203.0.113.10
#   ./scripts/deploy-vps.sh root@203.0.113.10 api.example.com you@example.com
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
  echo "usage: $0 user@host [--check] [api.domain.tld] [you@email.tld]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE=/opt/vaticr-src

echo "==> Checking SSH to $TARGET"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" \
  'echo "  connected: $(hostname), $(. /etc/os-release && echo "$PRETTY_NAME")"' || {
  echo "Cannot reach $TARGET over SSH with key auth. Try: ssh-copy-id $TARGET" >&2
  exit 1
}

echo "==> Uploading to $STAGE"
ssh "$TARGET" "mkdir -p $STAGE/scripts"
rsync -az --delete --exclude '__pycache__' --exclude '*.pyc' \
  "$REPO_ROOT/agents/" "$TARGET:$STAGE/agents/"
rsync -az "$REPO_ROOT/requirements.txt" "$TARGET:$STAGE/requirements.txt"
rsync -az "$REPO_ROOT/scripts/vps-bootstrap.sh" "$TARGET:$STAGE/scripts/vps-bootstrap.sh"

echo "==> Running the bootstrap on the server"
# shellcheck disable=SC2029  # the arguments are meant to expand here
ssh -t "$TARGET" "sudo bash $STAGE/scripts/vps-bootstrap.sh $*"
