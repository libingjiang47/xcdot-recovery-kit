import { Command } from 'commander';
import {
  SQD_DEFAULT_FROM_BLOCK,
  SQD_DEFAULT_OUTPUT,
  SQD_DEFAULT_RETRIES,
  SQD_DEFAULT_TIMEOUT_MS,
  SQD_DEFAULT_TO_BLOCK,
  SQD_DEFAULT_WINDOW_BLOCKS,
  SQD_DEFAULT_WORK,
  runSqdCandidateDiscovery,
  type SqdCandidateDiscoveryOptions,
} from '../sqd/xcdot-transfer-candidates.js';
import { SQD_ENDPOINT } from '../sqd/client.js';

function nonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return parsed;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

export function fetchSqdXcdotCandidatesCommand(): Command {
  const command = new Command('fetch-sqd-xcdot-candidates').description(
    'Discover xcDOT candidate addresses from historical SQD Transfer logs',
  );
  command.option('--endpoint <url>', 'SQD stream endpoint', SQD_ENDPOINT);
  command.option('--from-block <number>', 'First block to scan', String(SQD_DEFAULT_FROM_BLOCK));
  command.option('--to-block <number>', 'Last block to scan', String(SQD_DEFAULT_TO_BLOCK));
  command.option(
    '--window-blocks <number>',
    'Requested block window size',
    String(SQD_DEFAULT_WINDOW_BLOCKS),
  );
  command.option(
    '--timeout-ms <milliseconds>',
    'Per-request curl timeout',
    String(SQD_DEFAULT_TIMEOUT_MS),
  );
  command.option(
    '--retries <count>',
    'Maximum attempts for transient failures',
    String(SQD_DEFAULT_RETRIES),
  );
  command.option('--out <file>', 'Deterministic address-only output', SQD_DEFAULT_OUTPUT);
  command.option('--work <directory>', 'Checkpoint and diagnostic directory', SQD_DEFAULT_WORK);
  command.option('--resume', 'Resume from the existing checkpoint', true);
  command.option('--no-resume', 'Ignore and replace the existing checkpoint');
  command.option('--force', 'Reset prior checkpoint and output before scanning', false);
  command.action(
    async (options: {
      endpoint: string;
      fromBlock: string;
      toBlock: string;
      windowBlocks: string;
      timeoutMs: string;
      retries: string;
      out: string;
      work: string;
      resume: boolean;
      force: boolean;
    }) =>
      runSqdCandidateDiscovery({
        endpoint: options.endpoint,
        fromBlock: nonNegativeInteger(options.fromBlock, 'from-block'),
        toBlock: nonNegativeInteger(options.toBlock, 'to-block'),
        windowBlocks: positiveInteger(options.windowBlocks, 'window-blocks'),
        timeoutMs: positiveInteger(options.timeoutMs, 'timeout-ms'),
        retries: positiveInteger(options.retries, 'retries'),
        out: options.out,
        work: options.work,
        resume: options.resume,
        force: options.force,
        progress: (message) => console.log(message),
      } satisfies SqdCandidateDiscoveryOptions).then((result) => {
        console.log(`FROM_BLOCK=${result.summary.fromBlock}`);
        console.log(`TO_BLOCK=${result.summary.toBlock}`);
        console.log(`REQUEST_COUNT=${result.summary.requestCount}`);
        console.log(`TRANSFER_LOG_COUNT=${result.summary.transferLogCount}`);
        console.log(`ZERO_ADDRESS_OCCURRENCES=${result.summary.zeroAddressOccurrenceCount}`);
        console.log(`SQD_UNIQUE_ADDRESSES=${result.summary.uniqueNonZeroAddressCount}`);
        console.log(`SQD_CANDIDATE_SHA256=${result.summary.candidateSha256}`);
        console.log(`OUT=${result.outputFile}`);
      }),
  );
  command.addHelpText(
    'after',
    '\nSQD is used only for candidate address discovery; balances and completeness come from pinned Moonbeam state.\n',
  );
  return command;
}
