import { Command } from 'commander';
import { reconstructFinalState } from '../reconstruction/final-state.js';
import {
  EXPECTED_SUBSCAN_CANDIDATE_COUNT,
  MOONBEAM_FINAL_BLOCK_NUMBER,
} from '../final-state/constants.js';

export function reconstructFinalStateCommand(): Command {
  const command = new Command('reconstruct-final-state').description(
    'Reconstruct final xcDOT balances from balanceOf at one pinned EVM block',
  );
  command.requiredOption('--dataset <directory>', 'Subscan CSV directory or discovery audit');
  command.requiredOption('--evm-rpc <url>', 'Moonbeam EVM JSON-RPC endpoint');
  command.requiredOption('--block-number <number>', 'Pinned historical EVM block number');
  command.option('--concurrency <size>', 'Concurrent historical balanceOf requests (1..8)', '1');
  command.option('--timeout-ms <milliseconds>', 'Per-request timeout', '15000');
  command.option('--retries <count>', 'Maximum attempts for transient RPC errors', '5');
  command.option('--delay-ms <milliseconds>', 'Delay between sequential balanceOf calls', '100');
  command.option('--expected-total-supply <planck>', 'Optional exact totalSupply expectation');
  command.option('--expected-code-hash <hash>', 'Optional exact runtime code hash expectation');
  command.option(
    '--expected-candidates <count>',
    'Expected valid unique candidate address count',
    String(EXPECTED_SUBSCAN_CANDIDATE_COUNT),
  );
  command.option(
    '--out <directory>',
    'Non-canonical final-state evidence directory',
    `snapshots/final-state/moonbeam-${MOONBEAM_FINAL_BLOCK_NUMBER}`,
  );
  command.option('--resume', 'Resume the matching append-only checkpoint');
  command.option('--force', 'Replace the exact output/work artifacts');
  command.action(
    async (options: {
      dataset: string;
      evmRpc: string;
      blockNumber: string;
      concurrency: string;
      timeoutMs: string;
      retries: string;
      delayMs: string;
      expectedTotalSupply?: string;
      expectedCodeHash?: string;
      expectedCandidates: string;
      out: string;
      resume?: boolean;
      force?: boolean;
    }) => {
      return reconstructFinalState({
        dataset: options.dataset,
        evmRpc: options.evmRpc,
        blockNumber: options.blockNumber,
        concurrency: Number(options.concurrency),
        timeoutMs: Number(options.timeoutMs),
        retries: Number(options.retries),
        delayMs: Number(options.delayMs),
        ...(options.expectedTotalSupply === undefined
          ? {}
          : { expectedTotalSupplyPlanck: options.expectedTotalSupply }),
        ...(options.expectedCodeHash === undefined
          ? {}
          : { expectedCodeHash: options.expectedCodeHash }),
        expectedCandidateCount: Number(options.expectedCandidates),
        out: options.out,
        ...(options.resume ? { resume: true } : {}),
        ...(options.force ? { force: true } : {}),
      }).then((result) => {
        console.log(`FINAL_STATE_STATUS=${result.status}`);
        console.log(`FINAL_STATE_OUTPUT=${result.outputDirectory}`);
        console.log(`CANDIDATE_ADDRESS_COUNT=${result.discovery.addresses.length}`);
        console.log(
          `CANDIDATE_ADDRESSES_SHA256=${result.summary.candidateSet.candidateAddressesSha256}`,
        );
        console.log(`EVM_BLOCK_HASH=${result.preflight.evmBlockHash}`);
        console.log(`TOTAL_SUPPLY_PLANCK=${result.preflight.totalSupplyPlanck}`);
        console.log(`KNOWN_FINAL_SUM_PLANCK=${result.summary.finalState.knownFinalSumPlanck}`);
        console.log(
          `UNACCOUNTED_SUPPLY_PLANCK=${result.summary.finalState.unaccountedSupplyPlanck ?? 'PENDING'}`,
        );
        if (result.status !== 'FINAL_STATE_RPC_VERIFIED') process.exitCode = 2;
      });
    },
  );
  return command;
}
