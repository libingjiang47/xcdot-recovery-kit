import { Command } from 'commander';
import { closeSubstrate, connectSubstrate, probeRpc } from '../chain/substrate.js';
import { rpcFromOptions, registerRpcOption } from './shared.js';

export function probeCommand(): Command {
  const command = new Command('probe').description('Check whether an RPC can support extraction');
  registerRpcOption(command);
  command.action(async (options: { rpc?: string }) => {
    const rpc = rpcFromOptions(options);
    const api = await connectSubstrate(rpc);
    try {
      console.log(JSON.stringify(await probeRpc(api), null, 2));
    } finally {
      await closeSubstrate(api);
    }
  });
  return command;
}
