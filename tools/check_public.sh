#!/bin/sh
# Public-repo hygiene check: fails on personal names, paths, private IPs and hostnames.
# Patterns and allow-lists: tools/check_public.mjs.
cd "$(dirname "$0")/.." && exec node tools/check_public.mjs
