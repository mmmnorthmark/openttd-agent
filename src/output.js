// Output contract (0.8.0): the reserved per-call arguments every command takes on every surface
// (CLI, batch, MCP, library), and the one post-step that shapes a result for them. Pure functions,
// unit-tested in test/output.test.js.
//
// Reserved arguments (a command that defines the same key itself keeps its own meaning):
//   fields   "a,b.c" (or an array): keep only these paths. A path whose first key is not a
//            top-level key applies to the items of every top-level list ("--fields id,name" on
//            towns). ok, error and first_error are always kept; failed results are not projected.
//   brief    true: one small object: ok, error, first_error, cost, money, ids, total, matched.
//   compact  true: one-line JSON; false: indented. Only formatting (the surface applies it).
//   steps    'failed' (default): exec results list only failed steps (results_failed);
//            'all': the full results list.

export const OUTPUT_ARGS = ['fields', 'brief', 'compact', 'steps'];

const boolOf = (key, v) => {
  if (v === true || v === 'true' || v === '1' || v === 1) return true;
  if (v === false || v === 'false' || v === '0' || v === 0) return false;
  throw new Error(`bad_arguments: --${key} must be true or false, got ${JSON.stringify(v)}`);
};

/**
 * Split the reserved output arguments off raw args. `known`: the command's own argument names
 * (they win over reserved ones). Returns { args, output: { fields, brief, compact, steps } }.
 * Throws a bad_arguments error for a bad reserved value.
 */
export function takeOutputArgs(raw, known = []) {
  const args = { ...(raw ?? {}) };
  const output = { fields: null, brief: false, compact: undefined, steps: 'failed' };
  for (const key of OUTPUT_ARGS) {
    if (!(key in args) || known.includes(key)) continue;
    const v = args[key];
    delete args[key];
    if (v === null || v === undefined) continue;
    if (key === 'fields') {
      const list = (Array.isArray(v) ? v : String(v).split(',')).map((p) => String(p).trim()).filter(Boolean);
      if (!list.length) throw new Error('bad_arguments: --fields needs at least one field name, e.g. --fields id,name');
      output.fields = list;
    } else if (key === 'steps') {
      if (v !== 'all' && v !== 'failed') throw new Error(`bad_arguments: --steps must be 'all' or 'failed', got ${JSON.stringify(v)}`);
      output.steps = v;
    } else {
      output[key] = boolOf(key, v);
    }
  }
  return { args, output };
}

/** L9 + G2: failed exec rows drop `value` (it can be a junk id); by default only failed rows are listed. */
function shapeSteps(result, steps) {
  if (!Array.isArray(result.results)) return result;
  const rows = result.results.map((r) => (r && typeof r === 'object' && r.ok === false && 'value' in r ? (({ value: _v, ...rest }) => rest)(r) : r));
  const out = { ...result };
  if (steps === 'all') {
    out.results = rows;
    return out;
  }
  delete out.results;
  out.results_failed = rows.filter((r) => r && r.ok === false);
  out.steps_total ??= rows.length;
  out.steps_done ??= rows.filter((r) => r && r.ok !== false).length;
  return out;
}

/** "a,b.c,b.d" -> { a: {}, b: { c: {}, d: {} } } */
function fieldTree(paths) {
  const tree = {};
  for (const p of paths) {
    let node = tree;
    for (const k of p.split('.').filter(Boolean)) node = (node[k] ??= {});
  }
  return tree;
}

function project(value, tree) {
  if (!Object.keys(tree).length || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => project(item, tree));
  const out = {};
  for (const [k, sub] of Object.entries(tree)) if (k in value) out[k] = project(value[k], sub);
  return out;
}

const isObjectList = (v) => Array.isArray(v) && v.some((x) => x && typeof x === 'object' && !Array.isArray(x));

/** Keep only `paths` of a successful result (see the header comment). Unknown paths are listed in fields_unknown. */
export function projectFields(result, paths) {
  const tree = fieldTree(paths);
  const out = { ok: result.ok, error: result.error ?? null };
  if (result.first_error !== undefined) out.first_error = result.first_error;
  const top = {}, items = {};
  for (const [k, sub] of Object.entries(tree)) (k in result ? top : items)[k] = sub;
  for (const [k, sub] of Object.entries(top)) out[k] = project(result[k], sub);
  const unknown = new Set(Object.keys(items));
  if (unknown.size) {
    for (const [k, v] of Object.entries(result)) {
      if (k in top || !isObjectList(v)) continue;
      out[k] = project(v, items);
      for (const name of Object.keys(items)) if (v.some((x) => x && typeof x === 'object' && name in x)) unknown.delete(name);
    }
  }
  if (unknown.size) out.fields_unknown = [...unknown];
  return out;
}

const ID_KEYS = ['id', 'vehicle', 'vehicles', 'station', 'group', 'sign', 'depot', 'removed', 'sold', 'reversed'];
const idOf = (v) => (typeof v === 'number' ? v : v && typeof v === 'object' && !Array.isArray(v) && typeof v.id === 'number' ? v.id : undefined);

/** brief: the few fields a caller checks after an action. */
export function briefResult(result) {
  const out = { ok: result.ok };
  if (!result.ok) {
    out.error = result.error;
    if (result.first_error !== undefined) out.first_error = result.first_error;
  }
  for (const k of ['cost', 'money', 'total', 'matched']) if (typeof result[k] === 'number') out[k] = result[k];
  const ids = {};
  for (const k of ID_KEYS) {
    const v = result[k];
    if (Array.isArray(v)) {
      const list = v.filter((x) => typeof x === 'number'); // lists of objects (reads) are not ids
      if (list.length) ids[k] = list;
    } else if (idOf(v) !== undefined) ids[k] = idOf(v);
  }
  if (Object.keys(ids).length) out.ids = ids;
  return out;
}

/** The one post-step: steps (G2/L9), then brief or fields. `result` is an enveloped object. */
export function shapeResult(result, output = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  let out = shapeSteps(result, output.steps ?? 'failed');
  if (output.brief) return briefResult(out);
  if (output.fields && out.ok) out = projectFields(out, output.fields);
  return out;
}

/** JSON text of a result: one line when compact, else indented. */
export function formatResult(result, compact) {
  return compact ? JSON.stringify(result) : JSON.stringify(result, null, 2);
}

/** Default for `compact` on the CLI: OPENTTD_AGENT_COMPACT (1/0/true/false) or compact when stdout is not a TTY. */
export function compactDefault(env = process.env, isTTY = process.stdout.isTTY) {
  const v = env.OPENTTD_AGENT_COMPACT;
  if (v !== undefined && v !== '') return v === '1' || v.toLowerCase() === 'true';
  return !isTTY;
}
