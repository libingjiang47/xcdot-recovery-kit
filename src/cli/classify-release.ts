import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { createEvmClient } from '../verification/evm.js';
import { classifyHolderAccounts, type ClassificationError } from '../verification/code.js';
import { formatPercent } from '../release/format.js';
import { readFrozenPositiveBalances, writeReleaseSums } from '../release/build.js';
import {
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_OBSERVED_EVM_BLOCK_HASH,
} from '../final-state/constants.js';
import { sha256Hex } from '../snapshot/digest.js';
import type { AccountClassification, HolderRecord } from '../types.js';

type ClassificationKind = 'code-present' | 'no-code' | 'system-precompile' | 'unknown';

interface ClassificationCheckpoint {
  schemaVersion: 1;
  status: 'IN_PROGRESS' | 'PASS';
  blockNumber: string;
  evmBlockHash: string;
  rpcSha256: string;
  accounts: Record<string, AccountClassification>;
  errors: ClassificationError[];
}

const DEFAULT_DIAGNOSTICS = 'diagnostics/classification';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, json(value), 'utf8');
  await rename(temporary, path);
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function classificationRecord(result: AccountClassification): Record<string, unknown> {
  return {
    classification: result.classification,
    codeLength: result.codeSize ?? null,
    codeHash: result.codeHash ?? null,
    source: result.source,
  };
}

function countAndBalance(
  holders: readonly HolderRecord[],
  accounts: Record<string, AccountClassification>,
): {
  counts: Record<ClassificationKind, number>;
  balances: Record<ClassificationKind, bigint>;
} {
  const counts: Record<ClassificationKind, number> = {
    'code-present': 0,
    'no-code': 0,
    'system-precompile': 0,
    unknown: 0,
  };
  const balances: Record<ClassificationKind, bigint> = {
    'code-present': 0n,
    'no-code': 0n,
    'system-precompile': 0n,
    unknown: 0n,
  };
  for (const holder of holders) {
    const kind = accounts[holder.address]?.classification ?? 'unknown';
    counts[kind] += 1;
    balances[kind] += BigInt(holder.balancePlanck);
  }
  return { counts, balances };
}

function checkpointFrom(
  options: { rpc: string },
  accounts: Record<string, AccountClassification>,
  errors: Map<string, ClassificationError>,
  status: ClassificationCheckpoint['status'],
): ClassificationCheckpoint {
  return {
    schemaVersion: 1,
    status,
    blockNumber: MOONBEAM_FINAL_BLOCK_NUMBER,
    evmBlockHash: MOONBEAM_OBSERVED_EVM_BLOCK_HASH,
    rpcSha256: sha256Hex(options.rpc),
    accounts: Object.fromEntries(Object.entries(accounts).sort(([a], [b]) => a.localeCompare(b))),
    errors: [...errors.values()].sort((a, b) => a.address.localeCompare(b.address)),
  };
}

function validateCheckpoint(value: unknown, rpc: string): ClassificationCheckpoint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null)
    throw new Error('CLASSIFICATION_RESUME_CONTEXT_MISMATCH');
  const checkpoint = value as Partial<ClassificationCheckpoint>;
  if (
    checkpoint.schemaVersion !== 1 ||
    (checkpoint.status !== 'IN_PROGRESS' && checkpoint.status !== 'PASS') ||
    checkpoint.blockNumber !== MOONBEAM_FINAL_BLOCK_NUMBER ||
    checkpoint.evmBlockHash !== MOONBEAM_OBSERVED_EVM_BLOCK_HASH ||
    checkpoint.rpcSha256 !== sha256Hex(rpc) ||
    typeof checkpoint.accounts !== 'object' ||
    checkpoint.accounts === null ||
    !Array.isArray(checkpoint.errors)
  ) {
    throw new Error('CLASSIFICATION_RESUME_CONTEXT_MISMATCH');
  }
  return checkpoint as ClassificationCheckpoint;
}

async function writeErrorLog(
  path: string,
  errors: Map<string, ClassificationError>,
): Promise<void> {
  const lines = [...errors.values()]
    .sort((a, b) => a.address.localeCompare(b.address))
    .map((error) => JSON.stringify(error));
  await writeFile(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
}

export function classifyReleaseCommand(): Command {
  const command = new Command('classify-release').description(
    'Classify frozen holders using eth_getCode at the pinned EVM block (never latest)',
  );
  command.requiredOption('--evm-rpc <url>', 'Moonbeam EVM JSON-RPC endpoint');
  command.option('--data <directory>', 'Release data directory', 'data');
  command.option('--concurrency <size>', 'Concurrent code lookups', '4');
  command.option('--retries <count>', 'Retries per eth_getCode lookup', '3');
  command.option(
    '--diagnostics <directory>',
    'Classification checkpoint directory',
    DEFAULT_DIAGNOSTICS,
  );
  command.option('--resume', 'Resume from the classification checkpoint');
  command.action(
    async (options: {
      evmRpc: string;
      data: string;
      concurrency: string;
      retries: string;
      diagnostics: string;
      resume?: boolean;
    }) => {
      const dataDirectory = resolve(options.data);
      const diagnosticsDirectory = resolve(options.diagnostics);
      const checkpointPath = join(diagnosticsDirectory, 'checkpoint.json');
      const errorPath = join(diagnosticsDirectory, 'errors.ndjson');
      const holders = await readFrozenPositiveBalances(join(dataDirectory, 'holders.jsonl'));
      const checkpoint = options.resume
        ? validateCheckpoint(await readOptionalJson(checkpointPath), options.evmRpc)
        : undefined;
      const accounts: Record<string, AccountClassification> = {
        ...(checkpoint?.accounts ?? {}),
      };
      const errors = new Map<string, ClassificationError>(
        (checkpoint?.errors ?? []).map((error) => [error.address, error]),
      );
      const remaining = holders.filter(
        (holder) =>
          accounts[holder.address] === undefined ||
          accounts[holder.address]?.classification === 'unknown',
      );

      let persistChain = Promise.resolve();
      const persist = async (status: ClassificationCheckpoint['status'] = 'IN_PROGRESS') => {
        persistChain = persistChain.then(() =>
          writeAtomicJson(
            checkpointPath,
            checkpointFrom({ rpc: options.evmRpc }, accounts, errors, status),
          ),
        );
        await persistChain;
      };
      await mkdir(diagnosticsDirectory, { recursive: true });
      await writeErrorLog(errorPath, errors);
      const classifications = await classifyHolderAccounts(
        createEvmClient(options.evmRpc),
        remaining,
        BigInt(MOONBEAM_FINAL_BLOCK_NUMBER),
        Number(options.concurrency),
        {
          retries: Number(options.retries),
          onError: async (error) => {
            errors.set(error.address, error);
            await writeErrorLog(errorPath, errors);
          },
          onResult: async (result) => {
            accounts[result.address] = result;
            errors.delete(result.address);
            await persist();
          },
        },
      );
      for (const result of classifications) accounts[result.address] = result;
      await persist();
      await writeErrorLog(errorPath, errors);

      const { counts, balances } = countAndBalance(holders, accounts);
      const unknownHolders = holders.filter(
        (holder) =>
          accounts[holder.address]?.classification === 'unknown' ||
          accounts[holder.address] === undefined,
      );
      console.log('CLASSIFICATION=IN_PROGRESS');
      console.log(`ADDRESSES=${holders.length}`);
      console.log(`CONTRACT_COUNT=${counts['code-present']}`);
      console.log(`EOA_COUNT=${counts['no-code']}`);
      console.log(`SYSTEM_COUNT=${counts['system-precompile']}`);
      console.log(`UNKNOWN_COUNT=${counts.unknown}`);
      console.log(`CONTRACT_BALANCE_PLANCK=${balances['code-present']}`);
      console.log(`EOA_BALANCE_PLANCK=${balances['no-code']}`);
      console.log(`SYSTEM_BALANCE_PLANCK=${balances['system-precompile']}`);
      console.log(`UNKNOWN_BALANCE_PLANCK=${balances.unknown}`);
      if (unknownHolders.length > 0) {
        console.log('STATUS=INCOMPLETE_CLASSIFICATION');
        throw new Error(
          `Classification incomplete: ${unknownHolders.length} address(es) remain unknown.`,
        );
      }
      const classifiedBalance = Object.values(balances).reduce((sum, value) => sum + value, 0n);
      const holderBalance = holders.reduce((sum, holder) => sum + BigInt(holder.balancePlanck), 0n);
      if (classifiedBalance !== holderBalance)
        throw new Error('CLASSIFICATION_BALANCE_SUM_MISMATCH');

      const accountsOutput = Object.fromEntries(
        holders
          .map<
            [string, Record<string, unknown>]
          >((holder) => [holder.address, classificationRecord(accounts[holder.address] as AccountClassification)])
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      await writeFile(
        join(dataDirectory, 'classification.json'),
        json({
          schemaVersion: 1,
          status: 'PASS',
          blockNumber: Number(MOONBEAM_FINAL_BLOCK_NUMBER),
          accounts: accountsOutput,
        }),
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
      const totalSupply = BigInt(statistics.balancePlanck.totalSupply ?? '0');
      const knownRecovered = BigInt(statistics.balancePlanck.knownRecovered ?? '0');
      statistics.holders = {
        knownPositive: holders.length,
        codePresent: counts['code-present'],
        noCode: counts['no-code'],
        systemPrecompile: counts['system-precompile'],
        unknown: counts.unknown,
      };
      statistics.balancePlanck = {
        ...statistics.balancePlanck,
        codePresent: balances['code-present'].toString(10),
        noCode: balances['no-code'].toString(10),
        systemPrecompile: balances['system-precompile'].toString(10),
        unknown: balances.unknown.toString(10),
      };
      statistics.percentages = {
        byKnownRecoveredBalance: {
          codePresent: formatPercent(balances['code-present'], knownRecovered),
          noCode: formatPercent(balances['no-code'], knownRecovered),
          systemPrecompile: formatPercent(balances['system-precompile'], knownRecovered),
          unknown: formatPercent(balances.unknown, knownRecovered),
        },
        byTotalSupply: {
          codePresent: formatPercent(balances['code-present'], totalSupply),
          noCode: formatPercent(balances['no-code'], totalSupply),
          systemPrecompile: formatPercent(balances['system-precompile'], totalSupply),
          unknown: formatPercent(balances.unknown, totalSupply),
        },
      };
      statistics.classificationStatus = 'PASS';
      await writeFile(join(dataDirectory, 'statistics.json'), json(statistics), 'utf8');

      const snapshot = JSON.parse(await readFile(join(dataDirectory, 'snapshot.json'), 'utf8')) as {
        limitations?: Record<string, unknown>;
      };
      snapshot.limitations = { ...(snapshot.limitations ?? {}), classificationComplete: true };
      await writeFile(join(dataDirectory, 'snapshot.json'), json(snapshot), 'utf8');
      await writeReleaseSums(resolve(process.cwd()), dataDirectory);
      await persist('PASS');
      console.log('CLASSIFICATION=PASS');
      console.log(`ADDRESSES=${holders.length}`);
      console.log(`CONTRACT_COUNT=${counts['code-present']}`);
      console.log(`EOA_COUNT=${counts['no-code']}`);
      console.log(`SYSTEM_COUNT=${counts['system-precompile']}`);
      console.log(`UNKNOWN_COUNT=${counts.unknown}`);
      console.log('STATUS=PASS');
    },
  );
  return command;
}
