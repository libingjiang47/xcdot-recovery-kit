import { Command } from 'commander';
import { captureEvidence } from '../evidence/capture.js';
import { rpcFromOptions, registerRpcOption } from './shared.js';

export function captureEvidenceCommand(): Command {
  const command = new Command('capture-evidence').description(
    'Capture pinned raw Moonbeam state, trie proofs, and deterministic evidence',
  );
  registerRpcOption(command);
  command.requiredOption('--block-hash <hash>', 'Explicit pinned Moonbeam block hash');
  command.option('--out <directory>', 'Evidence output parent directory', 'evidence');
  command.option('--batch-size <size>', 'Proof batch size (1..512)', '128');
  command.option('--evm-rpc <url>', 'Optional EVM endpoint recorded as provenance only');
  command.option('--include-runtime-code', 'Capture the raw :code value and its proof');
  command.option('--resume', 'Resume proof batches in the matching work directory');
  command.option('--force', 'Replace an existing final evidence directory after validation');
  command.action(
    async (options: {
      rpc?: string;
      blockHash: string;
      out: string;
      batchSize: string;
      evmRpc?: string;
      includeRuntimeCode?: boolean;
      resume?: boolean;
      force?: boolean;
    }) => {
      const batchSize = Number(options.batchSize);
      return captureEvidence({
        rpc: rpcFromOptions(options),
        blockHash: options.blockHash,
        out: options.out,
        batchSize,
        includeRuntimeCode: Boolean(options.includeRuntimeCode),
        resume: Boolean(options.resume),
        force: Boolean(options.force),
        ...(options.evmRpc === undefined ? {} : { evmRpc: options.evmRpc }),
      }).then((target) => {
        console.log(target);
      });
    },
  );
  return command;
}
