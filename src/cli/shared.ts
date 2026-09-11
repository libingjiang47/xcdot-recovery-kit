import type { Command } from 'commander';
import { RpcUnavailableError } from '../utils/errors.js';

export function rpcFromOptions(options: { rpc?: string }): string {
  const rpc = options.rpc ?? process.env.MOONBEAM_RPC;
  if (!rpc) throw new RpcUnavailableError('Provide --rpc or set MOONBEAM_RPC.');
  return rpc;
}

export function registerRpcOption(
  command: Command,
  description = 'Moonbeam Substrate RPC (or MOONBEAM_RPC)',
): Command {
  return command.option('--rpc <url>', description);
}

export function logBlock(block: {
  blockNumber: string;
  blockHash: string;
  stateRoot: string;
}): void {
  console.error(`[chain] block=${block.blockNumber} hash=${block.blockHash}`);
  console.error(`[chain] state_root=${block.stateRoot}`);
}
