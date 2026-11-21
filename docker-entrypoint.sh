#!/bin/sh
# Starts as root only to make the mounted data directory writable, then drops to the unprivileged "node" user.
set -e
mkdir -p "$DATA_DIR"
if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
  chown -R node:node "$DATA_DIR"
fi
exec su-exec node "$@"
