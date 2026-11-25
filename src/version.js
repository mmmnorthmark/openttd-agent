// Package version, read once from package.json (single source of truth).
import fs from 'node:fs';
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
