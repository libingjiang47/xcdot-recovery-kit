import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { createEvmClient } from '../verification/evm.js';
import { classifyHolderAccounts } from '../verification/code.js';
import { formatPercent } from '../release/format.js';
import { readFrozenPositiveBalances, writeReleaseSums } from '../release/build.js';

export function classifyReleaseCommand(): Command {
  const command = new Command('classify-release').description(
    'Classify frozen holders using eth_getCode at the pinned EVM block (never latest)',
  );
  command.requiredOption('--evm-rpc <url>', 'Moonbeam EVM JSON-RPC endpoint');
  command.option('--data <directory>', 'Release data directory', 'data');
  command.option('--concurrency <size>', 'Concurrent code lookups', '2');
  command.action(async (options: { evmRpc: string; data: string; concurrency: string }) => {
    const dataDirectory = resolve(options.data);
    const holders = await readFrozenPositiveBalances(join(dataDirectory, 'holders.jsonl'));
    const classifications = await classifyHolderAccounts(
      createEvmClient(options.evmRpc),
      holders,
      16_796_696n,
      Number(options.concurrency),
    );
    const classificationByAddress = new Map(
      classifications.map((classification) => [classification.address, classification]),
    );
    const accounts: Record<string, unknown> = {};
    const balanceByClass = { 'code-present': 0n, 'no-code': 0n, unknown: 0n };
    const countByClass = { 'code-present': 0, 'no-code': 0, unknown: 0 };
    for (const holder of holders) {
      const found = classificationByAddress.get(holder.address);
      const classification =
        found?.codeStatus === 'has_code'
          ? 'code-present'
          : found?.codeStatus === 'no_code'
            ? 'no-code'
            : 'unknown';
      countByClass[classification] += 1;
      balanceByClass[classification] += BigInt(holder.balancePlanck);
      accounts[holder.address] = {
        classification,
        codeLength: found?.codeSize ?? null,
        codeHash: found?.codeHash ?? null,
        source: 'eth_getCode at pinned EVM block 16796696',
      };
    }
    await writeFile(
      join(dataDirectory, 'classification.json'),
      `${JSON.stringify({ schemaVersion: 1, status: 'PASS', accounts }, null, 2)}\n`,
      'utf8',
    );
    const statistics = JSON.parse(
      await readFile(join(dataDirectory, 'statistics.json'), 'utf8'),
    ) as {
      holders: Record<string, number>;
      balancePlanck: Record<string, string>;
      percentages: {
        byKnownRecoveredBalance: Record<string, string>;
        byTotalSupply: Record<string, string>;
      };
      classificationStatus: string;
    };
    const totalSupplyText = statistics.balancePlanck.totalSupply;
    const knownRecoveredText = statistics.balancePlanck.knownRecovered;
    if (totalSupplyText === undefined || knownRecoveredText === undefined) {
      throw new Error('statistics.json lacks totalSupply or knownRecovered');
    }
    const totalSupply = BigInt(totalSupplyText);
    const knownRecovered = BigInt(knownRecoveredText);
    statistics.holders = {
      knownPositive: holders.length,
      codePresent: countByClass['code-present'],
      noCode: countByClass['no-code'],
      unknown: countByClass.unknown,
    };
    statistics.balancePlanck = {
      ...statistics.balancePlanck,
      codePresent: balanceByClass['code-present'].toString(10),
      noCode: balanceByClass['no-code'].toString(10),
      unknown: balanceByClass.unknown.toString(10),
    };
    statistics.percentages = {
      byKnownRecoveredBalance: {
        codePresent: formatPercent(balanceByClass['code-present'], knownRecovered),
        noCode: formatPercent(balanceByClass['no-code'], knownRecovered),
        unknown: formatPercent(balanceByClass.unknown, knownRecovered),
      },
      byTotalSupply: {
        codePresent: formatPercent(balanceByClass['code-present'], totalSupply),
        noCode: formatPercent(balanceByClass['no-code'], totalSupply),
        unknown: formatPercent(balanceByClass.unknown, totalSupply),
      },
    };
    statistics.classificationStatus = 'PASS';
    await writeFile(
      join(dataDirectory, 'statistics.json'),
      `${JSON.stringify(statistics, null, 2)}\n`,
      'utf8',
    );
    const snapshot = JSON.parse(await readFile(join(dataDirectory, 'snapshot.json'), 'utf8')) as {
      limitations?: Record<string, unknown>;
    };
    snapshot.limitations = { ...(snapshot.limitations ?? {}), classificationComplete: true };
    await writeFile(
      join(dataDirectory, 'snapshot.json'),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf8',
    );
    await writeReleaseSums(resolve(process.cwd()), dataDirectory);
    console.log('CLASSIFICATION=PASS');
    console.log(`ADDRESSES=${holders.length}`);
  });
  return command;
}
