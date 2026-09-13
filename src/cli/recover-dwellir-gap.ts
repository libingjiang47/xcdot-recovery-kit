import { Command } from 'commander';
import {
  DWELLIR_GAP_DEFAULT_BASE_WORK,
  DWELLIR_GAP_DEFAULT_CONNECT_TIMEOUT_MS,
  DWELLIR_GAP_DEFAULT_END,
  DWELLIR_GAP_DEFAULT_LOG_WINDOW_BLOCKS,
  DWELLIR_GAP_DEFAULT_PRIOR_WORK,
  DWELLIR_GAP_DEFAULT_STORAGE_CONCURRENCY,
  DWELLIR_GAP_DEFAULT_TIMEOUT_MS,
  runDwellirFrontierGapRecovery,
  type DwellirFrontierGapOptions,
} from '../storage/dwellir-frontier-gap-recovery.js';

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

export function recoverDwellirGapCommand(): Command {
  const command = new Command('recover-dwellir-gap').description(
    'Scan only the uncovered Frontier log range and recover newly discovered final-state candidates',
  );
  command.option('--dataset <directory>', 'Frozen Subscan candidate dataset', 'snapshots/subscan');
  command.requiredOption('--moonscan-csv <file>', 'Moonscan holder CSV for the base candidate set');
  command.option(
    '--prior-work <directory>',
    'Prior SQD backward recovery evidence',
    DWELLIR_GAP_DEFAULT_PRIOR_WORK,
  );
  command.option(
    '--base-work <directory>',
    'Existing pinned final-state balance cache',
    DWELLIR_GAP_DEFAULT_BASE_WORK,
  );
  command.option('--key-file <file>', 'Optional local file containing DWELLIR_KEY');
  command.option('--endpoint-base <url>', 'Dwellir endpoint base URL');
  command.option('--gap-start <block>', 'First uncovered Frontier block', '16669569');
  command.option(
    '--gap-end <block>',
    'Last uncovered Frontier block',
    String(DWELLIR_GAP_DEFAULT_END),
  );
  command.option(
    '--log-window-blocks <number>',
    'Inclusive eth_getLogs window size',
    String(DWELLIR_GAP_DEFAULT_LOG_WINDOW_BLOCKS),
  );
  command.option(
    '--connect-timeout-ms <milliseconds>',
    'Dwellir connection timeout',
    String(DWELLIR_GAP_DEFAULT_CONNECT_TIMEOUT_MS),
  );
  command.option(
    '--timeout-ms <milliseconds>',
    'Dwellir request timeout',
    String(DWELLIR_GAP_DEFAULT_TIMEOUT_MS),
  );
  command.option('--retries <count>', 'Dwellir transport retry attempts', '5');
  command.option(
    '--storage-concurrency <number>',
    'Concurrent final balance reads (1-8)',
    String(DWELLIR_GAP_DEFAULT_STORAGE_CONCURRENCY),
  );
  command.option(
    '--work <directory>',
    'Frontier gap evidence and checkpoint directory',
    'diagnostics/dwellir-gap-recovery',
  );
  command.option('--resume', 'Resume the gap checkpoint', true);
  command.option('--no-resume', 'Ignore the gap checkpoint');
  command.option('--force', 'Delete this gap evidence directory before starting', false);
  command.option(
    '--expected-total-supply <planck>',
    'Expected pinned xcDOT total supply',
    '2334516727484230',
  );
  command.action(
    async (options: {
      dataset: string;
      moonscanCsv: string;
      priorWork: string;
      baseWork: string;
      keyFile?: string;
      endpointBase?: string;
      gapStart: string;
      gapEnd: string;
      logWindowBlocks: string;
      connectTimeoutMs: string;
      timeoutMs: string;
      retries: string;
      storageConcurrency: string;
      work: string;
      resume: boolean;
      force: boolean;
      expectedTotalSupply: string;
    }) => {
      const recoveryOptions: DwellirFrontierGapOptions = {
        dataset: options.dataset,
        moonscanCsv: options.moonscanCsv,
        priorWork: options.priorWork,
        baseWork: options.baseWork,
        ...(options.keyFile === undefined ? {} : { keyFile: options.keyFile }),
        ...(options.endpointBase === undefined ? {} : { endpointBase: options.endpointBase }),
        gapStart: positiveInteger(options.gapStart, 'gap-start'),
        gapEnd: positiveInteger(options.gapEnd, 'gap-end'),
        logWindowBlocks: positiveInteger(options.logWindowBlocks, 'log-window-blocks'),
        connectTimeoutMs: positiveInteger(options.connectTimeoutMs, 'connect-timeout-ms'),
        timeoutMs: positiveInteger(options.timeoutMs, 'timeout-ms'),
        retries: positiveInteger(options.retries, 'retries'),
        storageConcurrency: positiveInteger(options.storageConcurrency, 'storage-concurrency'),
        work: options.work,
        resume: options.resume,
        force: options.force,
        totalSupplyPlanck: options.expectedTotalSupply,
        progress: (message) => console.log(message),
      };
      return runDwellirFrontierGapRecovery(recoveryOptions).then((result) => {
        const summary = result.summary;
        console.log(`DWELLIR_FRONTIER_GENESIS_HASH=${summary.preflight.genesisHash}`);
        console.log(`DWELLIR_FRONTIER_INDEXED_HEAD_HASH=${summary.preflight.indexedHeadHash}`);
        console.log(`DWELLIR_FRONTIER_INDEXED_HEAD_NUMBER=${summary.preflight.indexedHeadNumber}`);
        console.log(`REQUIRED_GAP_END=${summary.gapEnd}`);
        console.log(`FRONTIER_GAP_COVERAGE=${summary.preflight.frontierGapCoverage}`);
        console.log(`GAP_START=${summary.gapStart}`);
        console.log(`GAP_END=${summary.gapEnd}`);
        console.log(`GAP_BLOCKS=${summary.gapBlocks}`);
        console.log(`GAP_BLOCKS_SCANNED=${summary.gapBlocksScanned}`);
        console.log(`RANGES_COMPLETED=${summary.rangesCompleted}`);
        console.log(`TRANSFER_LOGS_TOTAL=${summary.transferLogsTotal}`);
        console.log(`TRANSFER_ADDRESSES_TOTAL=${summary.transferAddressesTotal}`);
        console.log(`NEW_CANDIDATES_TOTAL=${summary.newCandidatesTotal}`);
        console.log(`NEW_POSITIVE_TOTAL=${summary.newPositiveTotal}`);
        console.log(`NEW_ZERO_TOTAL=${summary.newZeroTotal}`);
        console.log(`NEW_POSITIVE_SUM_PLANCK=${summary.newPositiveSumPlanck}`);
        console.log(`BASE_OR_PRIOR_KNOWN_SUM_PLANCK=${summary.baseOrPriorKnownSumPlanck}`);
        console.log(`FINAL_KNOWN_SUM_PLANCK=${summary.finalKnownSumPlanck}`);
        console.log(`TOTAL_SUPPLY_PLANCK=${summary.totalSupplyPlanck}`);
        console.log(`REMAINING_DEFICIT_PLANCK=${summary.remainingDeficitPlanck}`);
        console.log(`PROOFS_CAPTURED=${summary.proofsCaptured}`);
        console.log(`PROOF_VERIFICATION=${summary.proofVerification}`);
        console.log(`STATUS=${summary.status}`);
        if (summary.nextPriority !== undefined)
          console.log(`NEXT_PRIORITY=${summary.nextPriority}`);
        console.log(`OUTPUT=${result.workDirectory}`);
      });
    },
  );
  command.addHelpText(
    'after',
    '\nThis command scans only the pinned Frontier coverage gap. Balances come from pinned Substrate AccountStorages; read proofs are captured but not verified here.\n',
  );
  return command;
}
