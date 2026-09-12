import { Command } from 'commander';
import { verifySubscanFinalState } from '../verification/subscan-final-state.js';

export function verifySubscanFinalStateCommand(): Command {
  const command = new Command('verify-subscan-final-state').description(
    'Verify Subscan candidate holders against xcDOT balanceOf at one pinned Moonbeam EVM block',
  );
  command.requiredOption('--dataset <directory>', 'Subscan derived dataset directory');
  command.requiredOption('--evm-rpc <url>', 'Moonbeam EVM JSON-RPC endpoint');
  command.requiredOption('--block-number <number>', 'Pinned EVM block number');
  command.requiredOption(
    '--substrate-block-hash <hash>',
    'Pinned Substrate block hash for context',
  );
  command.option('--concurrency <size>', 'Concurrent historical balanceOf requests', '4');
  command.option('--resume', 'Reuse matching checkpoint results under snapshots/subscan/work');
  command.option('--force', 'Replace an existing final-state output directory');
  command.action(
    async (options: {
      dataset: string;
      evmRpc: string;
      blockNumber: string;
      substrateBlockHash: string;
      concurrency: string;
      resume?: boolean;
      force?: boolean;
    }) => {
      const concurrency = Number(options.concurrency);
      const result = await verifySubscanFinalState({
        dataset: options.dataset,
        evmRpc: options.evmRpc,
        blockNumber: options.blockNumber,
        substrateBlockHash: options.substrateBlockHash,
        concurrency,
        ...(options.resume ? { resume: true } : {}),
        ...(options.force ? { force: true } : {}),
      });
      console.log(`FINAL_STATE_STATUS=${result.status}`);
      console.log(result.outputDirectory);
    },
  );
  return command;
}
