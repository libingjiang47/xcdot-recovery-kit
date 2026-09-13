import { Command } from 'commander';
import { MOONBEAM_FINAL_BLOCK_NUMBER } from '../final-state/constants.js';
import {
  BACKWARD_DEFAULT_BASE_WORK,
  BACKWARD_DEFAULT_CONNECT_TIMEOUT_MS,
  BACKWARD_DEFAULT_MAX_EMPTY_WINDOWS,
  BACKWARD_DEFAULT_STORAGE_CONCURRENCY,
  BACKWARD_DEFAULT_TIMEOUT_MS,
  BACKWARD_DEFAULT_WINDOW_BLOCKS,
  runSqdBackwardRecovery,
  type BackwardRecoveryOptions,
} from '../sqd/backward-recovery.js';

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

export function recoverSqdBackwardCommand(): Command {
  const command = new Command('recover-sqd-backward').description(
    'Discover new xcDOT candidates backward through SQD and read their pinned final balances',
  );
  command.option('--dataset <directory>', 'Frozen Subscan candidate dataset', 'snapshots/subscan');
  command.requiredOption(
    '--moonscan-csv <file>',
    'Moonscan holder CSV used for the base candidate set',
  );
  command.option('--key-file <file>', 'Optional local file containing DWELLIR_KEY');
  command.option('--sqd-endpoint <url>', 'SQD stream endpoint');
  command.option('--endpoint-base <url>', 'Dwellir endpoint base URL');
  command.option(
    '--window-blocks <number>',
    'Backward window size',
    String(BACKWARD_DEFAULT_WINDOW_BLOCKS),
  );
  command.option(
    '--max-empty-windows <number>',
    'Stop after this many empty windows',
    String(BACKWARD_DEFAULT_MAX_EMPTY_WINDOWS),
  );
  command.option(
    '--connect-timeout-ms <milliseconds>',
    'Dwellir connection timeout',
    String(BACKWARD_DEFAULT_CONNECT_TIMEOUT_MS),
  );
  command.option(
    '--timeout-ms <milliseconds>',
    'Dwellir request timeout',
    String(BACKWARD_DEFAULT_TIMEOUT_MS),
  );
  command.option(
    '--storage-concurrency <number>',
    'Concurrent Dwellir balance requests (1-8)',
    String(BACKWARD_DEFAULT_STORAGE_CONCURRENCY),
  );
  command.option(
    '--work <directory>',
    'Backward recovery checkpoint directory',
    'diagnostics/sqd-backward-recovery',
  );
  command.option(
    '--base-work <directory>',
    'Existing final-state cache directory',
    BACKWARD_DEFAULT_BASE_WORK,
  );
  command.option('--resume', 'Resume the backward recovery checkpoint', true);
  command.option('--no-resume', 'Ignore and replace the backward checkpoint');
  command.option('--force', 'Reset the backward recovery checkpoint before starting', false);
  command.option('--no-capture-proof', 'Skip read-proof capture for debugging only');
  command.action(
    async (options: {
      dataset: string;
      moonscanCsv: string;
      keyFile?: string;
      sqdEndpoint?: string;
      endpointBase?: string;
      windowBlocks: string;
      maxEmptyWindows: string;
      connectTimeoutMs: string;
      timeoutMs: string;
      storageConcurrency: string;
      work: string;
      baseWork: string;
      resume: boolean;
      force: boolean;
      captureProof: boolean;
    }) =>
      runSqdBackwardRecovery({
        dataset: options.dataset,
        moonscanCsv: options.moonscanCsv,
        ...(options.keyFile === undefined ? {} : { keyFile: options.keyFile }),
        ...(options.sqdEndpoint === undefined ? {} : { sqdEndpoint: options.sqdEndpoint }),
        ...(options.endpointBase === undefined ? {} : { endpointBase: options.endpointBase }),
        windowBlocks: positiveInteger(options.windowBlocks, 'window-blocks'),
        maxEmptyWindows: positiveInteger(options.maxEmptyWindows, 'max-empty-windows'),
        connectTimeoutMs: positiveInteger(options.connectTimeoutMs, 'connect-timeout-ms'),
        timeoutMs: positiveInteger(options.timeoutMs, 'timeout-ms'),
        storageConcurrency: positiveInteger(options.storageConcurrency, 'storage-concurrency'),
        work: options.work,
        baseWork: options.baseWork,
        resume: options.resume,
        force: options.force,
        captureProof: options.captureProof,
        progress: (message) => console.log(message),
      } satisfies BackwardRecoveryOptions).then((result) => {
        const summary = result.summary;
        console.log(`BASE_CANDIDATE_COUNT=${summary.baseCandidateCount}`);
        console.log(`BASE_FINAL_SUM_PLANCK=${summary.baseFinalSumPlanck}`);
        console.log(
          `INITIAL_DEFICIT_PLANCK=${BigInt(summary.totalSupplyPlanck) - BigInt(summary.baseFinalSumPlanck)}`,
        );
        console.log(`MOONBEAM_FINAL_BLOCK=${MOONBEAM_FINAL_BLOCK_NUMBER}`);
        console.log(`SQD_FINALIZED_HEAD=${summary.sqdFinalizedHead ?? 'UNKNOWN'}`);
        console.log(`SQD_COVERAGE_GAP_START=${summary.sqdCoverageGapStart ?? 'NONE'}`);
        console.log(`SQD_COVERAGE_GAP_END=${summary.sqdCoverageGapEnd ?? 'NONE'}`);
        console.log(`SQD_COVERAGE_GAP_BLOCKS=${summary.sqdCoverageGapBlocks}`);
        console.log(`ROUNDS_COMPLETED=${summary.rounds}`);
        console.log(`OLDEST_SCANNED_BLOCK=${summary.oldestScannedBlock ?? 'NOT_RECORDED'}`);
        console.log(`NEW_CANDIDATES_TOTAL=${summary.newCandidateCount}`);
        console.log(`NEW_POSITIVE_TOTAL=${summary.newPositiveCount}`);
        console.log(`NEW_ZERO_TOTAL=${summary.newZeroCount}`);
        console.log(`NEW_POSITIVE_SUM_PLANCK=${summary.newPositiveSumPlanck}`);
        console.log(`FINAL_KNOWN_SUM_PLANCK=${summary.finalKnownSumPlanck}`);
        console.log(`TOTAL_SUPPLY_PLANCK=${summary.totalSupplyPlanck}`);
        console.log(`REMAINING_DEFICIT_PLANCK=${summary.remainingDeficitPlanck}`);
        console.log(`PROOFS_CAPTURED=${summary.proofsCaptured}`);
        console.log(`PROOF_VERIFICATION=${summary.proofVerification}`);
        console.log(`STATUS=${summary.status}`);
        console.log(`OUTPUT=${result.workDirectory}`);
      }),
  );
  command.addHelpText(
    'after',
    '\nSQD discovers candidates only. Balances are read from Dwellir at the pinned Moonbeam final block. Proofs are captured but never verified by this command.\n',
  );
  return command;
}
