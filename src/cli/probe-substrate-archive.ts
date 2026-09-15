import { Command } from 'commander';
import {
  ARCHIVE_PROBE_BLOCK_HASH,
  probeSubstrateArchive,
  type SubstrateArchiveProbeOptions,
} from '../diagnostics/substrate-archive.js';

export function probeSubstrateArchiveCommand(): Command {
  const command = new Command('probe-substrate-archive').description(
    'Probe five historical Substrate RPC methods at the pinned Moonbeam block',
  );
  command.requiredOption('--rpc <url>', 'Substrate HTTP or WebSocket JSON-RPC endpoint');
  command.requiredOption('--block-hash <hash>', 'Pinned Moonbeam Substrate block hash');
  command.option('--provider-name <name>', 'Provider label used in the report');
  command.option('--timeout-ms <milliseconds>', 'Per-request/connect timeout', '15000');
  command.option('--retries <count>', 'Attempts for transient RPC failures', '3');
  command.option('--out <directory>', 'Exact per-provider diagnostic directory', undefined);
  command.action(
    async (options: {
      rpc: string;
      blockHash: string;
      providerName?: string;
      timeoutMs: string;
      retries: string;
      out?: string;
    }) =>
      probeSubstrateArchive({
        rpc: options.rpc,
        blockHash: options.blockHash,
        ...(options.providerName === undefined ? {} : { providerName: options.providerName }),
        timeoutMs: Number(options.timeoutMs),
        retries: Number(options.retries),
        ...(options.out === undefined ? {} : { out: options.out }),
      } satisfies SubstrateArchiveProbeOptions).then((result) => {
        console.log(result.reportText);
        console.log(`DIAGNOSTIC_OUTPUT=${result.outputDirectory}`);
        console.log(`CLASSIFICATION=${result.report.classification}`);
      }),
  );
  command.addHelpText(
    'after',
    `\nPinned block: ${ARCHIVE_PROBE_BLOCK_HASH}\n` +
      'This command never calls Ethereum JSON-RPC methods and never creates canonical snapshots.\n',
  );
  return command;
}
