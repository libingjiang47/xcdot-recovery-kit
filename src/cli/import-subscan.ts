import { Command } from 'commander';
import { runSubscanImport } from '../subscan/import.js';

export function importSubscanCommand(): Command {
  const command = new Command('import-subscan').description(
    'Freeze and deterministically import direct Moonbeam Subscan holder CSV files',
  );
  command.requiredOption('--input <directory>', 'Directory containing the untouched CSV files');
  command.requiredOption('--expected-files <count>', 'Expected direct CSV file count');
  command.option('--check-only', 'Validate and digest without changing generated output');
  command.option('--force', 'Replace an existing derived import directory');
  command.action(
    async (options: {
      input: string;
      expectedFiles: string;
      checkOnly?: boolean;
      force?: boolean;
    }) => {
      const expectedFiles = Number(options.expectedFiles);
      if (!Number.isSafeInteger(expectedFiles) || expectedFiles < 0) {
        throw new Error('--expected-files must be a non-negative integer.');
      }
      const result = await runSubscanImport({
        input: options.input,
        expectedFiles,
        ...(options.checkOnly ? { checkOnly: true } : {}),
        ...(options.force ? { force: true } : {}),
      });
      console.log(`RAW_FILE_COUNT=${result.rawFileCount}`);
      console.log(`RAW_ROW_COUNT=${result.rawRowCount}`);
      console.log(`UNIQUE_ADDRESS_COUNT=${result.uniqueAddressCount}`);
      console.log(`POSITIVE_HOLDER_COUNT=${result.positiveHolderCount}`);
      console.log(`ZERO_BALANCE_COUNT=${result.zeroBalanceCount}`);
      console.log(`EXACT_DUPLICATE_COUNT=${result.exactDuplicateCount}`);
      console.log(`CONFLICTING_DUPLICATE_COUNT=${result.conflictingDuplicateCount}`);
      console.log(`INVALID_ROW_COUNT=${result.invalidRowCount}`);
      console.log(`SUBSCAN_TOTAL_BALANCE_PLANCK=${result.subscanTotalBalancePlanck}`);
      console.log(`SUBSCAN_TOTAL_BALANCE_XCDOT=${result.subscanTotalBalanceXcdot}`);
      console.log(`RAW_DATASET_DIGEST=${result.rawDatasetDigest}`);
      console.log(`CANDIDATE_HOLDERS_SHA256=${result.holdersSha256}`);
      console.log(options.checkOnly ? 'SUBSCAN_IMPORT=CHECK_ONLY' : 'SUBSCAN_IMPORT=PASS');
    },
  );
  return command;
}
