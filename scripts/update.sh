#!/usr/bin/env bash
# Pull latest, rebuild, and restart the MCP service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

cd "$REPO_DIR"

# The repo is owned by the agent-memory service account, so run git/npm as it.
# -H sets HOME to its home dir so npm's cache doesn't land in the caller's.
SERVICE_USER=agent-memory
if [ "$(id -un)" = "$SERVICE_USER" ]; then
	as_service_user() { "$@"; }
else
	as_service_user() { sudo -u "$SERVICE_USER" -H "$@"; }
fi

# Derive service name from the .service file in systemd/
SERVICE=$(basename "$(ls systemd/*.service 2>/dev/null | head -1)" 2>/dev/null)
if [ -z "$SERVICE" ]; then
	echo "Error: no .service file found in systemd/" >&2
	exit 1
fi

echo "=== git fetch ==="
as_service_user git fetch

echo ""
echo "=== git status ==="
as_service_user git status

echo ""
echo "=== git pull ==="
as_service_user git pull

echo ""
echo "=== npm install ==="
as_service_user npm install

echo ""
echo "=== npm run build ==="
as_service_user npm run build

echo ""
echo "=== restarting $SERVICE ==="
sudo systemctl restart "$SERVICE"
echo "Done."
