#!/usr/bin/env bash
# Pull latest, rebuild, and restart the MCP service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

cd "$REPO_DIR"

# Derive service name from the .service file in systemd/
SERVICE=$(basename "$(ls systemd/*.service 2>/dev/null | head -1)" 2>/dev/null)
if [ -z "$SERVICE" ]; then
	echo "Error: no .service file found in systemd/" >&2
	exit 1
fi

echo "=== git fetch ==="
git fetch

echo ""
echo "=== git status ==="
git status

echo ""
echo "=== git pull ==="
git pull

echo ""
echo "=== npm install ==="
npm install

echo ""
echo "=== npm run build ==="
npm run build

echo ""
echo "=== restarting $SERVICE ==="
sudo systemctl restart "$SERVICE"
echo "Done."
