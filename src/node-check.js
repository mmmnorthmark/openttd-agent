// Imported first by bin/openttd-agent.js: on a Node older than preflight.MIN_NODE_MAJOR, print one
// clear JSON error and exit 1 before the rest of the CLI loads and fails in some obscure way.
import { nodeProblem } from './preflight.js';

const problem = nodeProblem();
if (problem) {
  process.stdout.write(JSON.stringify({ ok: false, error: problem, first_error: 'node_too_old' }) + '\n');
  process.exit(1);
}
