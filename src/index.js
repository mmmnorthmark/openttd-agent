// Library entry for code-mode scripts: import { connect } from 'openttd-agent'.
//   const game = await connect();            // uses ~/.openttd-agent/config.json
//   const pairs = await game.run('find-cargo-pairs', { cargo: 'wood', min_distance: 100 });
import { makeContext } from './context.js';
import { runCommand, describeCommands } from './commands.js';

export { COMMANDS } from './commands.js';
export * as world from './world.js';

export async function connect() {
  const ctx = makeContext();
  await ctx.session();
  return {
    run: (name, args = {}) => runCommand(ctx, name, args),
    commands: describeCommands,
    session: () => ctx.session(),
    close: () => ctx.close(),
  };
}
