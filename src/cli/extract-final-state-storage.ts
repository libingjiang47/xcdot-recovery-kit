import { Command } from 'commander';
import { extractFinalStateStorage } from '../storage/extract-final-state.js';
import {
  EXPECTED_SUBSCAN_CANDIDATE_COUNT,
  EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
} from '../final-state/constants.js';

export function extractFinalStateStorageCommand(): Command {
  const command = new Command('extract-final-state-storage').description(
    'Extract xcDOT EVM storage words from Moonbeam Substrate state and acquire read proofs',
  );
  command.requiredOption('--substrate-rpc <url>', 'Moonbeam Substrate JSON-RPC endpoint');
  command.requiredOption('--block-hash <hash>', 'Explicit pinned Moonbeam Substrate block hash');
  command.requiredOption('--dataset <directory>', 'Subscan CSV directory or discovery audit');
  command.requiredOption('--layout <file>', 'Provenance-bearing Solidity storage-layout artifact');
  command.option('--out <directory>', 'Non-canonical final-state evidence directory');
  command.option('--proof-batch-size <size>', 'state_getReadProof batch size', '128');
  command.option(
    '--expected-total-supply <planck>',
    'Expected _totalSupply value at the pinned state',
    EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
  );
  command.option(
    '--expected-candidates <count>',
    'Expected valid unique candidate address count',
    String(EXPECTED_SUBSCAN_CANDIDATE_COUNT),
  );
  command.option(
    '--expected-state-root <root>',
    'Expected pinned Substrate state root',
    MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
  );
  command.option('--resume', 'Resume proof batches in the matching output directory');
  command.option('--force', 'Replace the exact output directory');
  command.action(
    async (options: {
      substrateRpc: string;
      blockHash: string;
      dataset: string;
      layout: string;
      out?: string;
      proofBatchSize: string;
      expectedTotalSupply: string;
      expectedCandidates: string;
      expectedStateRoot: string;
      resume?: boolean;
      force?: boolean;
    }) =>
      extractFinalStateStorage({
        substrateRpc: options.substrateRpc,
        blockHash: options.blockHash,
        dataset: options.dataset,
        layout: options.layout,
        ...(options.out === undefined ? {} : { out: options.out }),
        proofBatchSize: Number(options.proofBatchSize),
        expectedTotalSupplyPlanck: options.expectedTotalSupply,
        expectedCandidateCount: Number(options.expectedCandidates),
        expectedStateRoot: options.expectedStateRoot,
        ...(options.resume ? { resume: true } : {}),
        ...(options.force ? { force: true } : {}),
      }).then((result) => {
        console.log(`FINAL_STATE_STATUS=${result.status}`);
        console.log(`FINAL_STATE_OUTPUT=${result.outputDirectory}`);
        console.log(JSON.stringify(result.summary, null, 2));
      }),
  );
  return command;
}
