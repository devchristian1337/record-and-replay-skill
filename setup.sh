#!/usr/bin/env bash
# Thin wrapper — the real setup is cross-platform: node setup.mjs
exec node "$(dirname "$0")/setup.mjs" "$@"
