#!/usr/bin/env bash
# Thin wrapper — the real driver is cross-platform: node desktop-record.mjs
exec node "$(dirname "$0")/desktop-record.mjs" "$@"
