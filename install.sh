#!/usr/bin/env bash
# Thin wrapper — the real installer is cross-platform: node install.mjs
exec node "$(dirname "$0")/install.mjs" "$@"
