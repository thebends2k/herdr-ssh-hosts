#!/bin/sh
# SSH_ASKPASS on Linux and macOS: see askpass.py.
exec "$HERDR_SFTP_PYTHON" -I "$(dirname "$0")/askpass.py" "$@"
