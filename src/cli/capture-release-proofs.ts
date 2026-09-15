import { Command } from 'commander';
import { captureReleaseProofs, type CaptureReleaseProofOptions } from '../release/proofs.js';

export function captureReleaseProofsCommand(): Command {
  const command = new Command('capture-release-proofs').description(
    'Capture raw terminal-state Substrate read proofs for the frozen known balances',
  );
  command.option('--data <directory>', 'Release data directory', 'data');
  command.option('--source <file>', 'Frozen final-balances NDJSON source');
  command.option('--key-file <file>', 'Local file containing DWELLIR_KEY');
  command.option('--endpoint <url>', 'Dwellir endpoint base URL');
  command.option('--timeout-ms <ms>', 'Overall curl request timeout');
  command.option('--connect-timeout-ms <ms>', 'Curl connection timeout');
  command.option('--retries <count>', 'Curl retry count');
  command.option('--resume', 'Reuse already captured proof batches');
  command.action(
    async (options: {
      data: string;
      source?: string;
      keyFile?: string;
      endpoint?: string;
      timeoutMs?: string;
      connectTimeoutMs?: string;
      retries?: string;
      resume?: boolean;
    }) => {
      const parse = (value: string | undefined): number | undefined =>
        value === undefined ? undefined : Number(value);
      const captureOptions: CaptureReleaseProofOptions = {
        data: options.data,
        resume: options.resume ?? true,
        progress: (message) => console.error(message),
      };
      if (options.source !== undefined) captureOptions.source = options.source;
      if (options.keyFile !== undefined) captureOptions.keyFile = options.keyFile;
      if (options.endpoint !== undefined) captureOptions.endpointBase = options.endpoint;
      const timeoutMs = parse(options.timeoutMs);
      if (timeoutMs !== undefined) captureOptions.timeoutMs = timeoutMs;
      const connectTimeoutMs = parse(options.connectTimeoutMs);
      if (connectTimeoutMs !== undefined) captureOptions.connectTimeoutMs = connectTimeoutMs;
      const retries = parse(options.retries);
      if (retries !== undefined) captureOptions.retries = retries;
      return captureReleaseProofs(captureOptions).then((result) => {
        console.log(`TOTAL_SUPPLY_PLANCK=${result.totalSupplyPlanck}`);
        console.log(`BALANCE_PROOFS_CAPTURED=${result.balanceProofCount}`);
        console.log(`BALANCE_PROOF_BATCHES=${result.balanceBatchCount}`);
      });
    },
  );
  return command;
}
