// One result envelope for every command (0.7.0). Pure functions, unit-tested.
//
// Every command result is an object with `ok` (bool) and `error` (human text, null on success).
// A failure also carries `first_error`: a short machine code (a GameScript ERR_* code, or a
// snake_case code of ours such as no_signal_here). List commands return
// { ok, error, total, matched, <items>, truncated }.

/** Short code for an error text: ERR_* as is, "code: text" -> code, refusals -> refused, else failed. */
export function errorCode(text) {
  const t = String(text ?? '').trim();
  if (/^ERR_[A-Z0-9_]+$/.test(t)) return t;
  const m = /^([a-z][a-z0-9_]+):\s/.exec(t);
  if (m && m[1].includes('_')) return m[1];
  const err = /\b(ERR_[A-Z0-9_]+)\b/.exec(t);
  if (err) return err[1];
  if (/^refused\b/i.test(t)) return 'refused';
  return 'failed';
}

/**
 * List envelope. `all`: every item before filtering (or its count); `matched`: items after
 * filtering; `limit`: most items to return (undefined = all).
 */
export function listResult(key, all, matched, limit) {
  const total = typeof all === 'number' ? all : all.length;
  const items = limit === undefined ? matched : matched.slice(0, limit);
  return { ok: true, error: null, total, matched: matched.length, [key]: items, truncated: items.length < matched.length };
}

/**
 * Normalise a command result to the envelope. Objects get `ok` (default: true unless an error is
 * set) and `error` (null on success); failures get `first_error`. Bare arrays (should not happen:
 * commands use listResult) become { items }.
 */
export function envelope(result) {
  if (Array.isArray(result)) return listResult('items', result, result);
  if (result === null || typeof result !== 'object') return { ok: true, error: null, value: result ?? null };
  const out = { ...result };
  const hasError = out.error !== undefined && out.error !== null && out.error !== '';
  if (typeof out.ok !== 'boolean') out.ok = !hasError;
  if (out.ok) {
    out.error = null;
  } else {
    if (!hasError) out.error = out.first_error ?? out.stopped ?? 'failed';
    out.first_error ??= errorCode(out.error);
  }
  // ok and error first: the two fields every caller reads.
  const { ok, error, ...rest } = out;
  return { ok, error, ...rest };
}

/** Envelope for a thrown error (CLI, daemon, MCP). */
export function errorResult(message) {
  return { ok: false, error: String(message), first_error: errorCode(message) };
}
