import { Command } from 'commander';
import {
  recoverDwellirFinalState,
  type DwellirFinalStateRecoveryOptions,
} from '../storage/dwellir-final-state-recovery.js';

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

export function recoverDwellirFinalStateCommand(): Command {
  const command = new Command('recover-dwellir-final-state').description(
    'Recover and prove the final xcDOT holder state from Dwellir historical Moonbeam storage',
  );
  command.option('--dataset <directory>', 'Frozen Subscan candidate dataset', 'snapshots/subscan');
  command.option(
    '--moonscan-csv <file>',
    'Moonscan holder CSV used for candidate address discovery',
  );
  command.option(
    '--candidate-diff-out <directory>',
    'Diagnostic candidate reconciliation output',
    'diagnostics/moonscan-diff',
  );
  command.option(
    '--out <directory>',
    'Verified final-state artifact output',
    'snapshots/final-state-recovered/moonbeam-16796696',
  );
  command.option(
    '--work <directory>',
    'Resume checkpoints for live storage reads',
    'diagnostics/dwellir-final-state-recovery-work/moonbeam-16796696',
  );
  command.option('--key-file <file>', 'Optional local file containing DWELLIR_KEY');
  command.option('--timeout-ms <milliseconds>', 'Per-request curl max time', '120000');
  command.option(
    '--connect-timeout-ms <milliseconds>',
    'Curl connection-establishment max time',
    '20000',
  );
  command.option('--retries <count>', 'Curl attempts for transient transport failures', '5');
  command.option('--storage-batch-size <count>', 'state_getStorage JSON-RPC batch size', '50');
  command.option(
    '--storage-concurrency <count>',
    'Fallback state_getStorage concurrency (1-8)',
    '8',
  );
  command.option('--proof-batch-size <count>', 'state_getReadProof key batch size', '32');
  command.option('--expected-total-supply <planck>', 'Expected pinned xcDOT total supply');
  command.option('--verifier-binary <path>', 'Optional prebuilt evidence-verifier binary');
  command.option('--force', 'Delete prior output and resume checkpoints before starting', false);
  command.option(
    '--force-source-change',
    'Allow replacing an existing Moonscan extension checkpoint with a different source digest',
    false,
  );
  command.option('--resume', 'Explicitly resume completed storage/proof batches', true);
  command.option('--no-resume', 'Do not reuse completed storage/proof batches');
  command.action(
    async (options: {
      dataset: string;
      moonscanCsv?: string;
      candidateDiffOut: string;
      out: string;
      work: string;
      keyFile?: string;
      timeoutMs: string;
      connectTimeoutMs: string;
      retries: string;
      storageBatchSize: string;
      storageConcurrency: string;
      proofBatchSize: string;
      expectedTotalSupply?: string;
      verifierBinary?: string;
      force: boolean;
      forceSourceChange: boolean;
      resume: boolean;
    }) => {
      const recoveryOptions: DwellirFinalStateRecoveryOptions = {
        dataset: options.dataset,
        ...(options.moonscanCsv ? { moonscanCsv: options.moonscanCsv } : {}),
        candidateDiffOut: options.candidateDiffOut,
        out: options.out,
        work: options.work,
        ...(options.keyFile ? { keyFile: options.keyFile } : {}),
        timeoutMs: positiveInteger(options.timeoutMs, 'timeout-ms'),
        connectTimeoutMs: positiveInteger(options.connectTimeoutMs, 'connect-timeout-ms'),
        retries: positiveInteger(options.retries, 'retries'),
        storageBatchSize: positiveInteger(options.storageBatchSize, 'storage-batch-size'),
        storageConcurrency: positiveInteger(options.storageConcurrency, 'storage-concurrency'),
        proofBatchSize: positiveInteger(options.proofBatchSize, 'proof-batch-size'),
        ...(options.expectedTotalSupply
          ? { expectedTotalSupplyPlanck: options.expectedTotalSupply }
          : {}),
        ...(options.verifierBinary ? { verifierBinary: options.verifierBinary } : {}),
        force: options.force,
        forceSourceChange: options.forceSourceChange,
        resume: options.resume,
        progress: (message) => console.log(message),
      };
      const result = await recoverDwellirFinalState(recoveryOptions);
      console.log(`STATUS=${result.status}`);
      console.log(`CANDIDATE_COUNT=${result.candidateCount}`);
      console.log(`CANDIDATE_ADDRESSES_SHA256=${result.candidateAddressesSha256}`);
      console.log(`FINAL_HOLDER_COUNT=${result.holderCount}`);
      console.log(`ZERO_CANDIDATE_COUNT=${result.zeroCandidateCount}`);
      console.log(`TOTAL_SUPPLY_PLANCK=${result.totalSupplyPlanck}`);
      console.log(`PROOF_BATCH_COUNT=${result.proofBatchCount}`);
      if (result.unaccountedSupplyPlanck !== undefined) {
        console.log(`UNACCOUNTED_SUPPLY_PLANCK=${result.unaccountedSupplyPlanck}`);
      }
      if (result.errorCode !== undefined) console.log(`ERROR_CODE=${result.errorCode}`);
      if (result.errorMessage !== undefined) console.log(`ERROR_MESSAGE=${result.errorMessage}`);
      console.log(`OUTPUT=${result.outputDirectory}`);
    },
  );
  command.addHelpText(
    'after',
    '\nCredential lookup order: explicit DWELLIR_KEY environment, --key-file, ./.key, ~/xcdot-recovery-kit.key.\n' +
      'The command resumes completed live batches by default and removes the work directory after final offline verification passes.\n',
  );
  return command;
}
