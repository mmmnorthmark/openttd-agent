// Library entry for code-mode scripts: import { connect } from 'openttd-agent'.
//   const game = await connect();            // uses ~/.openttd-agent/config.json
//   const pairs = await game.run('find-cargo-pairs', { cargo: 'wood', min_distance: 100 });
import { makeContext } from './context.js';
import { runCommand, describeCommands } from './commands.js';
import { relayHealth } from './relay-client.js';

export { COMMANDS } from './commands.js';
export * as world from './world.js';

export async function connect() {
  const ctx = makeContext();
  const viaRelay = Boolean(ctx.cfg.relay);
  if (viaRelay) {
    const health = await relayHealth(ctx.cfg);
    if (!health.ok) throw new Error(health.error);
  } else {
    await ctx.session();
  }
  return {
    run: (name, args = {}) => runCommand(ctx, name, args),
    commands: describeCommands,
    session: () => {
      if (viaRelay) throw new Error('session() is not available through a relay (the connection and map mirror live on the host); use run(name, args)');
      return ctx.session();
    },
    close: () => ctx.close(),
  };
}
