// Structured logs to stderr (stdout is reserved for command output / MCP).
// Level from OPENTTD_AGENT_LOG: debug | info | warn | error (default info).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.OPENTTD_AGENT_LOG ?? 'info'] ?? 20;

function emit(level, area, msg, data) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, area, msg, ...(data ?? {}) };
  process.stderr.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (area, msg, data) => emit('debug', area, msg, data),
  info: (area, msg, data) => emit('info', area, msg, data),
  warn: (area, msg, data) => emit('warn', area, msg, data),
  error: (area, msg, data) => emit('error', area, msg, data),
};
