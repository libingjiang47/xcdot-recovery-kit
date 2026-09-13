import { access, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  EXPECTED_BASE_CANDIDATE_FINAL_SUM_PLANCK,
  EXPECTED_MOONSCAN_ONLY_COUNT,
  EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
  EXPECTED_SUBSCAN_CANDIDATE_COUNT,
} from '../final-state/constants.js';
import { XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import { parseMoonscanHolderCsv } from '../candidates/moonscan.js';
import { buildCandidateUniverse } from '../candidates/candidate-universe.js';
import { discoverCandidateAddresses, candidateAddressesSha256 } from '../subscan/candidates.js';
import { compareCanonicalStrings } from '../utils/order.js';
import {
  FinalStateBalanceConflictError,
  FinalStateBalanceCacheConflictError,
  FinalStateIdentityMismatchError,
  FinalStateResumeContextMismatchError,
  FinalStateStorageBackendUnsupportedError,
  FinalStateSupplyOverflowError,
} from '../utils/errors.js';
import {
  createDwellirCurlTransport,
  resolveDwellirKey,
  type DwellirRpcTransport,
} from '../storage/dwellir-final-state-recovery.js';
import {
  deriveBalanceAccountStoragesKeyDirect,
  deriveTotalSupplyAccountStoragesKeyDirect,
} from '../storage/substrate-evm.js';
import { decodeU256Storage } from '../storage/solidity.js';
import { loadFinalBalanceCache } from '../storage/final-balance-cache.js';
import { parseSqdJsonl, type ParsedSqdStream } from './xcdot-transfer-candidates.js';
import {
  SQD_DATASET,
  SQD_ENDPOINT,
  SqdNoContentError,
  type SqdRangeClient,
  createSqdCurlTransport,
} from './client.js';

export const BACKWARD_DEFAULT_WINDOW_BLOCKS = 100_000 as const;
export const BACKWARD_DEFAULT_MAX_UNPRODUCTIVE_WINDOWS = 20 as const;
/** @deprecated Accepted by older callers for compatibility; it no longer controls stopping. */
export const BACKWARD_DEFAULT_MAX_EMPTY_WINDOWS = 10 as const;
export const BACKWARD_DEFAULT_CONNECT_TIMEOUT_MS = 120_000 as const;
export const BACKWARD_DEFAULT_TIMEOUT_MS = 300_000 as const;
export const BACKWARD_DEFAULT_STORAGE_CONCURRENCY = 2 as const;
export const BACKWARD_DEFAULT_WORK = 'diagnostics/sqd-backward-recovery' as const;
export const BACKWARD_DEFAULT_BASE_WORK =
  'diagnostics/dwellir-final-state-recovery-work/moonbeam-16796696' as const;

export type BackwardRecoveryStatus =
  | 'IN_PROGRESS'
  | 'SUPPLY_COMPLETE'
  | 'BACKWARD_DISCOVERY_STALLED'
  | 'REACHED_GENESIS_WITH_SHORTFALL';

export interface BackwardWindow {
  blockStart: number;
  blockEnd: number;
  nextCursorEnd: number;
}

export interface FinalBalanceResult {
  address: string;
  substrateStorageKey: string;
  rawValue: string | null;
  balancePlanck: string;
}

export interface BackwardRoundResult {
  round: number;
  blockStart: number;
  blockEnd: number;
  transferLogCount: number;
  transferAddressCount: number;
  newCandidateCount: number;
  newPositiveCount: number;
  newZeroCount: number;
  newPositiveSumPlanck: string;
  productive: boolean;
  deficitBeforePlanck: string;
  deficitReductionPlanck: string;
  deficitAfterPlanck: string;
  knownCandidateCountAfter: number;
  knownPositiveCountAfter: number;
  knownFinalSumPlanckAfter: string;
  remainingDeficitPlanckAfter: string;
  consecutiveNoNewCandidateWindowsAfter: number;
  consecutiveUnproductiveWindowsAfter: number;
  proofsCaptured: number;
}

export interface BackwardRecoveryCheckpoint {
  schemaVersion: 2;
  nextCursorEnd: number;
  completedRounds: number;
  consecutiveNoNewCandidateWindows: number;
  consecutiveUnproductiveWindows: number;
  knownCandidateCount: number;
  knownPositiveCount: number;
  knownFinalSumPlanck: string;
  remainingDeficitPlanck: string;
  newCandidateCountTotal: number;
  newPositiveCountTotal: number;
  newZeroCountTotal: number;
  proofsCaptured: number;
  status?: BackwardRecoveryStatus;
}

export interface BackwardRecoverySummary {
  schemaVersion: 1;
  status: BackwardRecoveryStatus;
  windowBlocks: number;
  maxUnproductiveWindows: number;
  baseCandidateCount: number;
  baseCandidateDigest: string;
  baseFinalSumPlanck: string;
  rounds: number;
  oldestScannedBlock: number | null;
  newestScannedBlock: number | null;
  sqdFinalizedHead: number | null;
  sqdCoverageGapStart: number | null;
  sqdCoverageGapEnd: number | null;
  sqdCoverageGapBlocks: number;
  consecutiveNoNewCandidateWindows: number;
  consecutiveUnproductiveWindows: number;
  newCandidateCount: number;
  newPositiveCount: number;
  newZeroCount: number;
  newPositiveSumPlanck: string;
  finalKnownCandidateCount: number;
  finalKnownPositiveCount: number;
  finalKnownSumPlanck: string;
  totalSupplyPlanck: string;
  remainingDeficitPlanck: string;
  proofsCaptured: number;
  proofVerification: 'NOT_RUN';
  stallReason?: 'NO_FINAL_POSITIVE_PROGRESS';
  nextPriority?: 'SQD_COVERAGE_GAP';
}

export interface BackwardRecoveryResult {
  workDirectory: string;
  summaryFile: string;
  summary: BackwardRecoverySummary;
}

export interface BackwardRecoveryOptions {
  dataset?: string;
  moonscanCsv?: string;
  key?: string;
  keyFile?: string;
  endpointBase?: string;
  sqdEndpoint?: string;
  windowBlocks?: number;
  maxUnproductiveWindows?: number;
  /** @deprecated Accepted for compatibility but ignored for stopping decisions. */
  maxEmptyWindows?: number;
  connectTimeoutMs?: number;
  timeoutMs?: number;
  storageConcurrency?: number;
  resume?: boolean;
  force?: boolean;
  captureProof?: boolean;
  work?: string;
  baseWork?: string;
  transport?: DwellirRpcTransport;
  sqdClient?: SqdRangeClient;
  progress?: (message: string) => void;
  // Narrow dependency seams keep the state machine unit-testable without changing the CLI.
  baseCandidates?: readonly string[];
  baseBalances?: readonly FinalBalanceResult[];
  totalSupplyPlanck?: string;
}

interface WindowScanResult {
  transferLogCount: number;
  transferAddressCount: number;
  addresses: Set<string>;
  availableHead?: number;
}

interface LoadedBaseState {
  candidates: Set<string>;
  balances: Map<string, FinalBalanceResult>;
  candidateDigest: string;
  sum: bigint;
  positiveCount: number;
}

interface SqdCoverageObservation {
  finalizedHead: number | null;
  gapStart: number | null;
  gapEnd: number | null;
  gapBlocks: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHex(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    return false;
  }
  return bytes === undefined || value.length === 2 + bytes * 2;
}

function canonicalAddress(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new FinalStateIdentityMismatchError(`${label} is not a canonical H160 address.`, {
      value: String(value),
    });
  }
  return value.toLowerCase();
}

function normalizeRawValue(value: unknown, label: string): string | null {
  if (value === null || value === '0x') return null;
  if (!isHex(value, 32)) {
    throw new FinalStateStorageBackendUnsupportedError(`${label} is not a 32-byte U256 word.`, {
      value: String(value).slice(0, 160),
    });
  }
  return value.toLowerCase();
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, json(value));
}

function validatePositive(value: number, label: string, maximum?: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    throw new FinalStateIdentityMismatchError(`${label} is outside the supported range.`, {
      [label]: value,
      ...(maximum === undefined ? {} : { maximum }),
    });
  }
}

export function calculateBackwardWindow(cursorEnd: number, windowBlocks: number): BackwardWindow {
  validatePositive(cursorEnd + 1, 'cursorEnd');
  validatePositive(windowBlocks, 'windowBlocks');
  const blockStart = Math.max(0, cursorEnd - windowBlocks + 1);
  return { blockStart, blockEnd: cursorEnd, nextCursorEnd: blockStart - 1 };
}

export function selectNewCandidates(
  roundAddresses: Iterable<string>,
  knownCandidates: ReadonlySet<string>,
): string[] {
  return [...new Set([...roundAddresses].map((address) => address.toLowerCase()))]
    .filter((address) => !knownCandidates.has(address))
    .sort(compareCanonicalStrings);
}

export function classifyFinalBalances(results: readonly FinalBalanceResult[]): {
  positive: FinalBalanceResult[];
  zero: FinalBalanceResult[];
  positiveSum: bigint;
} {
  const positive = results.filter((result) => BigInt(result.balancePlanck) > 0n);
  const zero = results.filter((result) => BigInt(result.balancePlanck) === 0n);
  return {
    positive,
    zero,
    positiveSum: positive.reduce((sum, result) => sum + BigInt(result.balancePlanck), 0n),
  };
}

export interface BackwardProgressCounters {
  consecutiveNoNewCandidateWindows: number;
  consecutiveUnproductiveWindows: number;
  productive: boolean;
}

export function updateBackwardProgressCounters(
  counters: Omit<BackwardProgressCounters, 'productive'>,
  newCandidateCount: number,
  newPositiveSumPlanck: bigint,
): BackwardProgressCounters {
  const productive = newPositiveSumPlanck > 0n;
  return {
    productive,
    consecutiveNoNewCandidateWindows:
      newCandidateCount === 0 ? counters.consecutiveNoNewCandidateWindows + 1 : 0,
    consecutiveUnproductiveWindows: productive ? 0 : counters.consecutiveUnproductiveWindows + 1,
  };
}

async function loadCacheValues(
  baseWork: string,
  expectedBlockHash: string,
): Promise<Map<string, string | null>> {
  const values = new Map<string, string | null>();
  const merge = (key: string, value: string | null, source: string) => {
    const previous = values.get(key);
    if (values.has(key) && previous !== value) {
      throw new FinalStateBalanceCacheConflictError(
        'Backward recovery cache contains conflicting storage values.',
        { key, source },
      );
    }
    values.set(key, value);
  };
  const directories = [join(baseWork, 'storage-batches')];
  const extensions = join(baseWork, 'extensions');
  if (await pathExists(extensions)) {
    for (const entry of await readdir(extensions, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(extensions, entry.name, 'storage-batches'));
    }
  }
  let loaded = false;
  for (const directory of directories) {
    if (!(await pathExists(join(directory, 'batch-000000.json')))) continue;
    const cache = await loadFinalBalanceCache(directory, expectedBlockHash);
    for (const [key, value] of cache.values) merge(key, value, directory);
    loaded = true;
  }
  if (!loaded) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Backward recovery found no pinned final-state balance cache.',
      { baseWork },
    );
  }
  return values;
}

function balanceRecord(
  address: string,
  rawValue: string | null,
  substrateStorageKey: string,
): FinalBalanceResult {
  return {
    address,
    substrateStorageKey,
    rawValue,
    balancePlanck: decodeU256Storage(rawValue).toString(10),
  };
}

async function loadBaseState(options: BackwardRecoveryOptions): Promise<LoadedBaseState> {
  let candidates: string[];
  const balances = new Map<string, FinalBalanceResult>();
  if (options.baseCandidates !== undefined && options.baseBalances !== undefined) {
    candidates = [
      ...new Set(
        options.baseCandidates.map((address) => canonicalAddress(address, 'base candidate')),
      ),
    ].sort(compareCanonicalStrings);
    for (const item of options.baseBalances) {
      const address = canonicalAddress(item.address, 'base balance');
      if (balances.has(address)) {
        throw new FinalStateBalanceCacheConflictError(
          'Base balance cache contains a duplicate address.',
          {
            address,
          },
        );
      }
      balances.set(address, {
        ...item,
        address,
        balancePlanck: decodeU256Storage(item.rawValue).toString(10),
      });
    }
  } else {
    const subscan = await discoverCandidateAddresses(options.dataset ?? 'snapshots/subscan');
    if (options.moonscanCsv === undefined) {
      throw new FinalStateIdentityMismatchError(
        '--moonscan-csv is required for backward recovery.',
      );
    }
    const moonscan = await parseMoonscanHolderCsv(resolve(options.moonscanCsv));
    const universe = buildCandidateUniverse(subscan, moonscan, 'moonscan');
    candidates = universe.addresses;
    const cacheValues = await loadCacheValues(
      resolve(options.baseWork ?? BACKWARD_DEFAULT_BASE_WORK),
      MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    );
    for (const address of candidates) {
      const key = deriveBalanceAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, address, 0n);
      if (!cacheValues.has(key.substrateStorageKey)) {
        throw new FinalStateIdentityMismatchError(
          'Existing final-state cache is missing a base candidate balance.',
          { address, substrateStorageKey: key.substrateStorageKey },
        );
      }
      balances.set(
        address,
        balanceRecord(
          address,
          cacheValues.get(key.substrateStorageKey) ?? null,
          key.substrateStorageKey,
        ),
      );
    }
    // The base cache must also contain the independently checked total supply slot (slot 2).
    const totalSupplyKey = deriveTotalSupplyAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, 2n);
    if (!cacheValues.has(totalSupplyKey.substrateStorageKey)) {
      throw new FinalStateIdentityMismatchError(
        'Existing final-state cache is missing total supply.',
        {
          substrateStorageKey: totalSupplyKey.substrateStorageKey,
        },
      );
    }
    const cachedSupply = decodeU256Storage(
      cacheValues.get(totalSupplyKey.substrateStorageKey) ?? null,
    );
    const expected = BigInt(options.totalSupplyPlanck ?? EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK);
    if (cachedSupply !== expected) {
      throw new FinalStateIdentityMismatchError(
        'Cached total supply does not match pinned xcDOT supply.',
        {
          expected: expected.toString(10),
          actual: cachedSupply.toString(10),
        },
      );
    }
  }
  const candidateSet = new Set(candidates);
  const candidateDigest = candidateAddressesSha256(candidates);
  if (
    options.baseCandidates === undefined &&
    candidateSet.size !== EXPECTED_SUBSCAN_CANDIDATE_COUNT + EXPECTED_MOONSCAN_ONLY_COUNT
  ) {
    throw new FinalStateIdentityMismatchError(
      'Subscan and Moonscan base candidate count is unexpected.',
      {
        expected: EXPECTED_SUBSCAN_CANDIDATE_COUNT + EXPECTED_MOONSCAN_ONLY_COUNT,
        actual: candidateSet.size,
      },
    );
  }
  if (balances.size !== candidateSet.size) {
    throw new FinalStateIdentityMismatchError(
      'Base final-state cache does not cover every candidate.',
      {
        candidates: candidateSet.size,
        balances: balances.size,
      },
    );
  }
  let sum = 0n;
  let positiveCount = 0;
  for (const address of candidates) {
    const balance = balances.get(address);
    if (balance === undefined) throw new Error(`missing base balance ${address}`);
    const value = BigInt(balance.balancePlanck);
    sum += value;
    if (value > 0n) positiveCount += 1;
  }
  const expectedSum = BigInt(
    options.baseCandidates === undefined
      ? EXPECTED_BASE_CANDIDATE_FINAL_SUM_PLANCK
      : sum.toString(10),
  );
  if (options.baseCandidates === undefined && sum !== expectedSum) {
    throw new FinalStateIdentityMismatchError(
      'Base final-state cache sum does not match frozen baseline.',
      {
        expected: expectedSum.toString(10),
        actual: sum.toString(10),
      },
    );
  }
  return { candidates: candidateSet, balances, candidateDigest, sum, positiveCount };
}

async function loadAddressFile(path: string): Promise<Set<string>> {
  if (!(await pathExists(path))) return new Set<string>();
  const result = new Set<string>();
  for (const [index, line] of (await readFile(path, 'utf8')).split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new FinalStateIdentityMismatchError('Backward candidate cache contains invalid JSON.', {
        path,
        line: index + 1,
      });
    }
    if (!isObject(value))
      throw new FinalStateIdentityMismatchError('Backward candidate cache line is invalid.', {
        path,
        line: index + 1,
      });
    result.add(canonicalAddress(value.address, 'backward candidate cache'));
  }
  return result;
}

async function loadBalanceFile(path: string): Promise<Map<string, FinalBalanceResult>> {
  if (!(await pathExists(path))) return new Map();
  const result = new Map<string, FinalBalanceResult>();
  for (const [index, line] of (await readFile(path, 'utf8')).split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new FinalStateIdentityMismatchError('Backward balance cache contains invalid JSON.', {
        path,
        line: index + 1,
      });
    }
    if (!isObject(value))
      throw new FinalStateIdentityMismatchError('Backward balance cache line is invalid.', {
        path,
        line: index + 1,
      });
    const address = canonicalAddress(value.address, 'backward balance cache');
    const rawValue = normalizeRawValue(value.rawValue, 'backward balance rawValue');
    const key =
      typeof value.substrateStorageKey === 'string' ? value.substrateStorageKey.toLowerCase() : '';
    if (!isHex(key) || key.length <= 2)
      throw new FinalStateIdentityMismatchError('Backward balance cache storage key is invalid.', {
        path,
        line: index + 1,
      });
    const balancePlanck = decodeU256Storage(rawValue).toString(10);
    if (value.balancePlanck !== balancePlanck)
      throw new FinalStateIdentityMismatchError(
        'Backward balance cache balance does not match raw value.',
        { path, line: index + 1 },
      );
    const record = { address, substrateStorageKey: key, rawValue, balancePlanck };
    const previous = result.get(address);
    if (
      previous !== undefined &&
      (previous.balancePlanck !== balancePlanck ||
        previous.rawValue !== rawValue ||
        previous.substrateStorageKey !== key)
    ) {
      throw new FinalStateBalanceConflictError(
        'Backward balance cache contains conflicting records for one address.',
        { address },
      );
    }
    result.set(address, record);
  }
  return result;
}

interface ParsedCheckpoint {
  checkpoint: BackwardRecoveryCheckpoint;
  migratedFromSchemaVersion: 1 | 2;
}

function parseCheckpoint(value: unknown, path: string): ParsedCheckpoint {
  if (!isObject(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new FinalStateIdentityMismatchError('Backward checkpoint schema is invalid.', { path });
  }
  const legacy = value.schemaVersion === 1;
  const numeric = [
    'nextCursorEnd',
    'completedRounds',
    ...(legacy ? ['consecutiveEmptyWindows'] : []),
    ...(!legacy ? ['consecutiveNoNewCandidateWindows', 'consecutiveUnproductiveWindows'] : []),
    'knownCandidateCount',
    'knownPositiveCount',
    'newCandidateCountTotal',
    'newPositiveCountTotal',
    'newZeroCountTotal',
    'proofsCaptured',
  ] as const;
  for (const field of numeric) {
    const item = value[field];
    if (
      !Number.isSafeInteger(item) ||
      (field !== 'nextCursorEnd' && (item as number) < 0) ||
      (field === 'nextCursorEnd' && (item as number) < -1)
    ) {
      throw new FinalStateIdentityMismatchError(
        'Backward checkpoint contains an invalid counter.',
        { path, field },
      );
    }
  }
  if (
    typeof value.knownFinalSumPlanck !== 'string' ||
    typeof value.remainingDeficitPlanck !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.knownFinalSumPlanck) ||
    !/^(0|[1-9][0-9]*)$/.test(value.remainingDeficitPlanck)
  ) {
    throw new FinalStateIdentityMismatchError(
      'Backward checkpoint lacks decimal supply counters.',
      { path },
    );
  }
  return {
    migratedFromSchemaVersion: value.schemaVersion,
    checkpoint: {
      schemaVersion: 2,
      nextCursorEnd: value.nextCursorEnd as number,
      completedRounds: value.completedRounds as number,
      consecutiveNoNewCandidateWindows: legacy
        ? 0
        : (value.consecutiveNoNewCandidateWindows as number),
      consecutiveUnproductiveWindows: legacy ? 0 : (value.consecutiveUnproductiveWindows as number),
      knownCandidateCount: value.knownCandidateCount as number,
      knownPositiveCount: value.knownPositiveCount as number,
      knownFinalSumPlanck: value.knownFinalSumPlanck,
      remainingDeficitPlanck: value.remainingDeficitPlanck,
      newCandidateCountTotal: value.newCandidateCountTotal as number,
      newPositiveCountTotal: value.newPositiveCountTotal as number,
      newZeroCountTotal: value.newZeroCountTotal as number,
      proofsCaptured: value.proofsCaptured as number,
      ...(typeof value.status === 'string'
        ? { status: value.status as BackwardRecoveryStatus }
        : {}),
    },
  };
}

interface RebuiltCounters {
  consecutiveNoNewCandidateWindows: number;
  consecutiveUnproductiveWindows: number;
}

async function rebuildCountersFromRounds(
  roundsDirectory: string,
  completedRounds: number,
  checkpointPath: string,
): Promise<RebuiltCounters> {
  const rounds: Array<{ newCandidateCount: number; newPositiveSumPlanck: bigint }> = [];
  for (let round = 1; round <= completedRounds; round += 1) {
    const path = join(roundsDirectory, `${String(round).padStart(6, '0')}.json`);
    if (!(await pathExists(path))) {
      throw new FinalStateResumeContextMismatchError(
        'Backward checkpoint migration is missing a completed round result.',
        { checkpointPath, round, path },
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
      throw new FinalStateResumeContextMismatchError(
        'Backward checkpoint migration found invalid round JSON.',
        { checkpointPath, round, path },
      );
    }
    if (
      !isObject(value) ||
      !Number.isSafeInteger(value.newCandidateCount) ||
      (value.newCandidateCount as number) < 0 ||
      typeof value.newPositiveSumPlanck !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(value.newPositiveSumPlanck)
    ) {
      throw new FinalStateResumeContextMismatchError(
        'Backward checkpoint migration found an invalid round counter.',
        { checkpointPath, round, path },
      );
    }
    rounds.push({
      newCandidateCount: value.newCandidateCount as number,
      newPositiveSumPlanck: BigInt(value.newPositiveSumPlanck),
    });
  }

  let consecutiveNoNewCandidateWindows = 0;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index];
    if (round === undefined || round.newCandidateCount !== 0) break;
    consecutiveNoNewCandidateWindows += 1;
  }
  let consecutiveUnproductiveWindows = 0;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index];
    if (round === undefined || round.newPositiveSumPlanck !== 0n) break;
    consecutiveUnproductiveWindows += 1;
  }
  return { consecutiveNoNewCandidateWindows, consecutiveUnproductiveWindows };
}

const LEGACY_ROUND_FIELDS = [
  'round',
  'blockStart',
  'blockEnd',
  'transferLogCount',
  'transferAddressCount',
  'newCandidateCount',
  'newPositiveCount',
  'newZeroCount',
  'newPositiveSumPlanck',
  'knownCandidateCountAfter',
  'knownPositiveCountAfter',
  'knownFinalSumPlanckAfter',
  'remainingDeficitPlanckAfter',
  'proofsCaptured',
] as const;

function matchesExistingRound(existing: string, expected: BackwardRoundResult): boolean {
  if (existing === json(expected)) return true;
  try {
    const value = JSON.parse(existing) as unknown;
    return (
      isObject(value) && LEGACY_ROUND_FIELDS.every((field) => value[field] === expected[field])
    );
  } catch {
    return false;
  }
}

async function scanBackwardWindow(
  client: SqdRangeClient,
  blockStart: number,
  blockEnd: number,
): Promise<WindowScanResult> {
  let cursor = blockStart;
  let transferLogCount = 0;
  const addresses = new Set<string>();
  while (cursor <= blockEnd) {
    let response: string;
    try {
      response = await client.fetchRange(cursor, blockEnd);
    } catch (error) {
      if (error instanceof SqdNoContentError && error.availableHead !== undefined) {
        return {
          transferLogCount,
          transferAddressCount: addresses.size,
          addresses,
          availableHead: error.availableHead,
        };
      }
      throw error;
    }
    const parsed: ParsedSqdStream = parseSqdJsonl(response);
    if (parsed.lastReturnedBlock < cursor) {
      throw new FinalStateIdentityMismatchError('SQD backward scan made no local progress.', {
        cursor,
        lastReturnedBlock: parsed.lastReturnedBlock,
      });
    }
    if (parsed.lastReturnedBlock > blockEnd) {
      throw new FinalStateIdentityMismatchError('SQD backward response exceeded its window.', {
        blockEnd,
        lastReturnedBlock: parsed.lastReturnedBlock,
      });
    }
    transferLogCount += parsed.transferLogCount;
    for (const address of parsed.addresses) addresses.add(address);
    cursor = parsed.lastReturnedBlock + 1;
  }
  return { transferLogCount, transferAddressCount: addresses.size, addresses };
}

async function readFinalBalance(
  transport: DwellirRpcTransport,
  address: string,
): Promise<FinalBalanceResult> {
  const key = deriveBalanceAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, address, 0n);
  const rawValue = normalizeRawValue(
    await transport.call('state_getStorage', [
      key.substrateStorageKey,
      MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    ]),
    'Dwellir balance result',
  );
  return balanceRecord(address, rawValue, key.substrateStorageKey);
}

async function processBalances(
  transport: DwellirRpcTransport,
  addresses: readonly string[],
  balances: Map<string, FinalBalanceResult>,
  concurrency: number,
  persist: () => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < addresses.length; offset += concurrency) {
    const chunk = addresses.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(
      chunk
        .filter((address) => !balances.has(address))
        .map((address) => readFinalBalance(transport, address)),
    );
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') balances.set(outcome.value.address, outcome.value);
    }
    await persist();
    const failure = settled.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    if (failure !== undefined) throw failure.reason;
  }
}

function proofPath(proofsDirectory: string, address: string): string {
  return join(proofsDirectory, `${address}.json`);
}

async function captureBalanceReadProof(
  transport: DwellirRpcTransport,
  result: FinalBalanceResult,
  proofsDirectory: string,
  capture: boolean,
): Promise<boolean> {
  if (!capture || BigInt(result.balancePlanck) === 0n) return false;
  const path = proofPath(proofsDirectory, result.address);
  if (await pathExists(path)) {
    const existing = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (
      existing.address !== result.address ||
      existing.blockHash !== MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH ||
      existing.substrateStorageKey !== result.substrateStorageKey ||
      existing.balancePlanck !== result.balancePlanck
    ) {
      throw new FinalStateIdentityMismatchError('Existing backward proof context differs.', {
        address: result.address,
      });
    }
    return true;
  }
  const value = await transport.call('state_getReadProof', [
    [result.substrateStorageKey],
    MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  ]);
  if (
    !isObject(value) ||
    value.at !== MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH ||
    !Array.isArray(value.proof) ||
    value.proof.length === 0 ||
    !value.proof.every((node) => isHex(node) && node.length > 2)
  ) {
    throw new FinalStateIdentityMismatchError('Dwellir returned a malformed read proof.', {
      address: result.address,
    });
  }
  await writeJson(path, {
    schemaVersion: 1,
    address: result.address,
    blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
    substrateStorageKey: result.substrateStorageKey,
    balancePlanck: result.balancePlanck,
    proof: value.proof,
  });
  return true;
}

async function countProofs(
  proofsDirectory: string,
  balances: Iterable<FinalBalanceResult>,
): Promise<number> {
  let count = 0;
  for (const result of balances) {
    if (
      BigInt(result.balancePlanck) > 0n &&
      (await pathExists(proofPath(proofsDirectory, result.address)))
    )
      count += 1;
  }
  return count;
}

async function persistBalances(
  path: string,
  balances: Map<string, FinalBalanceResult>,
): Promise<void> {
  const records = [...balances.values()].sort((left, right) =>
    compareCanonicalStrings(left.address, right.address),
  );
  await writeAtomic(path, ndjson(records));
}

async function persistCandidates(path: string, candidates: ReadonlySet<string>): Promise<void> {
  const records = [...candidates].sort(compareCanonicalStrings).map((address) => ({ address }));
  await writeAtomic(path, ndjson(records));
}

function aggregateSummary(
  base: LoadedBaseState,
  balances: Map<string, FinalBalanceResult>,
  committedCandidates: ReadonlySet<string>,
  checkpoint: BackwardRecoveryCheckpoint | undefined,
  totalSupply: bigint,
  windowBlocks: number,
  maxUnproductiveWindows: number,
  status: BackwardRecoveryStatus,
  newestScannedBlock: number | null,
  oldestScannedBlock: number | null,
  coverage: SqdCoverageObservation,
  proofsCaptured: number,
): BackwardRecoverySummary {
  let newPositiveCount = 0;
  let newZeroCount = 0;
  let newPositiveSum = 0n;
  for (const [address, result] of balances) {
    if (base.candidates.has(address)) continue;
    const value = BigInt(result.balancePlanck);
    if (value > 0n) {
      newPositiveCount += 1;
      newPositiveSum += value;
    } else newZeroCount += 1;
  }
  const knownSum = base.sum + newPositiveSum;
  const summary: BackwardRecoverySummary = {
    schemaVersion: 1,
    status,
    windowBlocks,
    maxUnproductiveWindows,
    baseCandidateCount: base.candidates.size,
    baseCandidateDigest: base.candidateDigest,
    baseFinalSumPlanck: base.sum.toString(10),
    rounds: checkpoint?.completedRounds ?? 0,
    oldestScannedBlock,
    newestScannedBlock,
    sqdFinalizedHead: coverage.finalizedHead,
    sqdCoverageGapStart: coverage.gapStart,
    sqdCoverageGapEnd: coverage.gapEnd,
    sqdCoverageGapBlocks: coverage.gapBlocks,
    consecutiveNoNewCandidateWindows: checkpoint?.consecutiveNoNewCandidateWindows ?? 0,
    consecutiveUnproductiveWindows: checkpoint?.consecutiveUnproductiveWindows ?? 0,
    newCandidateCount: newPositiveCount + newZeroCount,
    newPositiveCount,
    newZeroCount,
    newPositiveSumPlanck: newPositiveSum.toString(10),
    finalKnownCandidateCount: committedCandidates.size,
    finalKnownPositiveCount: base.positiveCount + newPositiveCount,
    finalKnownSumPlanck: knownSum.toString(10),
    totalSupplyPlanck: totalSupply.toString(10),
    remainingDeficitPlanck: (totalSupply - knownSum).toString(10),
    proofsCaptured,
    proofVerification: 'NOT_RUN',
  };
  if (status === 'BACKWARD_DISCOVERY_STALLED') {
    summary.stallReason = 'NO_FINAL_POSITIVE_PROGRESS';
    if (coverage.gapBlocks > 0) summary.nextPriority = 'SQD_COVERAGE_GAP';
  }
  return summary;
}

export async function runSqdBackwardRecovery(
  options: BackwardRecoveryOptions = {},
): Promise<BackwardRecoveryResult> {
  const windowBlocks = options.windowBlocks ?? BACKWARD_DEFAULT_WINDOW_BLOCKS;
  const maxUnproductiveWindows =
    options.maxUnproductiveWindows ?? BACKWARD_DEFAULT_MAX_UNPRODUCTIVE_WINDOWS;
  const connectTimeoutMs = options.connectTimeoutMs ?? BACKWARD_DEFAULT_CONNECT_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? BACKWARD_DEFAULT_TIMEOUT_MS;
  const storageConcurrency = options.storageConcurrency ?? BACKWARD_DEFAULT_STORAGE_CONCURRENCY;
  const resume = options.resume ?? true;
  const captureProof = options.captureProof ?? true;
  validatePositive(windowBlocks, 'windowBlocks');
  validatePositive(maxUnproductiveWindows, 'maxUnproductiveWindows');
  validatePositive(connectTimeoutMs, 'connectTimeoutMs');
  validatePositive(timeoutMs, 'timeoutMs');
  validatePositive(storageConcurrency, 'storageConcurrency', 8);
  if (connectTimeoutMs > timeoutMs) {
    throw new FinalStateIdentityMismatchError('connectTimeoutMs must not exceed timeoutMs.', {
      connectTimeoutMs,
      timeoutMs,
    });
  }
  const workDirectory = resolve(options.work ?? BACKWARD_DEFAULT_WORK);
  const base = await loadBaseState(options);
  const totalSupply = BigInt(options.totalSupplyPlanck ?? EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK);
  const staticContext = {
    schemaVersion: 1,
    finalBlockNumber: Number(MOONBEAM_FINAL_BLOCK_NUMBER),
    finalBlockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
    contract: XC_DOT_XC20_ADDRESS,
    balancesSlot: '0',
    totalSupplyPlanck: totalSupply.toString(10),
    sqdDataset: SQD_DATASET,
    sqdEndpoint: options.sqdEndpoint ?? SQD_ENDPOINT,
    windowBlocks,
    maxUnproductiveWindows,
    baseCandidateDigest: base.candidateDigest,
    baseCandidateCount: base.candidates.size,
  };
  let sqdFinalizedHead: number | null = null;
  let sqdCoverageGapStart: number | null = null;
  let sqdCoverageGapEnd: number | null = null;
  let sqdCoverageGapBlocks = 0;
  let context: typeof staticContext & {
    sqdFinalizedHead: number | null;
    sqdCoverageGapStart: number | null;
    sqdCoverageGapEnd: number | null;
    sqdCoverageGapBlocks: number;
  } = {
    ...staticContext,
    sqdFinalizedHead,
    sqdCoverageGapStart,
    sqdCoverageGapEnd,
    sqdCoverageGapBlocks,
  };
  const contextFile = join(workDirectory, 'context.json');
  const checkpointFile = join(workDirectory, 'checkpoint.json');
  const candidatesFile = join(workDirectory, 'known-candidates.ndjson');
  const balancesFile = join(workDirectory, 'new-final-balances.ndjson');
  const roundsDirectory = join(workDirectory, 'rounds');
  const proofsDirectory = join(workDirectory, 'proofs');
  const summaryFile = join(workDirectory, 'summary.json');

  if (options.force || !resume) await rm(workDirectory, { recursive: true, force: true });
  await mkdir(workDirectory, { recursive: true });
  if (resume && (await pathExists(contextFile))) {
    const previous = JSON.parse(await readFile(contextFile, 'utf8')) as Record<string, unknown>;
    const contextKeys = (Object.keys(staticContext) as Array<keyof typeof staticContext>).filter(
      (key) => key !== 'maxUnproductiveWindows' || previous[key] !== undefined,
    );
    const mismatch = contextKeys.some((key) => previous[key] !== context[key]);
    if (mismatch && !options.force) {
      throw new FinalStateResumeContextMismatchError(
        'Backward recovery context differs from the pinned run.',
        {
          path: contextFile,
        },
      );
    }
    const observedHead = previous.sqdFinalizedHead;
    if (
      observedHead !== null &&
      observedHead !== undefined &&
      (!Number.isSafeInteger(observedHead) || (observedHead as number) < 0)
    ) {
      throw new FinalStateResumeContextMismatchError(
        'Backward recovery context contains an invalid SQD finalized head.',
        { path: contextFile },
      );
    }
    sqdFinalizedHead = (observedHead as number | null | undefined) ?? null;
    const observedGapStart = previous.sqdCoverageGapStart;
    const observedGapEnd = previous.sqdCoverageGapEnd;
    const observedGapBlocks = previous.sqdCoverageGapBlocks;
    if (
      (observedGapStart !== null &&
        observedGapStart !== undefined &&
        (!Number.isSafeInteger(observedGapStart) || (observedGapStart as number) < 0)) ||
      (observedGapEnd !== null &&
        observedGapEnd !== undefined &&
        (!Number.isSafeInteger(observedGapEnd) || (observedGapEnd as number) < 0)) ||
      (observedGapBlocks !== null &&
        observedGapBlocks !== undefined &&
        (!Number.isSafeInteger(observedGapBlocks) || (observedGapBlocks as number) < 0))
    ) {
      throw new FinalStateResumeContextMismatchError(
        'Backward recovery context contains an invalid SQD coverage gap.',
        { path: contextFile },
      );
    }
    sqdCoverageGapStart = (observedGapStart as number | null | undefined) ?? null;
    sqdCoverageGapEnd = (observedGapEnd as number | null | undefined) ?? null;
    sqdCoverageGapBlocks = (observedGapBlocks as number | undefined) ?? 0;
    context = {
      ...staticContext,
      sqdFinalizedHead,
      sqdCoverageGapStart,
      sqdCoverageGapEnd,
      sqdCoverageGapBlocks,
    };
  }
  await writeJson(contextFile, context);

  const loadedBalances = await loadBalanceFile(balancesFile);
  for (const address of loadedBalances.keys()) {
    if (base.candidates.has(address))
      throw new FinalStateIdentityMismatchError(
        'New balance cache overlaps the base candidate set.',
        { address },
      );
  }
  const loadedCommitted = await loadAddressFile(candidatesFile);
  for (const address of base.candidates) {
    if (loadedCommitted.size > 0 && !loadedCommitted.has(address)) {
      throw new FinalStateIdentityMismatchError(
        'Known-candidates cache is missing a base candidate.',
        { address },
      );
    }
  }
  for (const address of loadedCommitted) {
    if (!base.candidates.has(address) && !loadedBalances.has(address)) {
      throw new FinalStateIdentityMismatchError(
        'Known-candidates cache has no matching final balance.',
        { address },
      );
    }
  }
  const committedCandidates = new Set<string>(
    loadedCommitted.size > 0 ? loadedCommitted : base.candidates,
  );
  const allKnownCandidates = new Set([...committedCandidates, ...loadedBalances.keys()]);
  let checkpoint: BackwardRecoveryCheckpoint | undefined;
  let checkpointWasMigrated = false;
  if (resume && (await pathExists(checkpointFile))) {
    const parsed = parseCheckpoint(
      JSON.parse(await readFile(checkpointFile, 'utf8')),
      checkpointFile,
    );
    checkpoint = parsed.checkpoint;
    checkpointWasMigrated = parsed.migratedFromSchemaVersion === 1;
    if (checkpointWasMigrated) {
      checkpoint = {
        ...checkpoint,
        ...(await rebuildCountersFromRounds(
          roundsDirectory,
          checkpoint.completedRounds,
          checkpointFile,
        )),
      };
    }
  }

  if (
    !checkpointWasMigrated &&
    checkpoint?.status !== undefined &&
    (checkpoint.status === 'SUPPLY_COMPLETE' ||
      checkpoint.status === 'BACKWARD_DISCOVERY_STALLED' ||
      checkpoint.status === 'REACHED_GENESIS_WITH_SHORTFALL') &&
    (await pathExists(summaryFile))
  ) {
    const savedSummary = JSON.parse(await readFile(summaryFile, 'utf8')) as BackwardRecoverySummary;
    return { workDirectory, summaryFile, summary: savedSummary };
  }

  const knownSum =
    base.sum +
    [...loadedBalances.values()].reduce((sum, result) => sum + BigInt(result.balancePlanck), 0n);
  if (knownSum > totalSupply)
    throw new FinalStateSupplyOverflowError(
      'Backward recovery base and new balances exceed total supply.',
      { knownSumPlanck: knownSum.toString(10), totalSupplyPlanck: totalSupply.toString(10) },
    );
  if (checkpoint !== undefined && loadedBalances.size === checkpoint.newCandidateCountTotal) {
    if (checkpoint.knownFinalSumPlanck !== knownSum.toString(10)) {
      throw new FinalStateIdentityMismatchError(
        'Backward checkpoint sum does not match durable balances.',
        { expected: knownSum.toString(10), actual: checkpoint.knownFinalSumPlanck },
      );
    }
  }
  if (checkpointWasMigrated) await writeJson(checkpointFile, checkpoint);
  await mkdir(proofsDirectory, { recursive: true });
  const progress = options.progress ?? (() => undefined);
  const sqdClient =
    options.sqdClient ?? createSqdCurlTransport({ endpoint: options.sqdEndpoint ?? SQD_ENDPOINT });
  const transport =
    options.transport ??
    createDwellirCurlTransport({
      key: await resolveDwellirKey(options.key, options.keyFile),
      ...(options.endpointBase === undefined ? {} : { endpointBase: options.endpointBase }),
      timeoutMs,
      connectTimeoutMs,
      retries: 5,
    });
  const persistBalanceCache = () => persistBalances(balancesFile, loadedBalances);

  // A crash can leave balances durable before the checkpoint. Complete any such positive proofs first.
  for (const result of loadedBalances.values()) {
    await captureBalanceReadProof(transport, result, proofsDirectory, captureProof);
  }
  const initialProofCount = await countProofs(proofsDirectory, loadedBalances.values());
  let cursorEnd = checkpoint?.nextCursorEnd ?? Number(MOONBEAM_FINAL_BLOCK_NUMBER);
  if (sqdFinalizedHead !== null && cursorEnd > sqdFinalizedHead) {
    cursorEnd = sqdFinalizedHead;
  }
  let consecutiveNoNewCandidateWindows = checkpoint?.consecutiveNoNewCandidateWindows ?? 0;
  let consecutiveUnproductiveWindows = checkpoint?.consecutiveUnproductiveWindows ?? 0;
  let completedRounds = checkpoint?.completedRounds ?? 0;
  let oldestScannedBlock: number | null = null;
  let newestScannedBlock: number | null =
    completedRounds > 0 ? Number(MOONBEAM_FINAL_BLOCK_NUMBER) : null;
  if (resume && (await pathExists(summaryFile))) {
    const savedSummary = JSON.parse(
      await readFile(summaryFile, 'utf8'),
    ) as Partial<BackwardRecoverySummary>;
    oldestScannedBlock =
      typeof savedSummary.oldestScannedBlock === 'number' ? savedSummary.oldestScannedBlock : null;
    newestScannedBlock =
      typeof savedSummary.newestScannedBlock === 'number'
        ? savedSummary.newestScannedBlock
        : newestScannedBlock;
  }
  let proofsCaptured = Math.max(initialProofCount, checkpoint?.proofsCaptured ?? 0);
  const coverage = (): SqdCoverageObservation => ({
    finalizedHead: sqdFinalizedHead,
    gapStart: sqdCoverageGapStart,
    gapEnd: sqdCoverageGapEnd,
    gapBlocks: sqdCoverageGapBlocks,
  });
  const recordSqdCoverage = async (availableHead: number): Promise<void> => {
    if (availableHead > Number(MOONBEAM_FINAL_BLOCK_NUMBER)) {
      throw new FinalStateIdentityMismatchError(
        'SQD finalized head exceeds the pinned Moonbeam final block.',
        { availableHead, finalBlockNumber: Number(MOONBEAM_FINAL_BLOCK_NUMBER) },
      );
    }
    sqdFinalizedHead = availableHead;
    if (availableHead < Number(MOONBEAM_FINAL_BLOCK_NUMBER)) {
      sqdCoverageGapStart = availableHead + 1;
      sqdCoverageGapEnd = Number(MOONBEAM_FINAL_BLOCK_NUMBER);
      sqdCoverageGapBlocks = sqdCoverageGapEnd - sqdCoverageGapStart + 1;
    } else {
      sqdCoverageGapStart = null;
      sqdCoverageGapEnd = null;
      sqdCoverageGapBlocks = 0;
    }
    context = {
      ...staticContext,
      sqdFinalizedHead,
      sqdCoverageGapStart,
      sqdCoverageGapEnd,
      sqdCoverageGapBlocks,
    };
    await writeJson(contextFile, context);
    await writeJson(
      summaryFile,
      aggregateSummary(
        base,
        loadedBalances,
        allKnownCandidates,
        checkpoint,
        totalSupply,
        windowBlocks,
        maxUnproductiveWindows,
        'IN_PROGRESS',
        newestScannedBlock,
        oldestScannedBlock,
        coverage(),
        proofsCaptured,
      ),
    );
    progress(`SQD_FINALIZED_HEAD=${availableHead}`);
    progress(`SQD_COVERAGE_GAP_START=${sqdCoverageGapStart ?? 'NONE'}`);
    progress(`SQD_COVERAGE_GAP_END=${sqdCoverageGapEnd ?? 'NONE'}`);
    progress(`SQD_COVERAGE_GAP_BLOCKS=${sqdCoverageGapBlocks}`);
  };
  await writeJson(
    summaryFile,
    aggregateSummary(
      base,
      loadedBalances,
      allKnownCandidates,
      checkpoint,
      totalSupply,
      windowBlocks,
      maxUnproductiveWindows,
      'IN_PROGRESS',
      newestScannedBlock,
      oldestScannedBlock,
      coverage(),
      proofsCaptured,
    ),
  );

  const initialKnownSum =
    checkpoint === undefined ? base.sum : BigInt(checkpoint.knownFinalSumPlanck);
  if (initialKnownSum > totalSupply)
    throw new FinalStateSupplyOverflowError('Backward checkpoint known sum exceeds total supply.', {
      knownSumPlanck: initialKnownSum.toString(10),
      totalSupplyPlanck: totalSupply.toString(10),
    });
  const initialDeficit = totalSupply - initialKnownSum;
  const initialTerminalStatus: BackwardRecoveryStatus | undefined =
    initialDeficit === 0n
      ? 'SUPPLY_COMPLETE'
      : consecutiveUnproductiveWindows >= maxUnproductiveWindows
        ? 'BACKWARD_DISCOVERY_STALLED'
        : undefined;
  if (initialTerminalStatus !== undefined && checkpoint !== undefined) {
    checkpoint = { ...checkpoint, status: initialTerminalStatus };
    const summary = aggregateSummary(
      base,
      loadedBalances,
      committedCandidates,
      checkpoint,
      totalSupply,
      windowBlocks,
      maxUnproductiveWindows,
      initialTerminalStatus,
      newestScannedBlock,
      oldestScannedBlock,
      coverage(),
      proofsCaptured,
    );
    await writeJson(summaryFile, summary);
    await writeJson(checkpointFile, checkpoint);
    progress(
      `CONSECUTIVE_UNPRODUCTIVE_WINDOWS=${consecutiveUnproductiveWindows}/${maxUnproductiveWindows}`,
    );
    progress(`CONSECUTIVE_NO_NEW_CANDIDATE_WINDOWS=${consecutiveNoNewCandidateWindows}`);
    progress(`STATUS=${initialTerminalStatus}`);
    return { workDirectory, summaryFile, summary };
  }

  while (cursorEnd >= 0) {
    let window = calculateBackwardWindow(cursorEnd, windowBlocks);
    const roundNumber = completedRounds + 1;
    progress(`ROUND=${roundNumber}`);
    progress(`BLOCK_RANGE=${window.blockStart}-${window.blockEnd}`);
    const knownSumBefore =
      checkpoint === undefined ? base.sum : BigInt(checkpoint.knownFinalSumPlanck);
    if (knownSumBefore > totalSupply)
      throw new FinalStateSupplyOverflowError(
        'Backward checkpoint known sum exceeds total supply.',
        {
          knownSumPlanck: knownSumBefore.toString(10),
          totalSupplyPlanck: totalSupply.toString(10),
        },
      );
    const deficitBefore = totalSupply - knownSumBefore;
    let scanned: WindowScanResult;
    while (true) {
      scanned = await scanBackwardWindow(sqdClient, window.blockStart, window.blockEnd);
      if (scanned.availableHead === undefined || scanned.availableHead >= window.blockStart) break;
      await recordSqdCoverage(scanned.availableHead);
      cursorEnd = Math.min(cursorEnd, scanned.availableHead);
      window = calculateBackwardWindow(cursorEnd, windowBlocks);
      progress(`BLOCK_RANGE=${window.blockStart}-${window.blockEnd}`);
    }
    const newCandidates = selectNewCandidates(scanned.addresses, committedCandidates);
    const missingBalances = newCandidates.filter((address) => !loadedBalances.has(address));
    await processBalances(
      transport,
      missingBalances,
      loadedBalances,
      storageConcurrency,
      persistBalanceCache,
    );
    const roundBalances = newCandidates.map((address) => {
      const result = loadedBalances.get(address);
      if (result === undefined)
        throw new FinalStateIdentityMismatchError('Missing durable balance for new candidate.', {
          address,
        });
      return result;
    });
    const classified = classifyFinalBalances(roundBalances);
    for (const result of roundBalances)
      await captureBalanceReadProof(transport, result, proofsDirectory, captureProof);
    proofsCaptured = await countProofs(proofsDirectory, loadedBalances.values());
    const knownSumAfter =
      base.sum +
      [...loadedBalances.values()].reduce((sum, result) => sum + BigInt(result.balancePlanck), 0n);
    if (knownSumAfter > totalSupply)
      throw new FinalStateSupplyOverflowError('Backward recovery balances exceed total supply.', {
        knownSumPlanck: knownSumAfter.toString(10),
        totalSupplyPlanck: totalSupply.toString(10),
      });
    const deficitAfter = totalSupply - knownSumAfter;
    const deficitReduction = deficitBefore - deficitAfter;
    if (deficitReduction !== classified.positiveSum)
      throw new FinalStateIdentityMismatchError(
        'Backward recovery deficit reduction does not match new positive balances.',
        {
          deficitBeforePlanck: deficitBefore.toString(10),
          deficitAfterPlanck: deficitAfter.toString(10),
          deficitReductionPlanck: deficitReduction.toString(10),
          newPositiveSumPlanck: classified.positiveSum.toString(10),
        },
      );
    for (const address of newCandidates) {
      committedCandidates.add(address);
      allKnownCandidates.add(address);
    }
    const progressCounters = updateBackwardProgressCounters(
      { consecutiveNoNewCandidateWindows, consecutiveUnproductiveWindows },
      newCandidates.length,
      classified.positiveSum,
    );
    consecutiveNoNewCandidateWindows = progressCounters.consecutiveNoNewCandidateWindows;
    consecutiveUnproductiveWindows = progressCounters.consecutiveUnproductiveWindows;
    const { productive } = progressCounters;
    oldestScannedBlock =
      oldestScannedBlock === null
        ? window.blockStart
        : Math.min(oldestScannedBlock, window.blockStart);
    newestScannedBlock =
      newestScannedBlock === null ? window.blockEnd : Math.max(newestScannedBlock, window.blockEnd);
    const positiveNewTotal = (checkpoint?.newPositiveCountTotal ?? 0) + classified.positive.length;
    const zeroNewTotal = (checkpoint?.newZeroCountTotal ?? 0) + classified.zero.length;
    const candidateNewTotal = (checkpoint?.newCandidateCountTotal ?? 0) + newCandidates.length;
    const terminalStatus: BackwardRecoveryStatus | undefined =
      deficitAfter === 0n
        ? 'SUPPLY_COMPLETE'
        : consecutiveUnproductiveWindows >= maxUnproductiveWindows
          ? 'BACKWARD_DISCOVERY_STALLED'
          : window.nextCursorEnd < 0
            ? 'REACHED_GENESIS_WITH_SHORTFALL'
            : undefined;
    const round: BackwardRoundResult = {
      round: roundNumber,
      blockStart: window.blockStart,
      blockEnd: window.blockEnd,
      transferLogCount: scanned.transferLogCount,
      transferAddressCount: scanned.transferAddressCount,
      newCandidateCount: newCandidates.length,
      newPositiveCount: classified.positive.length,
      newZeroCount: classified.zero.length,
      newPositiveSumPlanck: classified.positiveSum.toString(10),
      productive,
      deficitBeforePlanck: deficitBefore.toString(10),
      deficitReductionPlanck: deficitReduction.toString(10),
      deficitAfterPlanck: deficitAfter.toString(10),
      knownCandidateCountAfter: committedCandidates.size,
      knownPositiveCountAfter:
        base.positiveCount +
        [...loadedBalances.values()].filter((result) => BigInt(result.balancePlanck) > 0n).length,
      knownFinalSumPlanckAfter: knownSumAfter.toString(10),
      remainingDeficitPlanckAfter: deficitAfter.toString(10),
      consecutiveNoNewCandidateWindowsAfter: consecutiveNoNewCandidateWindows,
      consecutiveUnproductiveWindowsAfter: consecutiveUnproductiveWindows,
      proofsCaptured,
    };
    await persistCandidates(candidatesFile, committedCandidates);
    await mkdir(roundsDirectory, { recursive: true });
    const roundPath = join(roundsDirectory, `${String(roundNumber).padStart(6, '0')}.json`);
    if (await pathExists(roundPath)) {
      const existing = await readFile(roundPath, 'utf8');
      if (!matchesExistingRound(existing, round))
        throw new FinalStateIdentityMismatchError('Existing backward round result differs.', {
          round: roundNumber,
        });
    } else await writeJson(roundPath, round);
    completedRounds = roundNumber;
    cursorEnd = window.nextCursorEnd;
    checkpoint = {
      schemaVersion: 2,
      nextCursorEnd: cursorEnd,
      completedRounds,
      consecutiveNoNewCandidateWindows,
      consecutiveUnproductiveWindows,
      knownCandidateCount: committedCandidates.size,
      knownPositiveCount: round.knownPositiveCountAfter,
      knownFinalSumPlanck: knownSumAfter.toString(10),
      remainingDeficitPlanck: deficitAfter.toString(10),
      newCandidateCountTotal: candidateNewTotal,
      newPositiveCountTotal: positiveNewTotal,
      newZeroCountTotal: zeroNewTotal,
      proofsCaptured,
      ...(terminalStatus === undefined ? {} : { status: terminalStatus }),
    };
    const summaryStatus = terminalStatus ?? 'IN_PROGRESS';
    await writeJson(
      summaryFile,
      aggregateSummary(
        base,
        loadedBalances,
        committedCandidates,
        checkpoint,
        totalSupply,
        windowBlocks,
        maxUnproductiveWindows,
        summaryStatus,
        newestScannedBlock,
        oldestScannedBlock,
        coverage(),
        proofsCaptured,
      ),
    );
    await writeJson(checkpointFile, checkpoint);
    progress(`TRANSFER_LOGS=${scanned.transferLogCount}`);
    progress(`TRANSFER_ADDRESSES=${scanned.transferAddressCount}`);
    progress(`NEW_CANDIDATES=${newCandidates.length}`);
    progress(`NEW_POSITIVE=${classified.positive.length}`);
    progress(`NEW_ZERO=${classified.zero.length}`);
    progress(`NEW_POSITIVE_SUM_PLANCK=${classified.positiveSum.toString(10)}`);
    progress(`KNOWN_CANDIDATES=${committedCandidates.size}`);
    progress(`KNOWN_FINAL_SUM_PLANCK=${knownSumAfter.toString(10)}`);
    progress(`TOTAL_SUPPLY_PLANCK=${totalSupply.toString(10)}`);
    progress(`REMAINING_DEFICIT_PLANCK=${deficitAfter.toString(10)}`);
    progress(`DEFICIT_REDUCTION_PLANCK=${deficitReduction.toString(10)}`);
    progress(`PRODUCTIVE_WINDOW=${productive}`);
    progress(
      `CONSECUTIVE_UNPRODUCTIVE_WINDOWS=${consecutiveUnproductiveWindows}/${maxUnproductiveWindows}`,
    );
    progress(`CONSECUTIVE_NO_NEW_CANDIDATE_WINDOWS=${consecutiveNoNewCandidateWindows}`);
    progress(`PROOFS_CAPTURED_THIS_ROUND=${classified.positive.length}`);
    progress('PROOF_VERIFICATION=NOT_RUN');
    if (terminalStatus !== undefined) {
      progress(`STATUS=${terminalStatus}`);
      const summary = aggregateSummary(
        base,
        loadedBalances,
        committedCandidates,
        checkpoint,
        totalSupply,
        windowBlocks,
        maxUnproductiveWindows,
        terminalStatus,
        newestScannedBlock,
        oldestScannedBlock,
        coverage(),
        proofsCaptured,
      );
      return { workDirectory, summaryFile, summary };
    }
    checkpoint = { ...checkpoint };
  }
  const status: BackwardRecoveryStatus = 'REACHED_GENESIS_WITH_SHORTFALL';
  const summary = aggregateSummary(
    base,
    loadedBalances,
    committedCandidates,
    checkpoint,
    totalSupply,
    windowBlocks,
    maxUnproductiveWindows,
    status,
    newestScannedBlock,
    oldestScannedBlock,
    coverage(),
    proofsCaptured,
  );
  return { workDirectory, summaryFile, summary };
}
