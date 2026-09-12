import { Command } from 'commander';
import { runRank565Diagnostic } from '../diagnostics/rank565.js';

export function diagnoseRank565Command(): Command {
  const command = new Command('diagnose-rank565').description(
    'Investigate the missing Account value at Subscan Rank 565 without changing raw input',
  );
  command.requiredOption('--dataset <directory>', 'Untouched Subscan CSV directory');
  command.requiredOption('--evm-rpc <url>', 'Moonbeam EVM JSON-RPC endpoint');
  command.requiredOption('--block-number <number>', 'Pinned historical EVM block number');
  command.option(
    '--from-block <number>',
    'Justified Transfer-history scan start block; required before a history scan is started',
  );
  command.option('--out <directory>', 'Diagnostic evidence directory', 'diagnostics/rank565');
  command.option('--concurrency <size>', 'Concurrent historical balanceOf requests', '4');
  command.option('--chunk-size <blocks>', 'Initial eth_getLogs range size', '10000');
  command.option('--resume', 'Reuse matching balance and Transfer-scan checkpoints');
  command.option('--force', 'Replace existing diagnostic evidence output');
  command.action(
    async (options: {
      dataset: string;
      evmRpc: string;
      blockNumber: string;
      fromBlock?: string;
      out: string;
      concurrency: string;
      chunkSize: string;
      resume?: boolean;
      force?: boolean;
    }) => {
      const concurrency = Number(options.concurrency);
      const chunkSize = Number(options.chunkSize);
      return runRank565Diagnostic({
        dataset: options.dataset,
        evmRpc: options.evmRpc,
        blockNumber: options.blockNumber,
        ...(options.fromBlock ? { fromBlock: options.fromBlock } : {}),
        output: options.out,
        concurrency,
        chunkSize,
        ...(options.resume ? { resume: true } : {}),
        ...(options.force ? { force: true } : {}),
      }).then((result) => {
        console.log(result.reportText);
        console.log(`DIAGNOSTIC_OUTPUT=${result.outputDirectory}`);
        if (result.status !== 'RESOLVED') process.exitCode = 2;
      });
    },
  );
  return command;
}
