import { Command } from 'commander';
import { join, resolve } from 'node:path';
import { overwriteJson, readHolders, readJsonFile, refreshSnapshotSums } from '../snapshot/io.js';
import { ManifestSchema } from '../schemas/index.js';
import { createEvmClient, verifyEvmSnapshot } from '../verification/evm.js';
import { EvmBalanceMismatchError } from '../utils/errors.js';
import { registerRpcOption, rpcFromOptions } from './shared.js';

export function evmCheckCommand(): Command {
  const command = new Command('evm-check').description(
    'Verify Substrate balances against the xcDOT XC-20',
  );
  command.requiredOption('--snapshot <directory>', 'Snapshot directory');
  registerRpcOption(command, 'Moonbeam EVM JSON-RPC (or MOONBEAM_RPC)');
  command.option('--concurrency <size>', 'Concurrent EVM requests', '8');
  command.action(async (options: { snapshot: string; rpc?: string; concurrency: string }) => {
    const snapshotDir = resolve(options.snapshot);
    const manifest = ManifestSchema.parse(await readJsonFile(join(snapshotDir, 'manifest.json')));
    const { holders } = await readHolders(snapshotDir);
    const output = await verifyEvmSnapshot(
      createEvmClient(rpcFromOptions(options)),
      manifest,
      holders,
      Number(options.concurrency),
    );
    await overwriteJson(join(snapshotDir, 'verification.json'), output.verification);
    await overwriteJson(join(snapshotDir, 'account-classification.json'), {
      schemaVersion: 1,
      status: output.classifications.some((item) => item.codeStatus === 'unknown')
        ? 'PARTIAL'
        : 'PASS',
      accounts: output.classifications,
    });
    await refreshSnapshotSums(snapshotDir);
    console.log(JSON.stringify(output.verification, null, 2));
    if (output.verification.status !== 'PASS') {
      const first = output.verification.holderBalanceMismatches[0];
      throw new EvmBalanceMismatchError('EVM verification failed.', {
        ...(first
          ? { address: first.address, expected: first.expected, actual: first.actual }
          : {}),
        mismatches: output.verification.holderBalanceMismatches.length,
      });
    }
  });
  return command;
}
