#!/bin/zsh
# Build, then deploy the Figma plugin + hub (mcp/server.js serve) + handlers to a machine that runs Figma.
# Only needed when Figma runs on a different machine than Claude Code.
# On the same machine, the Claude Code plugin starts the hub by itself.
# usage: ./deploy.sh <ssh host>    env passed to the hub: NGA_PROTECTED, NGA_ROOT (default ~/nga-figma-bridge/files)
set -euo pipefail
HOST=${1:?usage: ./deploy.sh <ssh host>}
PROTECTED=${NGA_PROTECTED:-}
DIR=${0:A:h}
REMOTE='~/nga-figma-bridge'
PORT=${NGA_PORT:-7777}

bun "$DIR/build.ts"
ssh "$HOST" "mkdir -p $REMOTE/plugin $REMOTE/mcp $REMOTE/handlers $REMOTE/presets $REMOTE/logs $REMOTE/files"
scp -q "$DIR"/figma-plugin/{manifest.json,code.js,ui.html} "$HOST:$REMOTE/plugin/"   # Figma registration points at plugin/
scp -q "$DIR"/mcp/server.js "$HOST:$REMOTE/mcp/"
scp -q "$DIR"/handlers/*.js "$HOST:$REMOTE/handlers/"
scp -q "$DIR"/presets/*.json "$HOST:$REMOTE/presets/"

# stop by port (never pkill), then start the hub detached
ssh "$HOST" "pid=\$(lsof -tiTCP:$PORT -sTCP:LISTEN || true); [ -n \"\$pid\" ] && kill \$pid || true; sleep 0.5; cd $REMOTE && NGA_ROOT=${NGA_ROOT:-\$HOME/nga-figma-bridge/files} NGA_PROTECTED='$PROTECTED' nohup ~/.bun/bin/bun mcp/server.js serve > logs/server.log 2>&1 < /dev/null & disown; sleep 1; curl -s -m 5 http://127.0.0.1:$PORT/status"
echo
echo "deployed to $HOST:$REMOTE"
