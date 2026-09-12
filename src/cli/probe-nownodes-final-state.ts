import { Command } from 'commander';
import {
  NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
  NOWNODES_FINAL_STATE_PROBE_BLOCK_NUMBER,
  NOWNODES_FINAL_STATE_PROBE_ENDPOINT,
  NOWNODES_FINAL_STATE_PROBE_STATE_ROOT,
  NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
  runNownodesFinalStateProbe,
  type NownodesFinalStateProbeOptions,
} from '../diagnostics/nownodes-final-state.js';

export function probeNownodesFinalStateCommand(): Command {
  const command = new Command('probe-nownodes-final-state').description(
    'Probe NOWNodes historical Moonbeam header, :code storage, and read proof',
  );
  command.option(
    '--endpoint <url>',
    'NOWNodes HTTP JSON-RPC endpoint',
    NOWNODES_FINAL_STATE_PROBE_ENDPOINT,
  );
  command.option('--timeout-ms <milliseconds>', 'Per-request timeout', '15000');
  command.option('--retries <count>', 'Maximum attempts for transient failures', '3');
  command.option(
    '--out <directory>',
    'Diagnostic-only output directory',
    'diagnostics/nownodes-final-state-probe',
  );
  command.action(
    async (options: { endpoint: string; timeoutMs: string; retries: string; out: string }) =>
      runNownodesFinalStateProbe({
        endpoint: options.endpoint,
        timeoutMs: Number(options.timeoutMs),
        retries: Number(options.retries),
        out: options.out,
      } satisfies NownodesFinalStateProbeOptions).then((result) => {
        console.log(result.reportText);
        console.log(`DIAGNOSTIC_OUTPUT=${result.outputDirectory}`);
      }),
  );
  command.addHelpText(
    'after',
    `\nEndpoint: ${NOWNODES_FINAL_STATE_PROBE_ENDPOINT}\n` +
      `Block number: ${NOWNODES_FINAL_STATE_PROBE_BLOCK_NUMBER}\n` +
      `Block hash: ${NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH}\n` +
      `Expected state root: ${NOWNODES_FINAL_STATE_PROBE_STATE_ROOT}\n` +
      `Storage key: ${NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY}\n` +
      'Uses NOWNODES_KEY from the environment; the key is never written to output.\n',
  );
  return command;
}
