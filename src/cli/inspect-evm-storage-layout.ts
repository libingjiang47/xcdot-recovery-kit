import { Command } from 'commander';
import {
  inspectEvmStorageLayout,
  type InspectEvmStorageLayoutOptions,
} from '../storage/layout-inspection.js';
import {
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
} from '../final-state/constants.js';

export function inspectEvmStorageLayoutCommand(): Command {
  const command = new Command('inspect-evm-storage-layout').description(
    'Inspect metadata-derived pallet_evm::AccountStorages and a provenance-bearing Solidity layout',
  );
  command.requiredOption('--substrate-rpc <url>', 'Moonbeam Substrate JSON-RPC endpoint');
  command.requiredOption('--block-hash <hash>', 'Explicit pinned Moonbeam Substrate block hash');
  command.option(
    '--layout <file>',
    'Solidity storage-layout artifact with compiler/source provenance',
  );
  command.option(
    '--out <directory>',
    'Layout inspection evidence directory',
    `snapshots/final-state/moonbeam-${MOONBEAM_FINAL_BLOCK_NUMBER}/storage-layout`,
  );
  command.action(async (options: InspectEvmStorageLayoutOptions) => {
    const result = await inspectEvmStorageLayout(options);
    console.log(JSON.stringify(result, null, 2));
    console.log(`LAYOUT_STATUS=${result.status}`);
    console.log(`PINNED_SUBSTRATE_BLOCK=${result.block.hash}`);
  });
  command.addHelpText(
    'after',
    `\nExpected v0.26 block: ${MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH}\n` +
      'Without --layout the command records metadata availability and stops rather than guessing slots.\n',
  );
  return command;
}
