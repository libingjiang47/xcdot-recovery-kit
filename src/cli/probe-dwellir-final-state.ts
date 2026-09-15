import { Command } from 'commander';
import {
  DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
  DWELLIR_FINAL_STATE_PROBE_BLOCK_NUMBER,
  DWELLIR_FINAL_STATE_PROBE_ENDPOINT,
  DWELLIR_FINAL_STATE_PROBE_STATE_ROOT,
  DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY,
  runDwellirFinalStateProbe,
  type DwellirFinalStateProbeOptions,
} from '../diagnostics/dwellir-final-state.js';

export function probeDwellirFinalStateCommand(): Command {
  const command = new Command('probe-dwellir-final-state').description(
    'Probe Dwellir historical Moonbeam header, :code storage, and read proof',
  );
  command.option('--timeout-ms <milliseconds>', 'Per-request timeout', '15000');
  command.option('--retries <count>', 'Maximum attempts for transient failures', '3');
  command.option(
    '--out <directory>',
    'Diagnostic-only output directory',
    'diagnostics/dwellir-final-state-probe',
  );
  command.action(async (options: { timeoutMs: string; retries: string; out: string }) =>
    runDwellirFinalStateProbe({
      timeoutMs: Number(options.timeoutMs),
      retries: Number(options.retries),
      out: options.out,
    } satisfies DwellirFinalStateProbeOptions).then((result) => {
      console.log(result.reportText);
      console.log(`DIAGNOSTIC_OUTPUT=${result.outputDirectory}`);
    }),
  );
  command.addHelpText(
    'after',
    `\nEndpoint: ${DWELLIR_FINAL_STATE_PROBE_ENDPOINT}<DWELLIR_KEY>\n` +
      `Block number: ${DWELLIR_FINAL_STATE_PROBE_BLOCK_NUMBER}\n` +
      `Block hash: ${DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH}\n` +
      `Expected state root: ${DWELLIR_FINAL_STATE_PROBE_STATE_ROOT}\n` +
      `Storage key: ${DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY}\n` +
      'Uses DWELLIR_KEY from the environment; the key is never written to output.\n',
  );
  return command;
}
