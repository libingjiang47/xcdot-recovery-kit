import { Command } from 'commander';
import {
  runSubscanFinalStateProbe,
  SUBSCAN_FINAL_STATE_PROBE_DIRECT_API_ORIGIN,
  SUBSCAN_FINAL_STATE_PROBE_BLOCK_NUMBER,
  SUBSCAN_FINAL_STATE_PROBE_CONTRACT,
  SUBSCAN_FINAL_STATE_PROBE_STATE_ROOT,
  SUBSCAN_FINAL_STATE_PROBE_TOTAL_SUPPLY,
  type SubscanFinalStateProbeOptions,
} from '../diagnostics/subscan-final-state.js';

export function probeSubscanFinalStateCommand(): Command {
  const command = new Command('probe-subscan-final-state').description(
    'Probe PubFi/Subscan historical final-state access with five xcDOT candidates',
  );
  command.requiredOption(
    '--dataset <directory>',
    'Directory containing candidate-addresses.ndjson',
  );
  command.option(
    '--access <mode>',
    'Access path: pubfi or direct-subscan (default: pubfi)',
    'pubfi',
  );
  command.option(
    '--out <directory>',
    'Diagnostic-only output directory',
    'diagnostics/subscan-final-state-probe',
  );
  command.option('--timeout-ms <milliseconds>', 'Per-request timeout', '15000');
  command.option('--retries <count>', 'Maximum attempts for transient failures', '3');
  command.option('--delay-ms <milliseconds>', 'Delay between sample requests', '550');
  command.action(
    async (options: {
      dataset: string;
      access: 'pubfi' | 'direct-subscan';
      out: string;
      timeoutMs: string;
      retries: string;
      delayMs: string;
    }) =>
      runSubscanFinalStateProbe({
        dataset: options.dataset,
        access: options.access,
        out: options.out,
        timeoutMs: Number(options.timeoutMs),
        retries: Number(options.retries),
        delayMs: Number(options.delayMs),
      } satisfies SubscanFinalStateProbeOptions).then((result) => {
        console.log(result.reportText);
        console.log(`DIAGNOSTIC_OUTPUT=${result.outputDirectory}`);
      }),
  );
  command.addHelpText(
    'after',
    `\nPinned block: ${SUBSCAN_FINAL_STATE_PROBE_BLOCK_NUMBER}\n` +
      `xcDOT contract: ${SUBSCAN_FINAL_STATE_PROBE_CONTRACT}\n` +
      `Expected state root: ${SUBSCAN_FINAL_STATE_PROBE_STATE_ROOT}\n` +
      `Expected total supply: ${SUBSCAN_FINAL_STATE_PROBE_TOTAL_SUPPLY}\n` +
      `Direct Subscan host: ${SUBSCAN_FINAL_STATE_PROBE_DIRECT_API_ORIGIN}\n` +
      'Use PUBFI_KEY for pubfi access or SUBSCAN_API_KEY for direct-subscan access; keys are never written to artifacts.\n',
  );
  return command;
}
