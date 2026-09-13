import { access, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { XC_DOT_XC20_ADDRESS, MOONBEAM_GENESIS_HASH } from '../asset/constants.js';
import {
  EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
  MOONBEAM_OBSERVED_EVM_BLOCK_HASH,
} from '../final-state/constants.js';
import { candidateAddressesSha256 } from '../subscan/candidates.js';
import {
  DwellirFrontierGapError,
  FinalStateBalanceConflictError,
  FinalStateIdentityMismatchError,
  FinalStateSupplyOverflowError,
} from '../utils/errors.js';
import { compareCanonicalStrings } from '../utils/order.js';
import { loadBackwardBaseState } from '../sqd/backward-recovery.js';
import type { BackwardRecoveryOptions, FinalBalanceResult } from '../sqd/backward-recovery.js';
import { extractIndexedAddress } from '../sqd/xcdot-transfer-candidates.js';
import { TRANSFER_TOPIC0 } from '../sqd/client.js';
import {
  createDwellirCurlTransport,
  resolveDwellirKey,
  type DwellirRpcTransport,
} from './dwellir-final-state-recovery.js';
import {
  captureBalanceReadProof,
  loadBackwardAddressFile,
  loadBackwardBalanceFile,
  readFinalBalance,
} from '../sqd/backward-recovery.js';

export const DWELLIR_GAP_DEFAULT_START = 16_669_569 as const;
export const DWELLIR_GAP_DEFAULT_END = Number(MOONBEAM_FINAL_BLOCK_NUMBER);
export const DWELLIR_GAP_DEFAULT_LOG_WINDOW_BLOCKS = 1_000 as const;
export const DWELLIR_GAP_DEFAULT_TIMEOUT_MS = 300_000 as const;
export const DWELLIR_GAP_DEFAULT_CONNECT_TIMEOUT_MS = 120_000 as const;
export const DWELLIR_GAP_DEFAULT_RETRIES = 5 as const;
export const DWELLIR_GAP_DEFAULT_STORAGE_CONCURRENCY = 2 as const;
export const DWELLIR_GAP_DEFAULT_WORK = 'diagnostics/dwellir-gap-recovery' as const;
export const DWELLIR_GAP_DEFAULT_PRIOR_WORK = 'diagnostics/sqd-backward-recovery' as const;
export const DWELLIR_GAP_DEFAULT_BASE_WORK =
  'diagnostics/dwellir-final-state-recovery-work/moonbeam-16796696' as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type DwellirFrontierGapStatus =
  | 'IN_PROGRESS'
  | 'SUPPLY_COMPLETE'
  | 'GAP_EXHAUSTED_WITH_SHORTFALL'
  | 'DWELLIR_FRONTIER_INDEX_TOO_SHALLOW';

export interface DwellirFrontierPreflight {
  genesisHash: string;
  indexedHeadHash: string;
  indexedHeadNumber: number;
  requiredGapEnd: number;
  frontierGapCoverage: 'PASS' | 'FAIL';
  finalEvmBlockHash: string;
}

export interface DwellirGapRangeResult {
  range: number;
  blockStart: number;
  blockEnd: number;
  blocks: number;
  transferLogs: number;
  transferAddresses: number;
  zeroAddressOccurrences: number;
  newCandidates: number;
  newPositive: number;
  newZero: number;
  newPositiveSumPlanck: string;
  knownCandidateCountAfter: number;
  knownPositiveCountAfter: number;
  knownFinalSumPlanckAfter: string;
  remainingDeficitPlanckAfter: string;
  proofsCaptured: number;
}

export interface DwellirFrontierGapSummary {
  schemaVersion: 1;
  status: DwellirFrontierGapStatus;
  finalBlockNumber: number;
  finalSubstrateBlockHash: string;
  finalStateRoot: string;
  finalEvmBlockHash: string;
  contract: string;
  transferTopic0: string;
  totalSupplyPlanck: string;
  gapStart: number;
  gapEnd: number;
  gapBlocks: number;
  logWindowBlocks: number;
  gapBlocksScanned: number;
  rangesCompleted: number;
  transferLogsTotal: number;
  transferAddressesTotal: number;
  zeroAddressOccurrences: number;
  baseCandidateCount: number;
  baseOrPriorKnownSumPlanck: string;
  knownCandidateCount: number;
  knownPositiveCount: number;
  knownZeroCount: number;
  newCandidatesTotal: number;
  newPositiveTotal: number;
  newZeroTotal: number;
  newPositiveSumPlanck: string;
  finalKnownSumPlanck: string;
  remainingDeficitPlanck: string;
  candidateAddressesSha256: string;
  proofsCaptured: number;
  proofVerification: 'NOT_RUN';
  sqdPriorWork: string;
  preflight: DwellirFrontierPreflight;
  nextPriority?: 'NON_TRANSFER_BALANCE_INITIALIZATION';
}

export interface DwellirFrontierGapResult {
  workDirectory: string;
  summaryFile: string;
  summary: DwellirFrontierGapSummary;
}

export interface DwellirFrontierGapOptions {
  dataset?: string;
  moonscanCsv?: string;
  priorWork?: string;
  baseWork?: string;
  work?: string;
  key?: string;
  keyFile?: string;
  endpointBase?: string;
  gapStart?: number;
  gapEnd?: number;
  logWindowBlocks?: number;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  retries?: number;
  storageConcurrency?: number;
  resume?: boolean;
  force?: boolean;
  transport?: DwellirRpcTransport;
  progress?: (message: string) => void;
  baseCandidates?: readonly string[];
  baseBalances?: readonly FinalBalanceResult[];
  priorCandidates?: readonly string[];
  priorBalances?: readonly FinalBalanceResult[];
  totalSupplyPlanck?: string;
}

interface GapCheckpoint {
  schemaVersion: 1;
  nextCursorEnd: number;
  completedRanges: number;
  gapBlocksScanned: number;
  transferLogsTotal: number;
  transferAddressesTotal: number;
  zeroAddressOccurrences: number;
  newCandidatesTotal: number;
  newPositiveTotal: number;
  newZeroTotal: number;
  newPositiveSumPlanck: string;
  knownFinalSumPlanck: string;
  remainingDeficitPlanck: string;
  proofsCaptured: number;
  status?: DwellirFrontierGapStatus;
}

interface GapContext {
  schemaVersion: 1;
  stage: 'dwellir-frontier-gap';
  finalBlockNumber: number;
  finalSubstrateBlockHash: string;
  finalStateRoot: string;
  finalEvmBlockHash: string;
  contract: string;
  transferTopic0: string;
  totalSupplyPlanck: string;
  gapStart: number;
  gapEnd: number;
  logWindowBlocks: number;
  baseCandidateCount: number;
  baseCandidateDigest: string;
  priorWork: string;
  preflight: DwellirFrontierPreflight;
}

interface LoadedState {
  baseCandidates: Set<string>;
  committedCandidates: Set<string>;
  allKnownCandidates: Set<string>;
  baseBalances: Map<string, FinalBalanceResult>;
  priorBalances: Map<string, FinalBalanceResult>;
  gapBalances: Map<string, FinalBalanceResult>;
  baseOrPriorSum: bigint;
  committedSum: bigint;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalAddress(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new FinalStateIdentityMismatchError(`${label} is not a canonical H160 address.`, {
      value: String(value),
    });
  }
  return value.toLowerCase();
}

function unsignedDecimal(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new FinalStateIdentityMismatchError(`${label} must be an unsigned decimal integer.`, {
      value,
    });
  }
  return BigInt(value);
}

function positiveInteger(value: number, label: string, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    throw new FinalStateIdentityMismatchError(`${label} is outside the supported range.`, {
      [label]: value,
      ...(maximum === undefined ? {} : { maximum }),
    });
  }
  return value;
}

function hexQuantity(value: number): string {
  return `0x${BigInt(value).toString(16)}`;
}

function parseQuantity(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new DwellirFrontierGapError(
      'DWELLIR_GAP_INVALID_LOG',
      `${label} is not a hex quantity.`,
      {
        value: String(value),
      },
    );
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DwellirFrontierGapError(
      'DWELLIR_GAP_INVALID_LOG',
      `${label} is not a safe integer.`,
      {
        value,
      },
    );
  }
  return Number(parsed);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function ndjson<T>(values: readonly T[]): string {
  return values.length === 0 ? '' : values.map((value) => JSON.stringify(value)).join('\n') + '\n';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const handle = await open(temporary, 'w');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sortedAddresses(addresses: Iterable<string>): string[] {
  return [...new Set(addresses)].sort(compareCanonicalStrings);
}

function mergeBalance(
  target: Map<string, FinalBalanceResult>,
  record: FinalBalanceResult,
  source: string,
): void {
  const address = canonicalAddress(record.address, `${source} balance`);
  const normalized = { ...record, address };
  const previous = target.get(address);
  if (
    previous !== undefined &&
    (previous.balancePlanck !== normalized.balancePlanck ||
      previous.rawValue !== normalized.rawValue ||
      previous.substrateStorageKey !== normalized.substrateStorageKey)
  ) {
    throw new FinalStateBalanceConflictError(
      'Dwellir Frontier gap recovery found conflicting final balances.',
      { address, source },
    );
  }
  target.set(address, normalized);
}

function sumBalances(values: Iterable<FinalBalanceResult>): bigint {
  return [...values].reduce((sum, record) => sum + BigInt(record.balancePlanck), 0n);
}

function positiveCount(values: Iterable<FinalBalanceResult>): number {
  return [...values].filter((record) => BigInt(record.balancePlanck) > 0n).length;
}

async function loadPriorContext(priorWork: string, expectedTotalSupply: string): Promise<void> {
  const contextPath = join(priorWork, 'context.json');
  if (!(await pathExists(contextPath))) return;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(contextPath, 'utf8')) as unknown;
  } catch {
    throw new DwellirFrontierGapError(
      'PRIOR_RECOVERY_CONTEXT_MISMATCH',
      'Prior SQD recovery context is not valid JSON.',
      { path: contextPath },
    );
  }
  if (!isObject(value)) {
    throw new DwellirFrontierGapError(
      'PRIOR_RECOVERY_CONTEXT_MISMATCH',
      'Prior SQD recovery context is not an object.',
      { path: contextPath },
    );
  }
  const actual = {
    finalBlockNumber: String(value.finalBlockNumber),
    finalBlockHash: String(value.finalBlockHash).toLowerCase(),
    stateRoot: String(value.stateRoot ?? value.finalStateRoot).toLowerCase(),
    contract: String(value.contract).toLowerCase(),
    totalSupplyPlanck: String(value.totalSupplyPlanck),
  };
  const expected = {
    finalBlockNumber: MOONBEAM_FINAL_BLOCK_NUMBER,
    finalBlockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
    contract: XC_DOT_XC20_ADDRESS,
    totalSupplyPlanck: expectedTotalSupply,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (actual[key] !== expected[key]) {
      throw new DwellirFrontierGapError(
        'PRIOR_RECOVERY_CONTEXT_MISMATCH',
        `Prior SQD recovery context ${key} does not match the pinned final state.`,
        { path: contextPath, field: key, expected: expected[key], actual: actual[key] },
      );
    }
  }
}

async function loadState(
  options: DwellirFrontierGapOptions,
  workDirectory: string,
): Promise<LoadedState> {
  const expectedTotalSupply = options.totalSupplyPlanck ?? EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK;
  const baseOptions: BackwardRecoveryOptions = {
    ...(options.dataset === undefined ? {} : { dataset: options.dataset }),
    ...(options.moonscanCsv === undefined ? {} : { moonscanCsv: options.moonscanCsv }),
    ...(options.baseWork === undefined ? {} : { baseWork: options.baseWork }),
    totalSupplyPlanck: expectedTotalSupply,
    ...(options.baseCandidates === undefined ? {} : { baseCandidates: options.baseCandidates }),
    ...(options.baseBalances === undefined ? {} : { baseBalances: options.baseBalances }),
  };
  const base = await loadBackwardBaseState(baseOptions);
  const priorWork = resolve(options.priorWork ?? DWELLIR_GAP_DEFAULT_PRIOR_WORK);
  await loadPriorContext(priorWork, expectedTotalSupply);
  const priorCandidates =
    options.priorCandidates === undefined
      ? await loadBackwardAddressFile(join(priorWork, 'known-candidates.ndjson'))
      : new Set(
          options.priorCandidates.map((address) => canonicalAddress(address, 'prior candidate')),
        );
  const priorBalances =
    options.priorBalances === undefined
      ? await loadBackwardBalanceFile(join(priorWork, 'new-final-balances.ndjson'))
      : new Map(
          options.priorBalances.map((record) => [
            canonicalAddress(record.address, 'prior balance'),
            record,
          ]),
        );
  const gapBalances = await loadBackwardBalanceFile(
    join(workDirectory, 'new-final-balances.ndjson'),
  );
  const storedCandidates = await loadBackwardAddressFile(
    join(workDirectory, 'known-candidates.ndjson'),
  );
  const committedCandidates = new Set<string>([
    ...base.candidates,
    ...priorCandidates,
    ...storedCandidates,
  ]);
  const allKnownCandidates = new Set(committedCandidates);
  const baseBalances = new Map<string, FinalBalanceResult>();
  const mergedPriorBalances = new Map<string, FinalBalanceResult>();
  for (const record of base.balances.values()) mergeBalance(baseBalances, record, 'base');
  for (const record of priorBalances.values()) {
    const address = canonicalAddress(record.address, 'prior balance');
    if (baseBalances.has(address)) {
      throw new FinalStateBalanceConflictError(
        'Prior SQD recovery balance overlaps the base candidate set.',
        { address },
      );
    }
    mergeBalance(mergedPriorBalances, record, 'prior');
    committedCandidates.add(address);
    allKnownCandidates.add(address);
  }
  for (const record of gapBalances.values()) {
    mergeBalance(gapBalances, record, 'gap');
    allKnownCandidates.add(record.address);
  }
  for (const address of committedCandidates) allKnownCandidates.add(address);
  const baseOrPriorSum = sumBalances([...baseBalances.values(), ...mergedPriorBalances.values()]);
  const committedGapSum = sumBalances(
    [...gapBalances.values()].filter((record) => committedCandidates.has(record.address)),
  );
  const committedSum = baseOrPriorSum + committedGapSum;
  const allSum = baseOrPriorSum + sumBalances(gapBalances.values());
  if (allSum > BigInt(expectedTotalSupply)) {
    throw new FinalStateSupplyOverflowError('Dwellir Frontier gap balances exceed total supply.', {
      knownSumPlanck: allSum.toString(10),
      totalSupplyPlanck: expectedTotalSupply,
    });
  }
  return {
    baseCandidates: new Set(base.candidates),
    committedCandidates,
    allKnownCandidates,
    baseBalances,
    priorBalances: mergedPriorBalances,
    gapBalances,
    baseOrPriorSum,
    committedSum,
  };
}

function validateH256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new DwellirFrontierGapError(
      'DWELLIR_FRONTIER_CHAIN_MISMATCH',
      `${label} is not a block hash.`,
      {
        value: String(value),
      },
    );
  }
  return value.toLowerCase();
}

async function runPreflight(
  transport: DwellirRpcTransport,
  finalBlockNumber: number,
): Promise<DwellirFrontierPreflight> {
  const syncRange = await transport.call('moon_getEthSyncBlockRange', []);
  if (!Array.isArray(syncRange) || syncRange.length !== 2) {
    throw new DwellirFrontierGapError(
      'DWELLIR_FRONTIER_CHAIN_MISMATCH',
      'moon_getEthSyncBlockRange did not return exactly two block hashes.',
    );
  }
  const genesisHash = validateH256(syncRange[0], 'Frontier genesis hash');
  if (genesisHash !== MOONBEAM_GENESIS_HASH) {
    throw new DwellirFrontierGapError(
      'DWELLIR_FRONTIER_CHAIN_MISMATCH',
      'Dwellir Frontier sync range belongs to a different chain.',
      { expectedGenesisHash: MOONBEAM_GENESIS_HASH, actualGenesisHash: genesisHash },
    );
  }
  const indexedHeadHash = validateH256(syncRange[1], 'Frontier indexed head hash');
  const header = await transport.call('chain_getHeader', [indexedHeadHash]);
  if (!isObject(header)) {
    throw new DwellirFrontierGapError(
      'DWELLIR_FRONTIER_CHAIN_MISMATCH',
      'Dwellir Frontier indexed head header is not an object.',
    );
  }
  const indexedHeadNumber = parseQuantity(header.number, 'Frontier indexed head number');
  if (indexedHeadNumber < finalBlockNumber) {
    return {
      genesisHash,
      indexedHeadHash,
      indexedHeadNumber,
      requiredGapEnd: finalBlockNumber,
      frontierGapCoverage: 'FAIL',
      finalEvmBlockHash: '',
    };
  }
  const finalBlock = await transport.call('eth_getBlockByNumber', [
    hexQuantity(finalBlockNumber),
    false,
  ]);
  if (
    !isObject(finalBlock) ||
    typeof finalBlock.number !== 'string' ||
    typeof finalBlock.hash !== 'string'
  ) {
    throw new DwellirFrontierGapError(
      'DWELLIR_FRONTIER_FINAL_BLOCK_MISMATCH',
      'Dwellir did not return the pinned final EVM block.',
    );
  }
  const requested = hexQuantity(finalBlockNumber);
  if (
    finalBlock.number.toLowerCase() !== requested ||
    finalBlock.hash.toLowerCase() !== MOONBEAM_OBSERVED_EVM_BLOCK_HASH
  ) {
    throw new DwellirFrontierGapError(
      'DWELLIR_FRONTIER_FINAL_BLOCK_MISMATCH',
      'Dwellir returned a different EVM block for the pinned final height.',
      {
        expectedNumber: requested,
        actualNumber: finalBlock.number,
        expectedHash: MOONBEAM_OBSERVED_EVM_BLOCK_HASH,
        actualHash: finalBlock.hash,
      },
    );
  }
  return {
    genesisHash,
    indexedHeadHash,
    indexedHeadNumber,
    requiredGapEnd: finalBlockNumber,
    frontierGapCoverage: 'PASS',
    finalEvmBlockHash: finalBlock.hash.toLowerCase(),
  };
}

function validateLog(value: unknown, blockStart: number, blockEnd: number): [string, string] {
  if (!isObject(value)) {
    throw new DwellirFrontierGapError(
      'DWELLIR_GAP_INVALID_LOG',
      'Dwellir returned a non-object log.',
    );
  }
  if (value.address !== XC_DOT_XC20_ADDRESS) {
    throw new DwellirFrontierGapError(
      'DWELLIR_GAP_INVALID_LOG',
      'Log address is not the xcDOT contract.',
      {
        address: String(value.address),
      },
    );
  }
  if (value.removed === true) {
    throw new DwellirFrontierGapError(
      'DWELLIR_GAP_REMOVED_LOG',
      'Dwellir returned a removed Transfer log.',
    );
  }
  if (!Array.isArray(value.topics) || value.topics.length < 3) {
    throw new DwellirFrontierGapError(
      'DWELLIR_GAP_INVALID_LOG',
      'Transfer log has fewer than three topics.',
    );
  }
  const topics = value.topics;
  if (typeof topics[0] !== 'string' || topics[0].toLowerCase() !== TRANSFER_TOPIC0) {
    throw new DwellirFrontierGapError(
      'DWELLIR_GAP_INVALID_LOG',
      'Log topic0 is not the ERC-20 Transfer topic.',
    );
  }
  if (typeof topics[1] !== 'string' || typeof topics[2] !== 'string') {
    throw new DwellirFrontierGapError(
      'DWELLIR_GAP_INVALID_LOG',
      'Transfer indexed topics are not strings.',
    );
  }
  const blockNumber = parseQuantity(value.blockNumber, 'Transfer log blockNumber');
  if (blockNumber < blockStart || blockNumber > blockEnd) {
    throw new DwellirFrontierGapError(
      'DWELLIR_GAP_LOG_OUT_OF_RANGE',
      'Transfer log is outside its requested range.',
      {
        blockNumber,
        blockStart,
        blockEnd,
      },
    );
  }
  return [extractIndexedAddress(topics[1]), extractIndexedAddress(topics[2])];
}

async function readLogs(
  transport: DwellirRpcTransport,
  blockStart: number,
  blockEnd: number,
): Promise<{
  logs: number;
  addresses: Set<string>;
  zeroAddressOccurrences: number;
  transferAddresses: number;
}> {
  const filter = {
    fromBlock: hexQuantity(blockStart),
    toBlock: hexQuantity(blockEnd),
    address: XC_DOT_XC20_ADDRESS,
    topics: [TRANSFER_TOPIC0],
  };
  const result = await transport.call('eth_getLogs', [filter]);
  if (!Array.isArray(result)) {
    throw new DwellirFrontierGapError(
      'DWELLIR_GAP_INVALID_LOG',
      'eth_getLogs did not return an array.',
    );
  }
  const addresses = new Set<string>();
  let zeroAddressOccurrences = 0;
  for (const item of result) {
    const [from, to] = validateLog(item, blockStart, blockEnd);
    for (const address of [from, to]) {
      if (address === ZERO_ADDRESS) zeroAddressOccurrences += 1;
      else addresses.add(address);
    }
  }
  return {
    logs: result.length,
    addresses,
    zeroAddressOccurrences,
    transferAddresses: addresses.size,
  };
}

async function persistBalances(path: string, values: Iterable<FinalBalanceResult>): Promise<void> {
  const records = [...values]
    .sort((left, right) => compareCanonicalStrings(left.address, right.address))
    .map((record) => ({
      address: record.address,
      substrateStorageKey: record.substrateStorageKey,
      rawValue: record.rawValue,
      balancePlanck: record.balancePlanck,
    }));
  await writeAtomic(path, ndjson(records));
}

async function persistCandidates(path: string, candidates: Iterable<string>): Promise<void> {
  await writeAtomic(path, ndjson(sortedAddresses(candidates).map((address) => ({ address }))));
}

async function countProofFiles(path: string): Promise<number> {
  if (!(await pathExists(path))) return 0;
  return (await readdir(path, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.json'),
  ).length;
}

async function ensureGapProofs(
  transport: DwellirRpcTransport,
  balances: Iterable<FinalBalanceResult>,
  proofsDirectory: string,
): Promise<number> {
  for (const record of balances) {
    if (BigInt(record.balancePlanck) > 0n) {
      await captureBalanceReadProof(transport, record, proofsDirectory, true);
    }
  }
  return countProofFiles(proofsDirectory);
}

function makeSummary(
  state: LoadedState,
  preflight: DwellirFrontierPreflight,
  status: DwellirFrontierGapStatus,
  checkpoint: GapCheckpoint,
  options: {
    gapStart: number;
    gapEnd: number;
    totalSupply: bigint;
    logWindowBlocks: number;
    priorWork: string;
  },
): DwellirFrontierGapSummary {
  const totalSupply = options.totalSupply;
  const finalKnownSum = options.totalSupply - BigInt(checkpoint.remainingDeficitPlanck);
  const knownBalances = [
    ...state.baseBalances.values(),
    ...state.priorBalances.values(),
    ...state.gapBalances.values(),
  ];
  const knownPositiveCount = positiveCount(knownBalances);
  const knownZeroCount = state.allKnownCandidates.size - knownPositiveCount;
  const summary: DwellirFrontierGapSummary = {
    schemaVersion: 1,
    status,
    finalBlockNumber: Number(MOONBEAM_FINAL_BLOCK_NUMBER),
    finalSubstrateBlockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    finalStateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
    finalEvmBlockHash: preflight.finalEvmBlockHash,
    contract: XC_DOT_XC20_ADDRESS,
    transferTopic0: TRANSFER_TOPIC0,
    totalSupplyPlanck: totalSupply.toString(10),
    gapStart: options.gapStart,
    gapEnd: options.gapEnd,
    gapBlocks: options.gapEnd - options.gapStart + 1,
    logWindowBlocks: options.logWindowBlocks,
    gapBlocksScanned: checkpoint.gapBlocksScanned,
    rangesCompleted: checkpoint.completedRanges,
    transferLogsTotal: checkpoint.transferLogsTotal,
    transferAddressesTotal: checkpoint.transferAddressesTotal,
    zeroAddressOccurrences: checkpoint.zeroAddressOccurrences,
    baseCandidateCount: state.baseCandidates.size,
    baseOrPriorKnownSumPlanck: state.baseOrPriorSum.toString(10),
    knownCandidateCount: state.allKnownCandidates.size,
    knownPositiveCount,
    knownZeroCount,
    newCandidatesTotal: checkpoint.newCandidatesTotal,
    newPositiveTotal: checkpoint.newPositiveTotal,
    newZeroTotal: checkpoint.newZeroTotal,
    newPositiveSumPlanck: checkpoint.newPositiveSumPlanck,
    finalKnownSumPlanck: finalKnownSum.toString(10),
    remainingDeficitPlanck: checkpoint.remainingDeficitPlanck,
    candidateAddressesSha256: candidateAddressesSha256(sortedAddresses(state.allKnownCandidates)),
    proofsCaptured: checkpoint.proofsCaptured,
    proofVerification: 'NOT_RUN',
    sqdPriorWork: options.priorWork,
    preflight,
  };
  if (status === 'GAP_EXHAUSTED_WITH_SHORTFALL')
    summary.nextPriority = 'NON_TRANSFER_BALANCE_INITIALIZATION';
  return summary;
}

function initialCheckpoint(
  totalSupply: bigint,
  knownSum: bigint,
  nextCursorEnd: number,
): GapCheckpoint {
  const deficit = totalSupply - knownSum;
  return {
    schemaVersion: 1,
    nextCursorEnd,
    completedRanges: 0,
    gapBlocksScanned: 0,
    transferLogsTotal: 0,
    transferAddressesTotal: 0,
    zeroAddressOccurrences: 0,
    newCandidatesTotal: 0,
    newPositiveTotal: 0,
    newZeroTotal: 0,
    newPositiveSumPlanck: '0',
    knownFinalSumPlanck: knownSum.toString(10),
    remainingDeficitPlanck: deficit.toString(10),
    proofsCaptured: 0,
  };
}

async function loadCheckpoint(path: string): Promise<GapCheckpoint | undefined> {
  if (!(await pathExists(path))) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new FinalStateIdentityMismatchError('Dwellir Frontier gap checkpoint is invalid JSON.', {
      path,
    });
  }
  if (!isObject(value) || value.schemaVersion !== 1) {
    throw new FinalStateIdentityMismatchError(
      'Dwellir Frontier gap checkpoint schema is invalid.',
      { path },
    );
  }
  const numeric = [
    'nextCursorEnd',
    'completedRanges',
    'gapBlocksScanned',
    'transferLogsTotal',
    'transferAddressesTotal',
    'zeroAddressOccurrences',
    'newCandidatesTotal',
    'newPositiveTotal',
    'newZeroTotal',
    'proofsCaptured',
  ] as const;
  for (const field of numeric) {
    if (
      !Number.isSafeInteger(value[field]) ||
      (field === 'nextCursorEnd' ? (value[field] as number) < -1 : (value[field] as number) < 0)
    ) {
      throw new FinalStateIdentityMismatchError(
        'Dwellir Frontier gap checkpoint counter is invalid.',
        { path, field },
      );
    }
  }
  const decimal = [
    'newPositiveSumPlanck',
    'knownFinalSumPlanck',
    'remainingDeficitPlanck',
  ] as const;
  for (const field of decimal) {
    if (typeof value[field] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value[field])) {
      throw new FinalStateIdentityMismatchError(
        'Dwellir Frontier gap checkpoint supply counter is invalid.',
        { path, field },
      );
    }
  }
  return value as unknown as GapCheckpoint;
}

async function writeRangeArtifacts(path: string, range: DwellirGapRangeResult): Promise<void> {
  await writeAtomic(path, json(range));
}

export async function runDwellirFrontierGapRecovery(
  options: DwellirFrontierGapOptions = {},
): Promise<DwellirFrontierGapResult> {
  const progress = options.progress ?? (() => undefined);
  const gapStart = options.gapStart ?? DWELLIR_GAP_DEFAULT_START;
  const gapEnd = options.gapEnd ?? DWELLIR_GAP_DEFAULT_END;
  const logWindowBlocks = options.logWindowBlocks ?? DWELLIR_GAP_DEFAULT_LOG_WINDOW_BLOCKS;
  const totalSupply = unsignedDecimal(
    options.totalSupplyPlanck ?? EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
    'totalSupplyPlanck',
  );
  positiveInteger(gapStart, 'gap-start');
  positiveInteger(gapEnd, 'gap-end');
  if (gapStart > gapEnd || gapEnd > Number(MOONBEAM_FINAL_BLOCK_NUMBER)) {
    throw new FinalStateIdentityMismatchError('Frontier gap is outside the pinned final block.', {
      gapStart,
      gapEnd,
      finalBlockNumber: Number(MOONBEAM_FINAL_BLOCK_NUMBER),
    });
  }
  positiveInteger(logWindowBlocks, 'log-window-blocks');
  const storageConcurrency = options.storageConcurrency ?? DWELLIR_GAP_DEFAULT_STORAGE_CONCURRENCY;
  positiveInteger(storageConcurrency, 'storage-concurrency', 8);
  const workDirectory = resolve(options.work ?? DWELLIR_GAP_DEFAULT_WORK);
  const priorWork = resolve(options.priorWork ?? DWELLIR_GAP_DEFAULT_PRIOR_WORK);
  const checkpointPath = join(workDirectory, 'checkpoint.json');
  const contextPath = join(workDirectory, 'context.json');
  const candidatesPath = join(workDirectory, 'known-candidates.ndjson');
  const balancesPath = join(workDirectory, 'new-final-balances.ndjson');
  const rangesDirectory = join(workDirectory, 'ranges');
  const proofsDirectory = join(workDirectory, 'proofs');
  const summaryPath = join(workDirectory, 'summary.json');
  if (options.force) await rm(workDirectory, { recursive: true, force: true });
  await mkdir(workDirectory, { recursive: true });

  const transport =
    options.transport ??
    createDwellirCurlTransport({
      key: await resolveDwellirKey(options.key, options.keyFile),
      ...(options.endpointBase === undefined ? {} : { endpointBase: options.endpointBase }),
      timeoutMs: options.timeoutMs ?? DWELLIR_GAP_DEFAULT_TIMEOUT_MS,
      connectTimeoutMs: options.connectTimeoutMs ?? DWELLIR_GAP_DEFAULT_CONNECT_TIMEOUT_MS,
      retries: options.retries ?? DWELLIR_GAP_DEFAULT_RETRIES,
    });
  const preflight = await runPreflight(transport, gapEnd);
  const state = await loadState(options, workDirectory);
  const checkpoint = options.resume === false ? undefined : await loadCheckpoint(checkpointPath);
  const context: GapContext = {
    schemaVersion: 1,
    stage: 'dwellir-frontier-gap',
    finalBlockNumber: Number(MOONBEAM_FINAL_BLOCK_NUMBER),
    finalSubstrateBlockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    finalStateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
    finalEvmBlockHash: preflight.finalEvmBlockHash,
    contract: XC_DOT_XC20_ADDRESS,
    transferTopic0: TRANSFER_TOPIC0,
    totalSupplyPlanck: totalSupply.toString(10),
    gapStart,
    gapEnd,
    logWindowBlocks,
    baseCandidateCount: state.baseCandidates.size,
    baseCandidateDigest: candidateAddressesSha256(sortedAddresses(state.baseCandidates)),
    priorWork,
    preflight,
  };
  if (await pathExists(contextPath)) {
    const saved = JSON.parse(await readFile(contextPath, 'utf8')) as Partial<GapContext>;
    for (const field of [
      'finalBlockNumber',
      'finalSubstrateBlockHash',
      'finalStateRoot',
      'contract',
      'totalSupplyPlanck',
      'gapStart',
      'gapEnd',
      'logWindowBlocks',
    ] as const) {
      if (String(saved[field]).toLowerCase() !== String(context[field]).toLowerCase()) {
        throw new FinalStateIdentityMismatchError('Dwellir Frontier gap resume context differs.', {
          field,
          expected: String(context[field]),
          actual: String(saved[field]),
        });
      }
    }
  }
  await writeAtomic(contextPath, json(context));
  await mkdir(rangesDirectory, { recursive: true });
  await mkdir(proofsDirectory, { recursive: true });
  if (!(await pathExists(balancesPath))) await writeAtomic(balancesPath, '');
  await persistCandidates(candidatesPath, state.allKnownCandidates);
  await writeAtomic(
    join(workDirectory, 'candidate-addresses.sha256'),
    `${candidateAddressesSha256(sortedAddresses(state.allKnownCandidates))}\n`,
  );
  await writeAtomic(
    join(workDirectory, 'candidate-addresses.ndjson'),
    ndjson(sortedAddresses(state.allKnownCandidates).map((address) => ({ address }))),
  );

  progress(`DWELLIR_FRONTIER_GENESIS_HASH=${preflight.genesisHash}`);
  progress(`DWELLIR_FRONTIER_INDEXED_HEAD_HASH=${preflight.indexedHeadHash}`);
  progress(`DWELLIR_FRONTIER_INDEXED_HEAD_NUMBER=${preflight.indexedHeadNumber}`);
  progress(`REQUIRED_GAP_END=${gapEnd}`);
  progress(`FRONTIER_GAP_COVERAGE=${preflight.frontierGapCoverage}`);

  let currentCheckpoint = checkpoint ?? initialCheckpoint(totalSupply, state.committedSum, gapEnd);
  if (preflight.frontierGapCoverage === 'FAIL') {
    currentCheckpoint = { ...currentCheckpoint, status: 'DWELLIR_FRONTIER_INDEX_TOO_SHALLOW' };
    const summary = makeSummary(
      state,
      preflight,
      'DWELLIR_FRONTIER_INDEX_TOO_SHALLOW',
      currentCheckpoint,
      {
        gapStart,
        gapEnd,
        totalSupply,
        logWindowBlocks,
        priorWork,
      },
    );
    await writeAtomic(summaryPath, json(summary));
    await writeAtomic(checkpointPath, json(currentCheckpoint));
    return { workDirectory, summaryFile: summaryPath, summary };
  }

  const currentAllSum = state.baseOrPriorSum + sumBalances(state.gapBalances.values());
  if (currentAllSum > totalSupply) {
    throw new FinalStateSupplyOverflowError(
      'Dwellir Frontier gap known balances exceed total supply.',
      {
        knownSumPlanck: currentAllSum.toString(10),
        totalSupplyPlanck: totalSupply.toString(10),
      },
    );
  }
  if (currentAllSum === totalSupply) {
    const proofsCaptured = await ensureGapProofs(
      transport,
      state.gapBalances.values(),
      proofsDirectory,
    );
    currentCheckpoint = {
      ...currentCheckpoint,
      knownFinalSumPlanck: currentAllSum.toString(10),
      remainingDeficitPlanck: '0',
      proofsCaptured,
      status: 'SUPPLY_COMPLETE',
    };
    const summary = makeSummary(state, preflight, 'SUPPLY_COMPLETE', currentCheckpoint, {
      gapStart,
      gapEnd,
      totalSupply,
      logWindowBlocks,
      priorWork,
    });
    await writeAtomic(summaryPath, json(summary));
    await writeAtomic(checkpointPath, json(currentCheckpoint));
    return { workDirectory, summaryFile: summaryPath, summary };
  }

  let cursorEnd = checkpoint?.nextCursorEnd ?? gapEnd;
  if (cursorEnd < gapStart) {
    const proofsCaptured = await ensureGapProofs(
      transport,
      state.gapBalances.values(),
      proofsDirectory,
    );
    currentCheckpoint = { ...currentCheckpoint, proofsCaptured };
    const summary = makeSummary(
      state,
      preflight,
      'GAP_EXHAUSTED_WITH_SHORTFALL',
      currentCheckpoint,
      {
        gapStart,
        gapEnd,
        totalSupply,
        logWindowBlocks,
        priorWork,
      },
    );
    await writeAtomic(summaryPath, json(summary));
    return { workDirectory, summaryFile: summaryPath, summary };
  }

  let rangeNumber = currentCheckpoint.completedRanges;
  while (cursorEnd >= gapStart) {
    const blockStart = Math.max(gapStart, cursorEnd - logWindowBlocks + 1);
    const blockEnd = cursorEnd;
    progress(`RANGE=${rangeNumber + 1}`);
    progress(`BLOCK_RANGE=${blockStart}-${blockEnd}`);
    const scanned = await readLogs(transport, blockStart, blockEnd);
    const discovered = sortedAddresses(scanned.addresses);
    const newCandidates = discovered.filter((address) => !state.committedCandidates.has(address));
    const balanceRecords: FinalBalanceResult[] = [];
    for (let offset = 0; offset < newCandidates.length; offset += storageConcurrency) {
      const batch = newCandidates.slice(offset, offset + storageConcurrency);
      const settled = await Promise.allSettled(
        batch.map(async (address) => {
          const existing = state.gapBalances.get(address);
          if (existing !== undefined) return existing;
          return readFinalBalance(transport, address);
        }),
      );
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          mergeBalance(state.gapBalances, outcome.value, 'gap');
          balanceRecords.push(outcome.value);
        }
      }
      await persistBalances(balancesPath, state.gapBalances.values());
      const failure = settled.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      if (failure !== undefined) throw failure.reason;
    }
    for (const address of newCandidates) {
      const record = state.gapBalances.get(address);
      if (record === undefined) {
        throw new FinalStateIdentityMismatchError('Gap candidate has no durable final balance.', {
          address,
        });
      }
      if (!balanceRecords.some((item) => item.address === address)) balanceRecords.push(record);
    }
    const positive = balanceRecords.filter((record) => BigInt(record.balancePlanck) > 0n);
    const zero = balanceRecords.filter((record) => BigInt(record.balancePlanck) === 0n);
    for (const record of positive) {
      await captureBalanceReadProof(transport, record, proofsDirectory, true);
    }
    const newPositiveSum = sumBalances(positive);
    const knownSumBefore =
      state.baseOrPriorSum +
      sumBalances(
        [...state.gapBalances.values()].filter((record) =>
          state.committedCandidates.has(record.address),
        ),
      );
    const knownSumAfter = knownSumBefore + newPositiveSum;
    if (knownSumAfter > totalSupply) {
      throw new FinalStateSupplyOverflowError(
        'Dwellir Frontier gap balances exceed total supply.',
        {
          knownSumPlanck: knownSumAfter.toString(10),
          totalSupplyPlanck: totalSupply.toString(10),
        },
      );
    }
    const deficitBefore = totalSupply - knownSumBefore;
    const deficitAfter = totalSupply - knownSumAfter;
    if (deficitBefore - deficitAfter !== newPositiveSum) {
      throw new FinalStateIdentityMismatchError(
        'Gap deficit reduction does not match new positives.',
        {
          deficitBeforePlanck: deficitBefore.toString(10),
          deficitAfterPlanck: deficitAfter.toString(10),
          newPositiveSumPlanck: newPositiveSum.toString(10),
        },
      );
    }
    for (const address of newCandidates) {
      state.committedCandidates.add(address);
      state.allKnownCandidates.add(address);
    }
    state.committedSum = knownSumAfter;
    const totalProofs = await countProofFiles(proofsDirectory);
    rangeNumber += 1;
    const range: DwellirGapRangeResult = {
      range: rangeNumber,
      blockStart,
      blockEnd,
      blocks: blockEnd - blockStart + 1,
      transferLogs: scanned.logs,
      transferAddresses: scanned.transferAddresses,
      zeroAddressOccurrences: scanned.zeroAddressOccurrences,
      newCandidates: newCandidates.length,
      newPositive: positive.length,
      newZero: zero.length,
      newPositiveSumPlanck: newPositiveSum.toString(10),
      knownCandidateCountAfter: state.allKnownCandidates.size,
      knownPositiveCountAfter: positiveCount([
        ...state.baseBalances.values(),
        ...state.priorBalances.values(),
        ...state.gapBalances.values(),
      ]),
      knownFinalSumPlanckAfter: knownSumAfter.toString(10),
      remainingDeficitPlanckAfter: deficitAfter.toString(10),
      proofsCaptured: totalProofs,
    };
    await persistCandidates(candidatesPath, state.allKnownCandidates);
    await writeRangeArtifacts(
      join(rangesDirectory, `${String(rangeNumber).padStart(6, '0')}.json`),
      range,
    );
    const status: DwellirFrontierGapStatus =
      deficitAfter === 0n
        ? 'SUPPLY_COMPLETE'
        : blockStart === gapStart
          ? 'GAP_EXHAUSTED_WITH_SHORTFALL'
          : 'IN_PROGRESS';
    currentCheckpoint = {
      schemaVersion: 1,
      nextCursorEnd: blockStart - 1,
      completedRanges: rangeNumber,
      gapBlocksScanned: currentCheckpoint.gapBlocksScanned + range.blocks,
      transferLogsTotal: currentCheckpoint.transferLogsTotal + scanned.logs,
      transferAddressesTotal: currentCheckpoint.transferAddressesTotal + scanned.transferAddresses,
      zeroAddressOccurrences:
        currentCheckpoint.zeroAddressOccurrences + scanned.zeroAddressOccurrences,
      newCandidatesTotal: currentCheckpoint.newCandidatesTotal + newCandidates.length,
      newPositiveTotal: currentCheckpoint.newPositiveTotal + positive.length,
      newZeroTotal: currentCheckpoint.newZeroTotal + zero.length,
      newPositiveSumPlanck: (
        BigInt(currentCheckpoint.newPositiveSumPlanck) + newPositiveSum
      ).toString(10),
      knownFinalSumPlanck: knownSumAfter.toString(10),
      remainingDeficitPlanck: deficitAfter.toString(10),
      proofsCaptured: totalProofs,
      ...(status === 'IN_PROGRESS' ? {} : { status }),
    };
    const summary = makeSummary(state, preflight, status, currentCheckpoint, {
      gapStart,
      gapEnd,
      totalSupply,
      logWindowBlocks,
      priorWork,
    });
    await writeAtomic(summaryPath, json(summary));
    await writeAtomic(checkpointPath, json(currentCheckpoint));
    progress(`TRANSFER_LOGS=${scanned.logs}`);
    progress(`TRANSFER_ADDRESSES=${scanned.transferAddresses}`);
    progress(`NEW_CANDIDATES=${newCandidates.length}`);
    progress(`NEW_POSITIVE=${positive.length}`);
    progress(`NEW_ZERO=${zero.length}`);
    progress(`NEW_POSITIVE_SUM_PLANCK=${newPositiveSum.toString(10)}`);
    progress(`FINAL_KNOWN_SUM_PLANCK=${knownSumAfter.toString(10)}`);
    progress(`REMAINING_DEFICIT_PLANCK=${deficitAfter.toString(10)}`);
    progress(`PROOFS_CAPTURED=${totalProofs}`);
    progress(`PROOF_VERIFICATION=NOT_RUN`);
    if (status !== 'IN_PROGRESS') return { workDirectory, summaryFile: summaryPath, summary };
    cursorEnd = blockStart - 1;
  }
  const summary = makeSummary(state, preflight, 'GAP_EXHAUSTED_WITH_SHORTFALL', currentCheckpoint, {
    gapStart,
    gapEnd,
    totalSupply,
    logWindowBlocks,
    priorWork,
  });
  await writeAtomic(summaryPath, json(summary));
  return { workDirectory, summaryFile: summaryPath, summary };
}
