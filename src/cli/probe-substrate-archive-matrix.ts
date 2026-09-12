import { Command } from 'commander';
import {
  ARCHIVE_PROBE_BLOCK_HASH,
  defaultSubstrateProviderSpecs,
  probeSubstrateArchiveMatrix,
  type MatrixProviderSpec,
} from '../diagnostics/substrate-archive.js';

function providerOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseProvider(value: string): MatrixProviderSpec {
  const separator = value.indexOf('=');
  if (separator <= 0) throw new Error(`Provider must use name=url: ${value}`);
  const name = value.slice(0, separator);
  const rpc = value.slice(separator + 1);
  if (rpc === '') throw new Error(`Provider URL is empty: ${name}`);
  return { name, rpc, source: 'explicit CLI provider' };
}

export function probeSubstrateArchiveMatrixCommand(): Command {
  const command = new Command('probe-substrate-archive-matrix').description(
    'Probe known Moonbeam Substrate archive endpoints sequentially',
  );
  command.requiredOption('--block-hash <hash>', 'Pinned Moonbeam Substrate block hash');
  command.option(
    '--provider <name=url>',
    'Provider endpoint; repeat to probe an explicit matrix',
    providerOption,
    [],
  );
  command.option('--timeout-ms <milliseconds>', 'Per-request/connect timeout', '15000');
  command.option('--retries <count>', 'Attempts for transient RPC failures', '3');
  command.option(
    '--out <directory>',
    'Matrix diagnostic directory',
    'diagnostics/substrate-archive-probe',
  );
  command.action(
    async (options: {
      blockHash: string;
      provider: string[];
      timeoutMs: string;
      retries: string;
      out: string;
    }) => {
      const providers =
        options.provider.length > 0
          ? options.provider.map(parseProvider)
          : defaultSubstrateProviderSpecs();
      return probeSubstrateArchiveMatrix({
        blockHash: options.blockHash,
        providers,
        timeoutMs: Number(options.timeoutMs),
        retries: Number(options.retries),
        out: options.out,
      }).then((result) => {
        for (const provider of result.providers) {
          console.log(`PROVIDER=${provider.name}`);
          console.log(`CLASSIFICATION=${provider.classification}`);
        }
        console.log(
          `HISTORICAL_STORAGE_PROVIDER_COUNT=${result.summary.historicalStorageProviders}`,
        );
        console.log(`HISTORICAL_PROOF_PROVIDER_COUNT=${result.summary.historicalProofProviders}`);
        console.log(`CAN_RECONSTRUCT_FINAL_STATE=${result.summary.canReconstructFinalState}`);
        console.log(`CAN_GENERATE_PROOFS=${result.summary.canGenerateProofs}`);
        console.log(`ARCHIVE_CAPABILITY_AVAILABLE=${result.summary.archiveCapabilityAvailable}`);
        console.log(`DIAGNOSTIC_OUTPUT=${result.outputDirectory}`);
      });
    },
  );
  command.addHelpText(
    'after',
    `\nPinned block: ${ARCHIVE_PROBE_BLOCK_HASH}\n` +
      'Without --provider, only configured/known Substrate endpoints are considered; EVM URLs are not inferred.\n',
  );
  return command;
}
