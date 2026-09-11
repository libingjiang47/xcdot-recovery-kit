import { Command } from 'commander';
import {
  closeSubstrate,
  connectSubstrate,
  resolveBlock,
  assertMoonbeam,
} from '../chain/substrate.js';
import { inspectXcDotAsset } from '../chain/metadata.js';
import { rpcFromOptions, registerRpcOption } from './shared.js';

export function inspectCommand(): Command {
  const command = new Command('inspect').description('Inspect a pinned block and xcDOT identity');
  registerRpcOption(command);
  command.requiredOption('--block-hash <hash>', 'Explicit pinned Moonbeam block hash');
  command.action(async (options: { rpc?: string; blockHash: string }) => {
    const rpc = rpcFromOptions(options);
    const api = await connectSubstrate(rpc);
    try {
      await assertMoonbeam(api);
      const block = await resolveBlock(api, options.blockHash);
      const asset = await inspectXcDotAsset(api, block.blockHash);
      console.log(
        JSON.stringify(
          {
            genesisHash: block.genesisHash,
            block,
            assetsPalletAvailable: true,
            asset,
          },
          null,
          2,
        ),
      );
    } finally {
      await closeSubstrate(api);
    }
  });
  return command;
}
