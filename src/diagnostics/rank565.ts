import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, resolve } from 'node:path';
import {
  createPublicClient,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { XC_DOT_DECIMALS, XC_DOT_SYMBOL, XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import { parseSubscanAddress, parseSubscanBalance, parseSubscanPage } from '../subscan/csv.js';
import { sha256Hex } from '../snapshot/digest.js';
import { pathExists } from '../snapshot/io.js';
import { compareCanonicalStrings } from '../utils/order.js';
import { withConcurrency } from '../verification/providers.js';
import {
  Rank565DiagnosticError,
  Rank565ResumeContextMismatchError,
  XcDotError,
} from '../utils/errors.js';

const execFileAsync = promisify(execFile);

export const RANK565 = 565 as const;
export const RANK565_BLOCK_NUMBER = '16796696' as const;
export const RANK565_MISSING_BALANCE_PLANCK = '143274324851' as const;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const TRANSFER_EVENT_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

const DIAGNOSTIC_VERSION = 1 as const;
const RANK565_SOURCE_FILE =
  'Moonbeam-Holders-xcDOT-0xf544b23a99befc7820530077b0257c3a60c23f92-0x7edc57db68ca6a536bde4fbed78af2bf2cd0bde5.csv';

const RANK565_ABI = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const TRANSFER_EVENT_ABI = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
} as const;

type Rank565Function = 'symbol' | 'decimals' | 'totalSupply' | 'balanceOf';

export interface Rank565Log {
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
  topics: readonly (Hex | null)[];
  data: Hex;
}

export interface Rank565EvmClient {
  getChainId(): Promise<number>;
  getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null }>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  readContract(args: {
    address: Address;
    functionName: Rank565Function;
    blockNumber: bigint;
    args?: readonly [Address];
  }): Promise<unknown>;
  getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<Rank565Log[]>;
}

function wrapPublicClient(client: PublicClient): Rank565EvmClient {
  return {
    getChainId: () => client.getChainId(),
    getBlock: async ({ blockNumber }) => {
      const block = await client.getBlock({ blockNumber });
      return { number: block.number, hash: block.hash };
    },
    getCode: ({ address, blockNumber }) => client.getCode({ address, blockNumber }),
    readContract: async ({ address, functionName, blockNumber, args }) =>
      client.readContract({
        address,
        abi: RANK565_ABI,
        functionName,
        blockNumber,
        ...(args ? { args } : {}),
      }),
    getLogs: async ({ address, fromBlock, toBlock }) => {
      const logs = await client.getLogs({
        address,
        fromBlock,
        toBlock,
        event: TRANSFER_EVENT_ABI,
      });
      return logs.map((log) => ({
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        topics: log.topics,
        data: log.data,
      }));
    },
  };
}

export function createRank565EvmClient(rpc: string): Rank565EvmClient {
  if (!rpc) throw new Rank565DiagnosticError('An EVM RPC endpoint is required.');
  try {
    return wrapPublicClient(
      createPublicClient({
        transport: http(rpc, { timeout: 15_000, retryCount: 0 }),
      }),
    );
  } catch (error) {
    throw new Rank565DiagnosticError(`Could not create an EVM RPC client: ${String(error)}`, {
      rpc,
    });
  }
}

export interface Rank565ValidRow {
  rank: string;
  address: string;
  balancePlanck: string;
  sourceFile: string;
  sourceRow: number;
  rawAddress: string;
  rawBalance: string;
}

export interface Rank565InvalidRow {
  rank: string;
  account: string;
  balance: string;
  sourceFile: string;
  sourceRow: number;
  errorCode: string;
  error: string;
}

export interface Rank565Dataset {
  rawFileCount: number;
  rawRowCount: number;
  validRowCount: number;
  invalidRowCount: number;
  uniqueValidAddressCount: number;
  exactDuplicateAddressCount: number;
  conflictingDuplicateCount: number;
  rawDatasetDigest: string;
  validRows: Rank565ValidRow[];
  knownAddresses: string[];
  knownBalances: Map<string, string>;
  invalidRows: Rank565InvalidRow[];
  knownSubscanSumPlanck: string;
  expectedUniqueTotalPlanck: string;
}

export function parseUnsignedDecimal(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Rank565DiagnosticError(`${label} must be an unsigned decimal integer.`, { value });
  }
  return BigInt(value);
}

export function expectedRank565UniqueTotal(knownSubscanSumPlanck: string): string {
  return (BigInt(knownSubscanSumPlanck) + BigInt(RANK565_MISSING_BALANCE_PLANCK)).toString(10);
}

export function setDifference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right.map((address) => address.toLowerCase()));
  return [...new Set(left.map((address) => address.toLowerCase()))]
    .filter((address) => !rightSet.has(address))
    .sort(compareCanonicalStrings);
}

export function exactBalanceCandidates(
  records: readonly { address: string; balancePlanck: string }[],
  balancePlanck: string,
): string[] {
  return [
    ...new Set(
      records
        .filter((record) => record.balancePlanck === balancePlanck)
        .map((record) => record.address.toLowerCase()),
    ),
  ].sort(compareCanonicalStrings);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function ndjson<T>(records: readonly T[]): string {
  return records.length === 0
    ? ''
    : records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function isBlankRecord(record: readonly string[]): boolean {
  return record.every((value) => value.trim() === '');
}

function errorMessage(error: unknown): string {
  if (error instanceof XcDotError) {
    const nested = error.details.error;
    return typeof nested === 'string' ? `${error.message} [${nested}]` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return error instanceof XcDotError ? error.code : 'UNEXPECTED_ERROR';
}

function exactU256(value: unknown, label: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new Rank565DiagnosticError(`${label} did not return an unsigned U256.`, {
    value: String(value),
  });
}

function isTransient(error: unknown): boolean {
  return /timeout|timed out|network|fetch|socket|econn|429|rate.?limit|temporar|502|503|504/i.test(
    errorMessage(error),
  );
}

function isRangeLimit(error: unknown): boolean {
  return /range|too many|limit|exceed|block span|query returned|10000|5000/i.test(
    errorMessage(error),
  );
}

async function retryHistorical<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === 3) throw error;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function historicalQuery<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await retryHistorical(operation);
  } catch (error) {
    throw new Rank565DiagnosticError(`Historical ${label} query failed.`, {
      error: errorMessage(error),
    });
  }
}

async function readRawDataset(input: string): Promise<Rank565Dataset> {
  const directory = resolve(input);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Rank565DiagnosticError(`Cannot read Subscan dataset: ${directory}`, {
      error: errorMessage(error),
    });
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
    .map((entry) => entry.name)
    .sort(compareCanonicalStrings);
  if (names.length === 0) {
    throw new Rank565DiagnosticError('The Subscan dataset contains no CSV files.', {
      dataset: directory,
    });
  }

  const validRows: Rank565ValidRow[] = [];
  const invalidRows: Rank565InvalidRow[] = [];
  let rawRowCount = 0;
  const fileDigests: string[] = [];
  for (const name of names) {
    const bytes = await readFile(join(directory, name));
    fileDigests.push(`${sha256Hex(bytes)}  ${name}`);
    const parsed = parseSubscanPage(Buffer.from(bytes).toString('utf8'), name);
    rawRowCount += parsed.records.length;
    for (let index = 0; index < parsed.records.length; index += 1) {
      const record = parsed.records[index];
      const sourceRow = index + 2;
      if (!record || isBlankRecord(record)) continue;
      const rawRank = record[0] ?? '';
      const rawAddress = record[1] ?? '';
      const rawBalance = record[2] ?? '';
      try {
        if (!/^\d+$/.test(rawRank.trim())) {
          throw new Rank565DiagnosticError('Subscan Rank is not an unsigned integer.', {
            rawValue: rawRank,
          });
        }
        validRows.push({
          rank: rawRank.trim(),
          address: parseSubscanAddress(rawAddress, name, sourceRow),
          balancePlanck: parseSubscanBalance(rawBalance, name, sourceRow),
          sourceFile: name,
          sourceRow,
          rawAddress,
          rawBalance,
        });
      } catch (error) {
        invalidRows.push({
          rank: rawRank.trim(),
          account: rawAddress,
          balance: rawBalance,
          sourceFile: name,
          sourceRow,
          errorCode: errorCode(error),
          error: errorMessage(error),
        });
      }
    }
  }

  const byAddress = new Map<string, Rank565ValidRow[]>();
  for (const row of validRows)
    byAddress.set(row.address, [...(byAddress.get(row.address) ?? []), row]);
  const knownBalances = new Map<string, string>();
  let conflictingDuplicateCount = 0;
  for (const [address, rows] of byAddress) {
    const balances = new Set(rows.map((row) => row.balancePlanck));
    if (balances.size > 1) conflictingDuplicateCount += 1;
    const balance = rows[0]?.balancePlanck;
    if (balance !== undefined) knownBalances.set(address, balance);
  }
  if (conflictingDuplicateCount > 0) {
    throw new Rank565DiagnosticError(
      'The valid Subscan rows contain conflicting duplicate balances.',
      {
        conflictingDuplicateCount,
      },
    );
  }
  const knownAddresses = [...knownBalances.keys()].sort(compareCanonicalStrings);
  let knownSubscanSum = 0n;
  for (const balance of knownBalances.values()) knownSubscanSum += BigInt(balance);
  const rawSums =
    fileDigests
      .sort((a, b) =>
        compareCanonicalStrings(a.slice(a.indexOf('  ') + 2), b.slice(b.indexOf('  ') + 2)),
      )
      .join('\n') + '\n';
  const exactDuplicateAddressCount = validRows.length - knownAddresses.length;
  return {
    rawFileCount: names.length,
    rawRowCount,
    validRowCount: validRows.length,
    invalidRowCount: invalidRows.length,
    uniqueValidAddressCount: knownAddresses.length,
    exactDuplicateAddressCount,
    conflictingDuplicateCount,
    rawDatasetDigest: sha256Hex(rawSums),
    validRows,
    knownAddresses,
    knownBalances,
    invalidRows,
    knownSubscanSumPlanck: knownSubscanSum.toString(10),
    expectedUniqueTotalPlanck: expectedRank565UniqueTotal(knownSubscanSum.toString(10)),
  };
}

function parseTopicAddress(topic: Hex | null, label: string): string {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) {
    throw new Rank565DiagnosticError(`Transfer log has an invalid ${label} topic.`, {
      topic: topic ?? 'null',
    });
  }
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function parseTransferLog(log: Rank565Log): TransferRecord {
  if (log.topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC) {
    throw new Rank565DiagnosticError('RPC returned a non-Transfer log for the Transfer filter.');
  }
  const blockNumber = log.blockNumber;
  if (blockNumber === null) {
    throw new Rank565DiagnosticError('Transfer log has no block number.');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(log.data)) {
    throw new Rank565DiagnosticError('Transfer log has invalid uint256 data.', { data: log.data });
  }
  return {
    blockNumber: blockNumber.toString(10),
    transactionHash: log.transactionHash?.toLowerCase() ?? null,
    logIndex: log.logIndex,
    from: parseTopicAddress(log.topics[1] ?? null, 'from'),
    to: parseTopicAddress(log.topics[2] ?? null, 'to'),
    amountPlanck: BigInt(log.data).toString(10),
  };
}

export interface TransferRecord {
  blockNumber: string;
  transactionHash: string | null;
  logIndex: number | null;
  from: string;
  to: string;
  amountPlanck: string;
}

function compareTransferRecords(a: TransferRecord, b: TransferRecord): number {
  const block = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  if (block < 0n) return -1;
  if (block > 0n) return 1;
  const tx = compareCanonicalStrings(a.transactionHash ?? '', b.transactionHash ?? '');
  if (tx !== 0) return tx;
  return (a.logIndex ?? -1) - (b.logIndex ?? -1);
}

function transferKey(record: TransferRecord): string {
  return [
    record.blockNumber,
    record.transactionHash ?? '',
    String(record.logIndex ?? -1),
    record.from,
    record.to,
    record.amountPlanck,
  ].join('|');
}

function parseNdjson<T>(raw: string, label: string): T[] {
  const lines = raw === '' ? [] : raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, index) => {
    if (!line)
      throw new Rank565DiagnosticError(`${label} contains a blank line.`, { line: index + 1 });
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Rank565DiagnosticError(`${label} contains invalid JSON.`, {
        line: index + 1,
        error: errorMessage(error),
      });
    }
  });
}

function canonicalTransferRecords(records: readonly TransferRecord[]): TransferRecord[] {
  const unique = new Map<string, TransferRecord>();
  for (const record of records) unique.set(transferKey(record), record);
  return [...unique.values()].sort(compareTransferRecords);
}

interface TransferScanContext {
  contract: string;
  blockNumber: string;
  fromBlock: string;
}

interface TransferScanCheckpoint {
  schemaVersion: 1;
  context: TransferScanContext;
  ranges: Array<{ fromBlock: string; toBlock: string; logCount: number }>;
}

interface TransferScanResult {
  records: TransferRecord[];
  ranges: TransferScanCheckpoint['ranges'];
  fromBlock: string;
  toBlock: string;
}

function sameTransferContext(a: TransferScanContext, b: TransferScanContext): boolean {
  return (
    a.contract === b.contract && a.blockNumber === b.blockNumber && a.fromBlock === b.fromBlock
  );
}

async function writeOverwrite(path: string, value: string): Promise<void> {
  await writeFile(path, value, 'utf8');
}

async function writeCheckpoint(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, json(value), 'utf8');
  await rm(path, { force: true });
  await writeFile(path, await readFile(temporary, 'utf8'), 'utf8');
  await rm(temporary, { force: true });
}

export async function scanTransferHistory(
  outputDirectory: string,
  client: Rank565EvmClient,
  contract: Address,
  blockNumber: bigint,
  fromBlock: bigint,
  chunkSize: number,
  resume: boolean,
  emitProgress: (message: string) => void,
): Promise<TransferScanResult> {
  const workDirectory = join(outputDirectory, 'work');
  await mkdir(workDirectory, { recursive: true });
  const checkpointPath = join(workDirectory, 'transfer-scan-checkpoint.json');
  const eventsPath = join(workDirectory, 'transfer-events.ndjson');
  const context: TransferScanContext = {
    contract: contract.toLowerCase(),
    blockNumber: blockNumber.toString(10),
    fromBlock: fromBlock.toString(10),
  };
  let checkpoint: TransferScanCheckpoint = { schemaVersion: 1, context, ranges: [] };
  let records: TransferRecord[] = [];
  if (resume) {
    try {
      checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as TransferScanCheckpoint;
      if (
        checkpoint.schemaVersion !== 1 ||
        !checkpoint.context ||
        !sameTransferContext(checkpoint.context, context)
      ) {
        throw new Rank565ResumeContextMismatchError(
          'Transfer scan checkpoint context does not match.',
          {
            blockNumber: blockNumber.toString(10),
            fromBlock: fromBlock.toString(10),
            contract,
          },
        );
      }
      records = canonicalTransferRecords(
        parseNdjson<TransferRecord>(await readFile(eventsPath, 'utf8'), 'transfer-events.ndjson'),
      );
    } catch (error) {
      if (error instanceof Rank565ResumeContextMismatchError) throw error;
      throw new Rank565DiagnosticError('Cannot resume the Transfer log scan.', {
        error: errorMessage(error),
      });
    }
  } else {
    await writeCheckpoint(checkpointPath, checkpoint);
    await writeOverwrite(eventsPath, '');
  }

  const ranges = [...checkpoint.ranges].sort((a, b) =>
    BigInt(a.fromBlock) < BigInt(b.fromBlock) ? -1 : 1,
  );
  let nextBlock = fromBlock;
  for (const range of ranges) {
    if (BigInt(range.fromBlock) !== nextBlock) {
      throw new Rank565DiagnosticError('Transfer scan checkpoint contains a gap.', {
        expectedFromBlock: nextBlock.toString(10),
        actualFromBlock: range.fromBlock,
      });
    }
    nextBlock = BigInt(range.toBlock) + 1n;
  }
  let currentChunk = BigInt(chunkSize);
  while (nextBlock <= blockNumber) {
    const toBlock =
      nextBlock + currentChunk - 1n < blockNumber ? nextBlock + currentChunk - 1n : blockNumber;
    let logs: Rank565Log[];
    try {
      logs = await retryHistorical(() =>
        client.getLogs({ address: contract, fromBlock: nextBlock, toBlock }),
      );
    } catch (error) {
      if (isRangeLimit(error) && currentChunk > 1n) {
        currentChunk = currentChunk / 2n || 1n;
        emitProgress(`[rank565] reducing Transfer range to ${currentChunk.toString(10)} blocks`);
        continue;
      }
      throw new Rank565DiagnosticError('Historical Transfer log range failed.', {
        fromBlock: nextBlock.toString(10),
        toBlock: toBlock.toString(10),
        error: errorMessage(error),
      });
    }
    const parsed = logs.map(parseTransferLog);
    await appendFile(eventsPath, ndjson(parsed), 'utf8');
    const range = {
      fromBlock: nextBlock.toString(10),
      toBlock: toBlock.toString(10),
      logCount: parsed.length,
    };
    checkpoint.ranges.push(range);
    checkpoint.ranges.sort((a, b) => (BigInt(a.fromBlock) < BigInt(b.fromBlock) ? -1 : 1));
    await writeCheckpoint(checkpointPath, checkpoint);
    records = canonicalTransferRecords([...records, ...parsed]);
    emitProgress(`[rank565] Transfer ${range.fromBlock}-${range.toBlock} logs=${range.logCount}`);
    nextBlock = toBlock + 1n;
  }
  records = canonicalTransferRecords(records);
  await writeOverwrite(eventsPath, ndjson(records));
  return {
    records,
    ranges: checkpoint.ranges,
    fromBlock: context.fromBlock,
    toBlock: context.blockNumber,
  };
}

interface KnownBalanceResult {
  address: string;
  subscanBalancePlanck: string;
  status: 'MATCH' | 'BALANCE_MISMATCH' | 'RPC_ERROR';
  finalBalancePlanck?: string;
  error?: string;
}

interface KnownBalanceCheckpoint {
  schemaVersion: 1;
  context: { datasetDigest: string; contract: string; blockNumber: string };
  results: KnownBalanceResult[];
}

interface UnknownBalanceResult {
  address: string;
  balancePlanck: string;
  status: 'POSITIVE' | 'ZERO' | 'RPC_ERROR';
  error?: string;
}

interface UnknownBalanceCheckpoint {
  schemaVersion: 1;
  context: { addressesSha256: string; contract: string; blockNumber: string };
  results: UnknownBalanceResult[];
}

async function queryKnownBalances(
  outputDirectory: string,
  dataset: Rank565Dataset,
  client: Rank565EvmClient,
  contract: Address,
  blockNumber: bigint,
  concurrency: number,
  resume: boolean,
  emitProgress: (message: string) => void,
): Promise<KnownBalanceResult[]> {
  const workDirectory = join(outputDirectory, 'work');
  await mkdir(workDirectory, { recursive: true });
  const checkpointPath = join(workDirectory, 'known-balances-checkpoint.json');
  const context = {
    datasetDigest: dataset.rawDatasetDigest,
    contract: contract.toLowerCase(),
    blockNumber: blockNumber.toString(10),
  };
  let checkpoint: KnownBalanceCheckpoint = { schemaVersion: 1, context, results: [] };
  if (resume && (await fileExists(checkpointPath))) {
    const saved = JSON.parse(await readFile(checkpointPath, 'utf8')) as KnownBalanceCheckpoint;
    if (
      saved.schemaVersion !== 1 ||
      saved.context.datasetDigest !== context.datasetDigest ||
      saved.context.contract !== context.contract ||
      saved.context.blockNumber !== context.blockNumber
    ) {
      throw new Rank565ResumeContextMismatchError(
        'Known-balance checkpoint context does not match.',
        {
          datasetDigest: context.datasetDigest,
          contract,
          blockNumber: context.blockNumber,
        },
      );
    }
    checkpoint = saved;
  } else if (!resume) {
    await writeCheckpoint(checkpointPath, checkpoint);
  }
  const existing = new Map(checkpoint.results.map((result) => [result.address, result]));
  const pending = dataset.knownAddresses.filter(
    (address) => !existing.has(address) || existing.get(address)?.status === 'RPC_ERROR',
  );
  let saveChain = Promise.resolve();
  const save = async (): Promise<void> => {
    saveChain = saveChain.then(() =>
      writeCheckpoint(checkpointPath, {
        schemaVersion: 1,
        context,
        results: [...existing.values()].sort((a, b) =>
          compareCanonicalStrings(a.address, b.address),
        ),
      }),
    );
    await saveChain;
  };
  let completed = dataset.knownAddresses.length - pending.length;
  await withConcurrency(pending, concurrency, async (address) => {
    const expected = dataset.knownBalances.get(address) ?? '0';
    let result: KnownBalanceResult;
    try {
      const finalBalance = exactU256(
        await historicalQuery(`balanceOf(${address})`, () =>
          client.readContract({
            address: contract,
            functionName: 'balanceOf',
            args: [address as Address],
            blockNumber,
          }),
        ),
        `balanceOf(${address})`,
      );
      result = {
        address,
        subscanBalancePlanck: expected,
        finalBalancePlanck: finalBalance.toString(10),
        status: finalBalance.toString(10) === expected ? 'MATCH' : 'BALANCE_MISMATCH',
      };
    } catch (error) {
      result = {
        address,
        subscanBalancePlanck: expected,
        status: 'RPC_ERROR',
        error: errorMessage(error),
      };
    }
    existing.set(address, result);
    completed += 1;
    await save();
    if (completed % 100 === 0 || completed === dataset.knownAddresses.length) {
      emitProgress(`[rank565] known balances ${completed}/${dataset.knownAddresses.length}`);
    }
  });
  await save();
  return [...existing.values()].sort((a, b) => compareCanonicalStrings(a.address, b.address));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function queryUnknownBalances(
  outputDirectory: string,
  unknownAddresses: readonly string[],
  addressesSha256: string,
  client: Rank565EvmClient,
  contract: Address,
  blockNumber: bigint,
  concurrency: number,
  resume: boolean,
  emitProgress: (message: string) => void,
): Promise<UnknownBalanceResult[]> {
  const workDirectory = join(outputDirectory, 'work');
  await mkdir(workDirectory, { recursive: true });
  const checkpointPath = join(workDirectory, 'unknown-balances-checkpoint.json');
  const context = {
    addressesSha256,
    contract: contract.toLowerCase(),
    blockNumber: blockNumber.toString(10),
  };
  let checkpoint: UnknownBalanceCheckpoint = { schemaVersion: 1, context, results: [] };
  if (resume && (await fileExists(checkpointPath))) {
    const saved = JSON.parse(await readFile(checkpointPath, 'utf8')) as UnknownBalanceCheckpoint;
    if (
      saved.schemaVersion !== 1 ||
      saved.context.addressesSha256 !== context.addressesSha256 ||
      saved.context.contract !== context.contract ||
      saved.context.blockNumber !== context.blockNumber
    ) {
      throw new Rank565ResumeContextMismatchError(
        'Unknown-balance checkpoint context does not match.',
        { addressesSha256, contract, blockNumber: context.blockNumber },
      );
    }
    checkpoint = saved;
  } else if (!resume) {
    await writeCheckpoint(checkpointPath, checkpoint);
  }
  const existing = new Map(checkpoint.results.map((result) => [result.address, result]));
  const pending = unknownAddresses.filter(
    (address) => !existing.has(address) || existing.get(address)?.status === 'RPC_ERROR',
  );
  let saveChain = Promise.resolve();
  const save = async (): Promise<void> => {
    saveChain = saveChain.then(() =>
      writeCheckpoint(checkpointPath, {
        schemaVersion: 1,
        context,
        results: [...existing.values()].sort((a, b) =>
          compareCanonicalStrings(a.address, b.address),
        ),
      }),
    );
    await saveChain;
  };
  let completed = unknownAddresses.length - pending.length;
  await withConcurrency(pending, concurrency, async (address) => {
    let result: UnknownBalanceResult;
    try {
      const balance = exactU256(
        await historicalQuery(`unknown balanceOf(${address})`, () =>
          client.readContract({
            address: contract,
            functionName: 'balanceOf',
            args: [address as Address],
            blockNumber,
          }),
        ),
        `balanceOf(${address})`,
      );
      result = {
        address,
        balancePlanck: balance.toString(10),
        status: balance > 0n ? 'POSITIVE' : 'ZERO',
      };
    } catch (error) {
      result = { address, balancePlanck: '0', status: 'RPC_ERROR', error: errorMessage(error) };
    }
    existing.set(address, result);
    completed += 1;
    await save();
    if (completed % 100 === 0 || completed === unknownAddresses.length) {
      emitProgress(`[rank565] unknown balances ${completed}/${unknownAddresses.length}`);
    }
  });
  await save();
  return [...existing.values()].sort((a, b) => compareCanonicalStrings(a.address, b.address));
}

async function writeDiagnosticSums(outputDirectory: string): Promise<void> {
  const files: Array<[string, Uint8Array]> = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'work' || entry.name === 'SHA256SUMS') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push([relative(outputDirectory, path), await readFile(path)]);
    }
  }
  await visit(outputDirectory);
  files.sort(([a], [b]) => compareCanonicalStrings(a, b));
  await writeOverwrite(
    join(outputDirectory, 'SHA256SUMS'),
    files.map(([name, content]) => `${sha256Hex(content)}  ${name}`).join('\n') +
      (files.length ? '\n' : ''),
  );
}

interface Rank565Report {
  branch: string;
  commit: string;
  worktreeClean: boolean | null;
  finalBlockNumber: string;
  contractExists: boolean | null;
  symbol: string | null;
  decimals: number | null;
  codeHash: string | null;
  contractCodeSize: number | null;
  zeroAddressBalancePlanck: string | null;
  zeroAddressCodeSize: number | null;
  totalSupplyPlanck: string | null;
  knownUniqueAddressCount: number;
  knownFinalPositiveCount: number | null;
  knownFinalSumPlanck: string | null;
  knownBalanceMismatchCount: number | null;
  unaccountedSupplyPlanck: string | null;
  expectedRank565Planck: string;
  unaccountedEqualsRank565: boolean | null;
  migrationTransferEnumerationComplete: 'YES' | 'NO' | 'UNKNOWN';
  transferUniqueAddressCount: number | null;
  unknownTransferAddressCount: number | null;
  unknownPositiveAddressCount: number | null;
  unknownBalanceRpcErrorCount: number | null;
  exactBalanceCandidateCount: number | null;
  recoveredAddress: string | null;
  recoveredBalancePlanck: string | null;
  supplyEqualityAfterRecovery: boolean | null;
  rank565Status: 'RESOLVED' | 'UNRESOLVED';
  rawDatasetDigest: string | null;
  rawFileCount: number | null;
  rawRowCount: number | null;
  validRowCount: number | null;
  invalidRowCount: number | null;
  invalidRows: Rank565InvalidRow[];
  error: string | null;
  limitations: string[];
}

function initialReport(): Rank565Report {
  return {
    branch: 'unknown',
    commit: 'unknown',
    worktreeClean: null,
    finalBlockNumber: RANK565_BLOCK_NUMBER,
    contractExists: null,
    symbol: null,
    decimals: null,
    codeHash: null,
    contractCodeSize: null,
    zeroAddressBalancePlanck: null,
    zeroAddressCodeSize: null,
    totalSupplyPlanck: null,
    knownUniqueAddressCount: 7288,
    knownFinalPositiveCount: null,
    knownFinalSumPlanck: null,
    knownBalanceMismatchCount: null,
    unaccountedSupplyPlanck: null,
    expectedRank565Planck: RANK565_MISSING_BALANCE_PLANCK,
    unaccountedEqualsRank565: null,
    migrationTransferEnumerationComplete: 'UNKNOWN',
    transferUniqueAddressCount: null,
    unknownTransferAddressCount: null,
    unknownPositiveAddressCount: null,
    unknownBalanceRpcErrorCount: null,
    exactBalanceCandidateCount: null,
    recoveredAddress: null,
    recoveredBalancePlanck: null,
    supplyEqualityAfterRecovery: null,
    rank565Status: 'UNRESOLVED',
    rawDatasetDigest: null,
    rawFileCount: null,
    rawRowCount: null,
    validRowCount: null,
    invalidRowCount: null,
    invalidRows: [],
    error: null,
    limitations: [],
  };
}

function reportText(report: Rank565Report): string {
  const lines = [
    `BRANCH=${report.branch}`,
    `COMMIT=${report.commit}`,
    `WORKTREE_CLEAN=${report.worktreeClean === null ? 'UNKNOWN' : report.worktreeClean ? 'true' : 'false'}`,
    '',
    `FINAL_BLOCK_NUMBER=${report.finalBlockNumber}`,
    '',
    `CONTRACT_EXISTS=${report.contractExists === null ? 'UNKNOWN' : report.contractExists}`,
    `SYMBOL=${report.symbol ?? ''}`,
    `DECIMALS=${report.decimals ?? ''}`,
    `CODE_HASH=${report.codeHash ?? ''}`,
    `CONTRACT_CODE_SIZE=${report.contractCodeSize ?? ''}`,
    `ZERO_ADDRESS_CODE_SIZE=${report.zeroAddressCodeSize ?? ''}`,
    '',
    `ZERO_ADDRESS_BALANCE_PLANCK=${report.zeroAddressBalancePlanck ?? ''}`,
    '',
    `TOTAL_SUPPLY_PLANCK=${report.totalSupplyPlanck ?? ''}`,
    '',
    `KNOWN_UNIQUE_ADDRESS_COUNT=${report.knownUniqueAddressCount}`,
    `KNOWN_FINAL_POSITIVE_COUNT=${report.knownFinalPositiveCount ?? ''}`,
    `KNOWN_FINAL_SUM_PLANCK=${report.knownFinalSumPlanck ?? ''}`,
    `KNOWN_BALANCE_MISMATCH_COUNT=${report.knownBalanceMismatchCount ?? ''}`,
    '',
    `UNACCOUNTED_SUPPLY_PLANCK=${report.unaccountedSupplyPlanck ?? ''}`,
    `EXPECTED_RANK565_PLANCK=${report.expectedRank565Planck}`,
    `UNACCOUNTED_EQUALS_RANK565=${report.unaccountedEqualsRank565 ?? ''}`,
    '',
    `MIGRATION_TRANSFER_ENUMERATION_COMPLETE=${report.migrationTransferEnumerationComplete}`,
    `TRANSFER_UNIQUE_ADDRESS_COUNT=${report.transferUniqueAddressCount ?? ''}`,
    `UNKNOWN_TRANSFER_ADDRESS_COUNT=${report.unknownTransferAddressCount ?? ''}`,
    `UNKNOWN_POSITIVE_ADDRESS_COUNT=${report.unknownPositiveAddressCount ?? ''}`,
    `UNKNOWN_BALANCE_RPC_ERROR_COUNT=${report.unknownBalanceRpcErrorCount ?? ''}`,
    `EXACT_BALANCE_CANDIDATE_COUNT=${report.exactBalanceCandidateCount ?? ''}`,
    `RECOVERED_ADDRESS=${report.recoveredAddress ?? ''}`,
    `RECOVERED_BALANCE_PLANCK=${report.recoveredBalancePlanck ?? ''}`,
    `SUPPLY_EQUALITY_AFTER_RECOVERY=${report.supplyEqualityAfterRecovery ?? ''}`,
    '',
    `RANK565_STATUS=${report.rank565Status}`,
    `RAW_DATASET_DIGEST=${report.rawDatasetDigest ?? ''}`,
    `RAW_FILE_COUNT=${report.rawFileCount ?? ''}`,
    `RAW_ROW_COUNT=${report.rawRowCount ?? ''}`,
    `VALID_ROW_COUNT=${report.validRowCount ?? ''}`,
    `INVALID_ROW_COUNT=${report.invalidRowCount ?? ''}`,
    `TESTS=run separately`,
    `TYPECHECK=run separately`,
    `LINT=run separately`,
    `BUILD=run separately`,
  ];
  if (report.error) lines.push('', `ERROR=${report.error}`);
  for (const limitation of report.limitations) lines.push(`LIMITATION=${limitation}`);
  return lines.join('\n') + '\n';
}

async function readGitState(): Promise<Pick<Rank565Report, 'branch' | 'commit' | 'worktreeClean'>> {
  try {
    const [branch, commit, status] = await Promise.all([
      execFileAsync('git', ['branch', '--show-current']),
      execFileAsync('git', ['rev-parse', 'HEAD']),
      execFileAsync('git', ['status', '--porcelain']),
    ]);
    return {
      branch: branch.stdout.trim() || 'unknown',
      commit: commit.stdout.trim() || 'unknown',
      worktreeClean: status.stdout.trim() === '',
    };
  } catch {
    return { branch: 'unknown', commit: 'unknown', worktreeClean: null };
  }
}

async function persistReport(outputDirectory: string, report: Rank565Report): Promise<void> {
  await writeOverwrite(join(outputDirectory, 'report.json'), json(report));
  await writeOverwrite(join(outputDirectory, 'report.txt'), reportText(report));
  await writeDiagnosticSums(outputDirectory);
}

export interface Rank565DiagnosticOptions {
  dataset: string;
  evmRpc: string;
  blockNumber: string;
  fromBlock?: string;
  output?: string;
  concurrency?: number;
  chunkSize?: number;
  resume?: boolean;
  force?: boolean;
}

export interface Rank565DiagnosticResult {
  status: 'RESOLVED' | 'UNRESOLVED';
  report: Rank565Report;
  reportText: string;
  outputDirectory: string;
}

export async function runRank565Diagnostic(
  options: Rank565DiagnosticOptions,
  client?: Rank565EvmClient,
  emitProgress: (message: string) => void = (message) => console.error(message),
): Promise<Rank565DiagnosticResult> {
  const outputDirectory = resolve(options.output ?? 'diagnostics/rank565');
  const report = initialReport();
  Object.assign(report, await readGitState());
  if (options.blockNumber !== RANK565_BLOCK_NUMBER) {
    report.error = `This diagnostic is pinned to block ${RANK565_BLOCK_NUMBER}.`;
    report.limitations.push(`requested block was ${options.blockNumber}`);
    await mkdir(outputDirectory, { recursive: true });
    await persistReport(outputDirectory, report);
    return {
      status: report.rank565Status,
      report,
      reportText: reportText(report),
      outputDirectory,
    };
  }
  if (
    (await fileExists(join(outputDirectory, 'report.json'))) &&
    !options.force &&
    !options.resume
  ) {
    throw new Rank565DiagnosticError(
      `Rank 565 diagnostic output already exists: ${outputDirectory}; use --force or --resume.`,
      { outputDirectory },
    );
  }
  if (options.force && (await pathExists(outputDirectory))) {
    await rm(outputDirectory, { recursive: true, force: true });
  }
  await mkdir(outputDirectory, { recursive: true });
  try {
    const dataset = await readRawDataset(options.dataset);
    Object.assign(report, {
      rawDatasetDigest: dataset.rawDatasetDigest,
      rawFileCount: dataset.rawFileCount,
      rawRowCount: dataset.rawRowCount,
      validRowCount: dataset.validRowCount,
      invalidRowCount: dataset.invalidRowCount,
      invalidRows: dataset.invalidRows,
      knownUniqueAddressCount: dataset.uniqueValidAddressCount,
    });
    await writeOverwrite(
      join(outputDirectory, 'README.md'),
      [
        '# xcDOT Rank 565 diagnostic evidence',
        '',
        'This directory is non-canonical investigation evidence. It never changes the raw Subscan CSV files.',
        '',
        `Pinned block: ${RANK565_BLOCK_NUMBER}`,
        `Contract: ${XC_DOT_XC20_ADDRESS}`,
        `Expected missing balance: ${RANK565_MISSING_BALANCE_PLANCK} planck`,
        '',
        'The raw row remains `565,,14.3274324851`. A resolution artifact is written only after independent final-state and supply verification.',
        '',
      ].join('\n'),
    );
    await writeOverwrite(
      join(outputDirectory, 'known-addresses.ndjson'),
      ndjson(
        dataset.knownAddresses.map((address) => ({
          address,
          subscanBalancePlanck: dataset.knownBalances.get(address) ?? '0',
        })),
      ),
    );
    await writeOverwrite(
      join(outputDirectory, 'dataset-audit.json'),
      json({
        schemaVersion: DIAGNOSTIC_VERSION,
        rawFileCount: dataset.rawFileCount,
        rawRowCount: dataset.rawRowCount,
        validRowCount: dataset.validRowCount,
        invalidRowCount: dataset.invalidRowCount,
        uniqueValidAddressCount: dataset.uniqueValidAddressCount,
        exactDuplicateAddressCount: dataset.exactDuplicateAddressCount,
        conflictingDuplicateCount: dataset.conflictingDuplicateCount,
        rawDatasetDigest: dataset.rawDatasetDigest,
        knownSubscanSumPlanck: dataset.knownSubscanSumPlanck,
        expectedUniqueTotalPlanck: dataset.expectedUniqueTotalPlanck,
        invalidRows: dataset.invalidRows,
        rank565SourceFile: RANK565_SOURCE_FILE,
        originalRank565Row: '565,,14.3274324851',
      }),
    );

    const blockNumber = parseUnsignedDecimal(options.blockNumber, 'block number');
    const contract = XC_DOT_XC20_ADDRESS as Address;
    const evm = client ?? createRank565EvmClient(options.evmRpc);
    const chainId = await historicalQuery('chain ID', () => evm.getChainId());
    if (chainId !== 1284) {
      throw new Rank565DiagnosticError('EVM RPC is not Moonbeam mainnet.', { chainId });
    }
    const block = await historicalQuery('EVM block', () => evm.getBlock({ blockNumber }));
    if (block.number !== blockNumber || !block.hash) {
      throw new Rank565DiagnosticError(
        'EVM RPC returned the wrong or incomplete historical block.',
        {
          requestedBlock: options.blockNumber,
          returnedBlock: block.number?.toString(10) ?? 'null',
          returnedHash: block.hash ?? 'null',
        },
      );
    }

    const code = await historicalQuery('xcDOT contract code', () =>
      evm.getCode({ address: contract, blockNumber }),
    );
    if (!code || code === '0x' || code.length <= 2) {
      report.contractExists = false;
      throw new Rank565DiagnosticError('xcDOT contract has no runtime code at the pinned block.', {
        contract,
        blockNumber: options.blockNumber,
      });
    }
    if (!/^0x[0-9a-fA-F]*$/.test(code) || (code.length - 2) % 2 !== 0) {
      throw new Rank565DiagnosticError('EVM RPC returned invalid xcDOT runtime code.');
    }
    report.contractExists = true;
    report.contractCodeSize = (code.length - 2) / 2;
    report.codeHash = keccak256(code);
    const zeroCode = await historicalQuery('zero-address code', () =>
      evm.getCode({ address: ZERO_ADDRESS, blockNumber }),
    );
    report.zeroAddressCodeSize = zeroCode && zeroCode !== '0x' ? (zeroCode.length - 2) / 2 : 0;

    const symbol = await historicalQuery('xcDOT symbol', () =>
      evm.readContract({ address: contract, functionName: 'symbol', blockNumber }),
    );
    const decimalsValue = await historicalQuery('xcDOT decimals', () =>
      evm.readContract({ address: contract, functionName: 'decimals', blockNumber }),
    );
    const decimals =
      typeof decimalsValue === 'bigint' ? Number(decimalsValue) : Number(decimalsValue);
    report.symbol = typeof symbol === 'string' ? symbol : String(symbol);
    report.decimals = decimals;
    const zeroBalance = exactU256(
      await historicalQuery('zero-address balanceOf', () =>
        evm.readContract({
          address: contract,
          functionName: 'balanceOf',
          args: [ZERO_ADDRESS],
          blockNumber,
        }),
      ),
      'balanceOf(zero address)',
    );
    report.zeroAddressBalancePlanck = zeroBalance.toString(10);
    await writeOverwrite(
      join(outputDirectory, 'zero-address.json'),
      json({
        schemaVersion: DIAGNOSTIC_VERSION,
        blockNumber: options.blockNumber,
        contract,
        address: ZERO_ADDRESS,
        codeSize: report.zeroAddressCodeSize,
        balancePlanck: report.zeroAddressBalancePlanck,
        balanceXcdot: `${zeroBalance / 10n ** BigInt(XC_DOT_DECIMALS)}.${(zeroBalance % 10n ** BigInt(XC_DOT_DECIMALS)).toString(10).padStart(XC_DOT_DECIMALS, '0')}`,
        standardErc20ZeroAddressBalance: zeroBalance === 0n,
      }),
    );
    if (zeroBalance !== 0n) {
      report.limitations.push(
        'zero address has a non-zero final balance; Rank 565 was not assigned to it.',
      );
      throw new Rank565DiagnosticError(
        'Zero address has a non-zero xcDOT balance at the pinned block.',
        {
          zeroAddressBalancePlanck: report.zeroAddressBalancePlanck,
        },
      );
    }

    const totalSupply = exactU256(
      await historicalQuery('xcDOT totalSupply', () =>
        evm.readContract({ address: contract, functionName: 'totalSupply', blockNumber }),
      ),
      'totalSupply',
    );
    report.totalSupplyPlanck = totalSupply.toString(10);
    if (report.symbol !== XC_DOT_SYMBOL || report.decimals !== XC_DOT_DECIMALS) {
      throw new Rank565DiagnosticError(
        'xcDOT contract metadata does not match expected identity.',
        {
          symbol: report.symbol,
          decimals: report.decimals,
        },
      );
    }
    await writeOverwrite(
      join(outputDirectory, 'contract-state.json'),
      json({
        blockNumber: options.blockNumber,
        contract,
        symbol: report.symbol,
        decimals: report.decimals,
        totalSupplyPlanck: report.totalSupplyPlanck,
        zeroAddressBalancePlanck: report.zeroAddressBalancePlanck,
        codeHash: report.codeHash,
        codeSize: report.contractCodeSize,
        evmBlockHash: block.hash.toLowerCase(),
      }),
    );

    const expectedUnique = BigInt(dataset.expectedUniqueTotalPlanck);
    const knownSubscan = BigInt(dataset.knownSubscanSumPlanck);
    const totalMatchesExpected = totalSupply === expectedUnique;
    const totalMatchesKnownOnly = totalSupply === knownSubscan;
    await writeOverwrite(
      join(outputDirectory, 'supply-comparison.json'),
      json({
        blockNumber: options.blockNumber,
        totalSupplyPlanck: totalSupply.toString(10),
        knownSubscanUniqueSumPlanck: dataset.knownSubscanSumPlanck,
        expectedRank565UniqueTotalPlanck: dataset.expectedUniqueTotalPlanck,
        totalMatchesExpectedRank565Total: totalMatchesExpected,
        totalMatchesKnownOnly: totalMatchesKnownOnly,
        deltaFromKnownOnlyPlanck: (totalSupply - knownSubscan).toString(10),
      }),
    );
    if (!totalMatchesExpected && !totalMatchesKnownOnly) {
      report.limitations.push(
        'totalSupply matches neither the known-only nor Rank-565-adjusted diagnostic total.',
      );
      throw new Rank565DiagnosticError(
        'xcDOT totalSupply is inconsistent with expected diagnostic totals.',
        {
          totalSupplyPlanck: totalSupply.toString(10),
          knownSubscanUniqueSumPlanck: dataset.knownSubscanSumPlanck,
          expectedRank565UniqueTotalPlanck: dataset.expectedUniqueTotalPlanck,
        },
      );
    }

    const concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Rank565DiagnosticError('Concurrency must be an integer between 1 and 16.', {
        concurrency,
      });
    }
    const knownResults = await queryKnownBalances(
      outputDirectory,
      dataset,
      evm,
      contract,
      blockNumber,
      concurrency,
      Boolean(options.resume),
      emitProgress,
    );
    await writeOverwrite(
      join(outputDirectory, 'known-final-balances.ndjson'),
      ndjson(knownResults),
    );
    const knownErrors = knownResults.filter((result) => result.status === 'RPC_ERROR');
    const knownMismatches = knownResults.filter((result) => result.status === 'BALANCE_MISMATCH');
    const knownPositive = knownResults.filter(
      (result) => result.finalBalancePlanck !== undefined && BigInt(result.finalBalancePlanck) > 0n,
    );
    report.knownFinalPositiveCount = knownPositive.length;
    report.knownBalanceMismatchCount = knownMismatches.length;
    if (knownErrors.length === 0) {
      const knownFinalSum = knownResults.reduce(
        (sum, result) => sum + BigInt(result.finalBalancePlanck ?? '0'),
        0n,
      );
      report.knownFinalSumPlanck = knownFinalSum.toString(10);
      const unaccounted = totalSupply - knownFinalSum;
      report.unaccountedSupplyPlanck = unaccounted.toString(10);
      report.unaccountedEqualsRank565 = unaccounted === BigInt(RANK565_MISSING_BALANCE_PLANCK);
    } else {
      report.limitations.push(
        `${knownErrors.length} known-holder balance queries failed; final known sum is incomplete.`,
      );
    }
    await writeOverwrite(
      join(outputDirectory, 'known-final-summary.json'),
      json({
        blockNumber: options.blockNumber,
        addressCount: dataset.knownAddresses.length,
        positiveCount: report.knownFinalPositiveCount,
        rpcErrorCount: knownErrors.length,
        mismatchCount: knownMismatches.length,
        sumPlanck: report.knownFinalSumPlanck,
        unaccountedSupplyPlanck: report.unaccountedSupplyPlanck,
      }),
    );
    if (
      knownErrors.length > 0 ||
      knownMismatches.length > 0 ||
      report.unaccountedEqualsRank565 !== true
    ) {
      report.limitations.push(
        'D5 did not establish a clean known-holder final-state balance set with the exact Rank 565 delta.',
      );
      throw new Rank565DiagnosticError(
        'Known-holder final-state verification did not establish the exact Rank 565 delta.',
        {
          rpcErrorCount: knownErrors.length,
          mismatchCount: knownMismatches.length,
          unaccountedSupplyPlanck: report.unaccountedSupplyPlanck ?? 'unknown',
        },
      );
    }

    if (!options.fromBlock) {
      report.limitations.push(
        'Transfer scan start block was not supplied; no multi-million-block scan was started implicitly.',
      );
      throw new Rank565DiagnosticError(
        'A justified --from-block is required before scanning Transfer history.',
      );
    }
    const fromBlock = parseUnsignedDecimal(options.fromBlock, 'from block');
    if (fromBlock < 0n || fromBlock > blockNumber) {
      throw new Rank565DiagnosticError('from block must be within the pinned block range.', {
        fromBlock: fromBlock.toString(10),
        blockNumber: blockNumber.toString(10),
      });
    }
    const chunkSize = options.chunkSize ?? 10_000;
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 100_000) {
      throw new Rank565DiagnosticError('Chunk size must be an integer between 1 and 100000.', {
        chunkSize,
      });
    }
    const scan = await scanTransferHistory(
      outputDirectory,
      evm,
      contract,
      blockNumber,
      fromBlock,
      chunkSize,
      Boolean(options.resume),
      emitProgress,
    );
    const transferAddresses = [
      ...new Set(
        scan.records
          .flatMap((record) => [record.from, record.to])
          .filter((address) => address !== ZERO_ADDRESS),
      ),
    ].sort(compareCanonicalStrings);
    const unknownAddresses = setDifference(transferAddresses, dataset.knownAddresses);
    const knownAbsentFromTransfer = setDifference(dataset.knownAddresses, transferAddresses);
    report.transferUniqueAddressCount = transferAddresses.length;
    report.unknownTransferAddressCount = unknownAddresses.length;
    report.migrationTransferEnumerationComplete =
      knownAbsentFromTransfer.length === 0 ? 'YES' : 'NO';
    await writeOverwrite(join(outputDirectory, 'transfer-events.ndjson'), ndjson(scan.records));
    await writeOverwrite(
      join(outputDirectory, 'transfer-addresses.ndjson'),
      ndjson(transferAddresses.map((address) => ({ address }))),
    );
    await writeOverwrite(
      join(outputDirectory, 'unknown-transfer-addresses.ndjson'),
      ndjson(unknownAddresses.map((address) => ({ address }))),
    );
    await writeOverwrite(
      join(outputDirectory, 'transfer-scan-summary.json'),
      json({
        schemaVersion: DIAGNOSTIC_VERSION,
        contract,
        blockNumber: options.blockNumber,
        fromBlock: scan.fromBlock,
        toBlock: scan.toBlock,
        eventTopic: TRANSFER_EVENT_TOPIC,
        rangeCount: scan.ranges.length,
        ranges: scan.ranges,
        logCount: scan.records.length,
        uniqueAddressCount: transferAddresses.length,
        knownAbsentFromTransferCount: knownAbsentFromTransfer.length,
        knownAbsentFromTransfer: knownAbsentFromTransfer,
        migrationTransferEnumerationComplete: report.migrationTransferEnumerationComplete,
      }),
    );
    if (knownAbsentFromTransfer.length > 0) {
      report.limitations.push(
        `${knownAbsentFromTransfer.length} known Subscan addresses are absent from Transfer history; coverage is not complete.`,
      );
      throw new Rank565DiagnosticError(
        'Transfer history does not cover every known Subscan holder.',
        {
          knownAbsentFromTransferCount: knownAbsentFromTransfer.length,
        },
      );
    }

    const unknownAddressesSha256 = sha256Hex(
      ndjson(unknownAddresses.map((address) => ({ address }))),
    );
    const unknownResults = await queryUnknownBalances(
      outputDirectory,
      unknownAddresses,
      unknownAddressesSha256,
      evm,
      contract,
      blockNumber,
      concurrency,
      Boolean(options.resume),
      emitProgress,
    );
    const unknownPositive = unknownResults.filter((record) => record.status === 'POSITIVE');
    await writeOverwrite(join(outputDirectory, 'unknown-balances.ndjson'), ndjson(unknownResults));
    await writeOverwrite(
      join(outputDirectory, 'unknown-positive-balances.ndjson'),
      ndjson(unknownPositive.map(({ address, balancePlanck }) => ({ address, balancePlanck }))),
    );
    report.unknownPositiveAddressCount = unknownPositive.length;
    const unknownErrors = unknownResults.filter((record) => record.status === 'RPC_ERROR');
    report.unknownBalanceRpcErrorCount = unknownErrors.length;
    if (unknownErrors.length > 0) {
      report.limitations.push(
        `${unknownErrors.length} unknown Transfer-history balance queries failed; recovery is incomplete.`,
      );
    }
    const candidates = exactBalanceCandidates(unknownPositive, RANK565_MISSING_BALANCE_PLANCK);
    report.exactBalanceCandidateCount = candidates.length;
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate) report.recoveredAddress = candidate;
    if (candidate) report.recoveredBalancePlanck = RANK565_MISSING_BALANCE_PLANCK;
    const knownFinalSum = BigInt(report.knownFinalSumPlanck ?? '0');
    const supplyEquality =
      candidate !== undefined &&
      report.knownFinalSumPlanck !== null &&
      unknownErrors.length === 0 &&
      knownFinalSum + BigInt(RANK565_MISSING_BALANCE_PLANCK) === totalSupply;
    report.supplyEqualityAfterRecovery = supplyEquality;
    const resolutionBase = {
      rank: RANK565,
      missingBalancePlanck: RANK565_MISSING_BALANCE_PLANCK,
      candidateCount: candidates.length,
      candidates,
      ...(candidate
        ? { candidate: { address: candidate, finalBalancePlanck: RANK565_MISSING_BALANCE_PLANCK } }
        : {}),
      checks: {
        notZeroAddress: candidate !== undefined && candidate !== ZERO_ADDRESS,
        notAlreadyKnown: candidate !== undefined && !dataset.knownBalances.has(candidate),
        exactBalanceMatch: candidate !== undefined,
        allUnknownBalancesQueried: unknownErrors.length === 0,
        totalSupplyCompleteness: supplyEquality,
      },
    };
    if (candidate === undefined || !supplyEquality || unknownErrors.length > 0) {
      await writeOverwrite(
        join(outputDirectory, 'candidate-resolution.json'),
        json({ ...resolutionBase, status: 'UNRESOLVED' }),
      );
      if (candidates.length === 0)
        report.limitations.push(
          'No unknown Transfer-history address has the exact Rank 565 final balance.',
        );
      if (candidates.length > 1)
        report.limitations.push(
          'More than one unknown address has the exact Rank 565 final balance; no guess was made.',
        );
      throw new Rank565DiagnosticError(
        'Rank 565 was not uniquely resolved with final-state and supply evidence.',
        {
          candidateCount: candidates.length,
          unknownBalanceRpcErrorCount: unknownErrors.length,
          supplyEqualityAfterRecovery: supplyEquality,
        },
      );
    }

    const candidateEvents = scan.records.filter(
      (record) => record.from === candidate || record.to === candidate,
    );
    let reconstructed = 0n;
    for (const event of candidateEvents) {
      const amount = BigInt(event.amountPlanck);
      if (event.from === candidate) reconstructed -= amount;
      if (event.to === candidate) reconstructed += amount;
    }
    const reconstructedMatchesFinal = reconstructed === BigInt(RANK565_MISSING_BALANCE_PLANCK);
    await writeOverwrite(
      join(outputDirectory, 'recovered-transfer-events.ndjson'),
      ndjson(candidateEvents),
    );
    await writeOverwrite(
      join(outputDirectory, 'recovered-address-audit.json'),
      json({
        address: candidate,
        eventCount: candidateEvents.length,
        reconstructedBalancePlanck: reconstructed.toString(10),
        finalBalancePlanck: RANK565_MISSING_BALANCE_PLANCK,
        reconstructedBalanceMatchesFinal: reconstructedMatchesFinal,
      }),
    );
    const resolution = {
      ...resolutionBase,
      checks: { ...resolutionBase.checks, transferAuditMatchesFinal: reconstructedMatchesFinal },
      status: reconstructedMatchesFinal ? 'RESOLVED' : 'UNRESOLVED',
    };
    await writeOverwrite(join(outputDirectory, 'candidate-resolution.json'), json(resolution));
    if (!reconstructedMatchesFinal) {
      report.limitations.push(
        'Recovered address Transfer-event reconstruction does not match its final balance.',
      );
      throw new Rank565DiagnosticError(
        'Recovered address failed the secondary Transfer-event audit.',
      );
    }
    const resolutionDirectory = resolve('snapshots/subscan/resolutions');
    await mkdir(resolutionDirectory, { recursive: true });
    await writeOverwrite(
      join(resolutionDirectory, 'rank-565.json'),
      json({
        schemaVersion: 1,
        rank: RANK565,
        original: {
          account: '',
          balance: '14.3274324851',
          balancePlanck: RANK565_MISSING_BALANCE_PLANCK,
        },
        resolution: { address: candidate, method: 'moonbeam-final-state-and-transfer-history' },
        verification: {
          finalBlockNumber: RANK565_BLOCK_NUMBER,
          finalBalancePlanck: RANK565_MISSING_BALANCE_PLANCK,
          zeroAddressRejected: zeroBalance === 0n,
          supplyCompletenessAfterResolution: supplyEquality,
        },
      }),
    );
    report.rank565Status = 'RESOLVED';
    emitProgress(`[rank565] resolved=${candidate}`);
  } catch (error) {
    report.error = `${errorCode(error)}: ${errorMessage(error)}`;
    emitProgress(`[rank565] ${report.error}`);
  }
  await persistReport(outputDirectory, report);
  return { status: report.rank565Status, report, reportText: reportText(report), outputDirectory };
}
