import { appendFile, access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  EXPECTED_MOONSCAN_ONLY_COUNT,
  EXPECTED_MOONSCAN_ONLY_SHA256,
  EXPECTED_MOONSCAN_ADDRESS_COUNT,
  EXPECTED_SUBSCAN_CACHED_FINAL_SUM_PLANCK,
  EXPECTED_SUBSCAN_CANDIDATE_COUNT,
  EXPECTED_SUBSCAN_CANDIDATE_SHA256,
  EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
  MOONBEAM_OBSERVED_EVM_BLOCK_HASH,
  RANK565_HISTORICAL_BALANCE_PLANCK,
} from '../final-state/constants.js';
import { discoverCandidateAddresses } from '../subscan/candidates.js';
import { sha256Hex } from '../snapshot/digest.js';
import {
  FinalStateBalanceCacheConflictError,
  FinalStateIdentityMismatchError,
  FinalStateStorageBackendUnsupportedError,
  FinalStateStorageLayoutError,
  FinalStateSupplyChangedError,
  FinalStateSupplyOverflowError,
  FinalStateSupplyShortfallError,
  XcDotError,
} from '../utils/errors.js';
import { compareCanonicalStrings } from '../utils/order.js';
import {
  deriveBalanceAccountStoragesKeyDirect,
  deriveTotalSupplyAccountStoragesKeyDirect,
} from './substrate-evm.js';
import {
  defaultOfflineVerifier,
  createDwellirCurlTransport,
  recoverDwellirFinalStateBase,
  resolveDwellirKey,
  writeSums,
  type DwellirFinalStateRecoveryOptions,
  type DwellirFinalStateRecoveryResult,
  type DwellirRpcTransport,
} from './dwellir-final-state-recovery.js';
import { loadFinalBalanceCache } from './final-balance-cache.js';
import {
  buildCandidateUniverse,
  serializeAddressRecords,
  serializeCandidateProvenance,
  type CandidateUniverse,
} from '../candidates/candidate-universe.js';
import { parseMoonscanHolderCsv, type MoonscanImport } from '../candidates/moonscan.js';
import { decodeU256Storage } from './solidity.js';
import { XC_DOT_XC20_ADDRESS } from '../asset/constants.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_WORK = `diagnostics/dwellir-final-state-recovery-work/moonbeam-${MOONBEAM_FINAL_BLOCK_NUMBER}`;
const DEFAULT_DIFF_OUT = 'diagnostics/moonscan-diff';
const EXTENSION_NAME = 'moonscan-a03149cc';

interface CacheResultRecord {
  schemaVersion: 1;
  address: string;
  substrateStorageKey: string;
  rawValue: string | null;
  balancePlanck: string;
}

interface ExtensionContext {
  schemaVersion: 1;
  source: 'moonscan';
  chainId: number;
  blockNumber: string;
  blockHash: string;
  stateRoot: string;
  evmBlockHash: string;
  contract: string;
  balancesSlot: string;
  totalSupplyPlanck: string;
  candidateAddressesSha256: string;
  moonscanOnlyCount: number;
  moonscanOnlySha256: string;
  moonscanSourceSha256: string;
}

interface FinalStats {
  queried: number;
  successful: number;
  missing: number;
  positive: number;
  zero: number;
  sum: bigint;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function ndjson<T>(records: readonly T[]): string {
  return records.length === 0
    ? ''
    : records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function isHex(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    return false;
  }
  return bytes === undefined || value.length === 2 + bytes * 2;
}

function normalizeRawValue(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (!isHex(value, 32)) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Final-state cache extension contains a malformed storage value.',
      { label, value: String(value).slice(0, 160) },
    );
  }
  return value.toLowerCase();
}

function canonicalKey(value: unknown, label: string): string {
  if (!isHex(value) || value.length <= 2) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Final-state cache extension contains a malformed storage key.',
      { label, value: String(value).slice(0, 160) },
    );
  }
  return value.toLowerCase();
}

function mergeCachedValue(
  values: Map<string, string | null>,
  key: string,
  value: string | null,
  source: string,
): void {
  const previous = values.get(key);
  if (values.has(key) && previous !== value) {
    throw new FinalStateBalanceCacheConflictError(
      'Final-state cache sources contain conflicting values for one storage key.',
      { source, key },
    );
  }
  values.set(key, value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function loadExtensionResults(
  path: string,
  values: Map<string, string | null>,
  expectedContext: ExtensionContext,
  addressByKey: Map<string, string>,
): Promise<number> {
  if (!(await pathExists(path))) return 0;
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '');
  let count = 0;
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new FinalStateStorageBackendUnsupportedError(
        'Final-state cache extension contains invalid JSON.',
        { path, line: index + 1, error: error instanceof Error ? error.message : String(error) },
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new FinalStateStorageBackendUnsupportedError(
        'Final-state cache result is not an object.',
        {
          path,
          line: index + 1,
        },
      );
    }
    const record = parsed as Partial<CacheResultRecord> & {
      blockHash?: unknown;
      contract?: unknown;
      candidateAddressesSha256?: unknown;
      moonscanSourceSha256?: unknown;
    };
    if (
      record.schemaVersion !== 1 ||
      typeof record.substrateStorageKey !== 'string' ||
      typeof record.address !== 'string' ||
      record.blockHash !== expectedContext.blockHash ||
      record.contract !== expectedContext.contract ||
      record.candidateAddressesSha256 !== expectedContext.candidateAddressesSha256 ||
      record.moonscanSourceSha256 !== expectedContext.moonscanSourceSha256
    ) {
      throw new FinalStateIdentityMismatchError(
        'Final-state cache result context differs from the pinned run.',
        {
          path,
          line: index + 1,
        },
      );
    }
    const key = canonicalKey(record.substrateStorageKey, `${path}:${index + 1}:key`);
    if (addressByKey.get(key) !== record.address.toLowerCase()) {
      throw new FinalStateIdentityMismatchError(
        'Final-state cache result address/key binding is invalid.',
        {
          path,
          line: index + 1,
          key,
        },
      );
    }
    const value = normalizeRawValue(record.rawValue, `${path}:${index + 1}:rawValue`);
    mergeCachedValue(values, key, value, path);
    count += 1;
  }
  return count;
}

async function loadOptionalCache(
  directory: string,
  expectedBlockHash: string,
): Promise<Map<string, string | null>> {
  if (!(await pathExists(directory))) return new Map();
  return (await loadFinalBalanceCache(directory, expectedBlockHash)).values;
}

function expectedOption<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function expectedMoonscanRecord(
  imported: MoonscanImport,
  address: string,
): Record<string, unknown> {
  const record = imported.byAddress.get(address);
  if (!record) return { address };
  return {
    address,
    balancePlanck: record.balancePlanckDiagnostic.toString(10),
    pendingBalanceUpdate: record.pendingBalanceUpdateRaw,
  };
}

async function writeReconciliationArtifacts(
  directory: string,
  subscan: Awaited<ReturnType<typeof discoverCandidateAddresses>>,
  moonscan: MoonscanImport,
  universe: CandidateUniverse,
  options: DwellirFinalStateRecoveryOptions,
  existingCache: { count: number; sum: bigint },
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const sourceMap = universe.records.map((record) => ({
    address: record.address,
    sources: record.sources,
    ...(subscan.sourceBalances.has(record.address)
      ? { subscanBalancePlanck: subscan.sourceBalances.get(record.address) }
      : {}),
    ...(moonscan.byAddress.has(record.address)
      ? {
          moonscanBalancePlanck: moonscan.byAddress
            .get(record.address)!
            .balancePlanckDiagnostic.toString(10),
        }
      : {}),
    ...(moonscan.byAddress.has(record.address)
      ? { pendingBalanceUpdate: moonscan.byAddress.get(record.address)!.pendingBalanceUpdateRaw }
      : {}),
  }));
  const overlap = universe.intersection.map((address) => {
    const subscanBalance = subscan.sourceBalances.get(address);
    const moonscanBalance = moonscan.byAddress.get(address)?.balancePlanckDiagnostic;
    return {
      address,
      subscanBalancePlanck: subscanBalance ?? null,
      moonscanBalancePlanck: moonscanBalance?.toString(10) ?? null,
      deltaPlanck:
        subscanBalance === undefined || moonscanBalance === undefined
          ? null
          : (moonscanBalance - BigInt(subscanBalance)).toString(10),
    };
  });
  const rankedMismatches = [...overlap]
    .filter((record) => record.deltaPlanck !== null)
    .sort((left, right) => {
      const leftMagnitude =
        left.deltaPlanck === null
          ? 0n
          : left.deltaPlanck.startsWith('-')
            ? -BigInt(left.deltaPlanck)
            : BigInt(left.deltaPlanck);
      const rightMagnitude =
        right.deltaPlanck === null
          ? 0n
          : right.deltaPlanck.startsWith('-')
            ? -BigInt(right.deltaPlanck)
            : BigInt(right.deltaPlanck);
      const leftAbs = leftMagnitude < 0n ? -leftMagnitude : leftMagnitude;
      const rightAbs = rightMagnitude < 0n ? -rightMagnitude : rightMagnitude;
      return rightAbs === leftAbs
        ? compareCanonicalStrings(left.address, right.address)
        : rightAbs > leftAbs
          ? 1
          : -1;
    })
    .slice(0, 20);

  const files: Record<string, string> = {
    'subscan-only.ndjson': serializeAddressRecords(universe.subscanOnly),
    'moonscan-only.ndjson': ndjson(
      universe.moonscanOnly.map((address) => expectedMoonscanRecord(moonscan, address)),
    ),
    'new-addresses.ndjson': serializeAddressRecords(universe.moonscanOnly),
    'intersection.ndjson': serializeAddressRecords(universe.intersection),
    'candidate-union.ndjson': serializeAddressRecords(universe.addresses),
    'candidate-source-map.ndjson': ndjson(sourceMap),
    'candidate-provenance.ndjson': serializeCandidateProvenance(universe.records),
    'overlap-diff.ndjson': ndjson(overlap),
    'top-20-mismatches.ndjson': ndjson(rankedMismatches),
    'source-summary.json': json({
      schemaVersion: 1,
      blockNumber: MOONBEAM_FINAL_BLOCK_NUMBER,
      blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
      stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
      sources: {
        subscan: {
          rawFileCount: subscan.rawFileCount,
          rawRowCount: subscan.rawRowCount,
          validRowCount: subscan.validRowCount,
          invalidRowCount: subscan.invalidRowCount,
          uniqueValidAddressCount: subscan.uniqueValidAddressCount,
          candidateAddressesSha256: universe.subscanAddressSha256,
        },
        moonscan: {
          sourceFile: resolve(moonscan.sourceFile),
          sourceSha256: moonscan.sourceSha256,
          rowCount: moonscan.rowCount,
          validRowCount: moonscan.validRowCount,
          uniqueAddressCount: moonscan.uniqueAddressCount,
          duplicateCount: moonscan.duplicateCount,
          diagnosticBalanceSumPlanck: moonscan.csvBalanceSumPlanckDiagnostic.toString(10),
        },
      },
      reconciliation: {
        subscanOnlyCount: universe.subscanOnly.length,
        intersectionCount: universe.intersection.length,
        moonscanOnlyCount: universe.moonscanOnly.length,
        unionCount: universe.addresses.length,
        moonscanOnlySha256: universe.moonscanOnlySha256,
        unionSha256: universe.unionSha256,
      },
      existingFinalStateCache: {
        cachedSubscanAddressCount: existingCache.count,
        cachedSubscanFinalSumPlanck: existingCache.sum.toString(10),
      },
      historicalDiagnosticOnly: {
        rank565BalancePlanck: RANK565_HISTORICAL_BALANCE_PLANCK,
        balancesAffectFinalState: false,
      },
      forceSourceChange: options.forceSourceChange === true,
    }),
  };
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      writeFile(join(directory, name), contents, 'utf8'),
    ),
  );
}

async function writeExtensionContext(path: string, context: ExtensionContext): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, json(context));
}

function readCachedStats(
  values: Map<string, string | null>,
  addresses: readonly { address: string; substrateStorageKey: string }[],
): FinalStats {
  let successful = 0;
  let missing = 0;
  let positive = 0;
  let zero = 0;
  let sum = 0n;
  for (const item of addresses) {
    if (!values.has(item.substrateStorageKey)) {
      missing += 1;
      continue;
    }
    successful += 1;
    const balance = decodeU256Storage(values.get(item.substrateStorageKey));
    sum += balance;
    if (balance === 0n) zero += 1;
    else positive += 1;
  }
  return { queried: addresses.length, successful, missing, positive, zero, sum };
}

async function writeFinalStateDiagnostics(
  directory: string,
  universe: CandidateUniverse,
  subscan: Awaited<ReturnType<typeof discoverCandidateAddresses>>,
  values: Map<string, string | null>,
  unionKeys: readonly { address: string; substrateStorageKey: string }[],
  stats: FinalStats,
): Promise<void> {
  if (stats.successful !== stats.queried) return;
  const balances = unionKeys.map((item) => ({
    address: item.address,
    balancePlanck: decodeU256Storage(values.get(item.substrateStorageKey)).toString(10),
  }));
  const positive = balances.filter((record) => record.balancePlanck !== '0');
  const zero = balances
    .filter((record) => record.balancePlanck === '0')
    .map(({ address }) => ({ address }));
  const diff = balances.map((record) => {
    const subscanBalance = subscan.sourceBalances.get(record.address);
    return {
      address: record.address,
      subscanBalancePlanck: subscanBalance ?? null,
      finalBalancePlanck: record.balancePlanck,
      deltaPlanck:
        subscanBalance === undefined
          ? null
          : (BigInt(record.balancePlanck) - BigInt(subscanBalance)).toString(10),
    };
  });
  const positiveText = ndjson(positive);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'final-balances.ndjson'), ndjson(balances), 'utf8'),
    writeFile(join(directory, 'known-positive-holders.ndjson'), positiveText, 'utf8'),
    writeFile(join(directory, 'zero-balance-candidates.ndjson'), ndjson(zero), 'utf8'),
    writeFile(join(directory, 'subscan-vs-final.ndjson'), ndjson(diff), 'utf8'),
    writeFile(
      join(directory, 'known-positive-holders.sha256'),
      `${sha256Hex(positiveText)}\n`,
      'utf8',
    ),
  ]);
}

async function writeIncompleteSummary(
  directory: string,
  context: ExtensionContext,
  stats: FinalStats,
  status: string,
  error?: unknown,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const normalized = error instanceof XcDotError ? error : undefined;
  await writeFile(
    join(directory, 'final-state-summary.json'),
    json({
      schemaVersion: 1,
      status,
      context,
      finalState: {
        queried: stats.queried,
        successful: stats.successful,
        missing: stats.missing,
        positive: stats.positive,
        zero: stats.zero,
        knownFinalSumPlanck: stats.sum.toString(10),
        unaccountedSupplyPlanck: (BigInt(context.totalSupplyPlanck) - stats.sum).toString(10),
      },
      rank565: {
        historicalBalancePlanck: RANK565_HISTORICAL_BALANCE_PLANCK,
        requiredForFinalCompleteness:
          stats.successful === stats.queried && BigInt(context.totalSupplyPlanck) - stats.sum === 0n
            ? false
            : stats.successful === stats.queried &&
                BigInt(context.totalSupplyPlanck) - stats.sum ===
                  BigInt(RANK565_HISTORICAL_BALANCE_PLANCK)
              ? true
              : null,
      },
      ...(normalized
        ? {
            error: {
              code: normalized.code,
              message: normalized.message,
              details: normalized.details,
            },
          }
        : error === undefined
          ? {}
          : { error: { message: error instanceof Error ? error.message : String(error) } }),
    }),
    'utf8',
  );
}

function mergeMaps(
  target: Map<string, string | null>,
  source: Map<string, string | null>,
  label: string,
): void {
  for (const [key, value] of source) mergeCachedValue(target, key, value, label);
}

class CachedDwellirTransport implements DwellirRpcTransport {
  private readonly values: Map<string, string | null>;
  private readonly addressByKey: Map<string, string>;
  private readonly resultsPath: string;
  private readonly context: ExtensionContext;

  constructor(
    private readonly inner: DwellirRpcTransport,
    cachedValues: Map<string, string | null>,
    addressByKey: Map<string, string>,
    resultsPath: string,
    context: ExtensionContext,
  ) {
    this.values = cachedValues;
    this.addressByKey = addressByKey;
    this.resultsPath = resultsPath;
    this.context = context;
  }

  get cache(): Map<string, string | null> {
    return this.values;
  }

  private async record(key: string, value: unknown): Promise<unknown> {
    const normalized = normalizeRawValue(value, `live:${key}`);
    mergeCachedValue(this.values, key, normalized, 'live Dwellir response');
    const address = this.addressByKey.get(key);
    if (address !== undefined) {
      await appendFile(
        this.resultsPath,
        JSON.stringify({
          schemaVersion: 1,
          address,
          substrateStorageKey: key,
          rawValue: normalized,
          balancePlanck: decodeU256Storage(normalized).toString(10),
          blockHash: this.context.blockHash,
          contract: this.context.contract,
          candidateAddressesSha256: this.context.candidateAddressesSha256,
          moonscanSourceSha256: this.context.moonscanSourceSha256,
        }) + '\n',
        'utf8',
      );
    }
    return normalized;
  }

  async call(method: string, params: readonly unknown[]): Promise<unknown> {
    const key =
      method === 'state_getStorage' ? canonicalKey(params[0], 'state_getStorage key') : undefined;
    if (key !== undefined && this.values.has(key)) return this.values.get(key) ?? null;
    const value = await this.inner.call(method, params);
    return key === undefined ? value : this.record(key, value);
  }

  async batch(
    calls: readonly { method: string; params: readonly unknown[] }[],
  ): Promise<unknown[]> {
    const result: unknown[] = new Array(calls.length);
    const missing: Array<{
      index: number;
      call: { method: string; params: readonly unknown[] };
      key: string;
    }> = [];
    for (const [index, call] of calls.entries()) {
      if (call.method !== 'state_getStorage') {
        missing.push({ index, call, key: '' });
        continue;
      }
      const key = canonicalKey(call.params[0], 'state_getStorage key');
      if (this.values.has(key)) result[index] = this.values.get(key) ?? null;
      else missing.push({ index, call, key });
    }
    if (missing.length === 0) return result;
    const fetched = await this.inner.batch(missing.map((item) => item.call));
    if (fetched.length !== missing.length) {
      throw new FinalStateStorageBackendUnsupportedError(
        'Dwellir batch response length differs from the request.',
        {
          expected: missing.length,
          actual: fetched.length,
        },
      );
    }
    for (const [offset, item] of missing.entries()) {
      const value = await this.record(item.key, fetched[offset]);
      result[item.index] = value;
    }
    return result;
  }
}

function isFinalSupplyClassification(
  error: unknown,
): error is FinalStateSupplyShortfallError | FinalStateSupplyOverflowError {
  return (
    error instanceof FinalStateSupplyShortfallError ||
    error instanceof FinalStateSupplyOverflowError
  );
}

function isSafeIncompleteError(error: unknown): boolean {
  return error instanceof FinalStateStorageBackendUnsupportedError;
}

async function enrichVerifiedOutput(
  result: DwellirFinalStateRecoveryResult,
  universe: CandidateUniverse,
  subscan: Awaited<ReturnType<typeof discoverCandidateAddresses>>,
  moonscan: MoonscanImport,
  options: DwellirFinalStateRecoveryOptions,
): Promise<DwellirFinalStateRecoveryResult> {
  const outputDirectory = result.outputDirectory;
  await writeFile(
    join(outputDirectory, 'candidate-addresses.ndjson'),
    serializeAddressRecords(universe.addresses),
    'utf8',
  );
  await writeFile(
    join(outputDirectory, 'candidate-addresses.sha256'),
    `${universe.unionSha256}\n`,
    'utf8',
  );
  const summaryPath = join(outputDirectory, 'substrate-storage/summary.json');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as Record<string, unknown>;
  summary.candidateSet = {
    source:
      'Frozen Subscan discovery unioned with Moonscan holder-address discovery; balances diagnostic only',
    count: universe.addresses.length,
    subscanCount: subscan.addresses.length,
    moonscanCount: moonscan.records.length,
    subscanOnlyCount: universe.subscanOnly.length,
    intersectionCount: universe.intersection.length,
    moonscanOnlyCount: universe.moonscanOnly.length,
    candidateAddressesSha256: universe.unionSha256,
    subscanCandidateAddressesSha256: universe.subscanAddressSha256,
    moonscanOnlySha256: universe.moonscanOnlySha256,
  };
  await writeFile(summaryPath, json(summary), 'utf8');
  const manifestPath = join(outputDirectory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.candidateCount = universe.addresses.length;
  manifest.candidateAddressesSha256 = universe.unionSha256;
  await writeFile(manifestPath, json(manifest), 'utf8');
  await writeSums(outputDirectory);
  const verifier =
    options.offlineVerifier ?? ((directory: string) => defaultOfflineVerifier(directory, options));
  const verification = await verifier(outputDirectory);
  await writeFile(
    join(outputDirectory, 'verification/offline-verification.txt'),
    `${verification.stdout ?? 'FINAL_STATE_OFFLINE_VERIFICATION=PASS'}\n`,
    'utf8',
  );
  await writeSums(outputDirectory);
  return result;
}

export async function recoverDwellirWithMoonscan(
  options: DwellirFinalStateRecoveryOptions,
): Promise<DwellirFinalStateRecoveryResult> {
  const progress = options.progress ?? (() => undefined);
  const subscan = await discoverCandidateAddresses(options.dataset ?? 'snapshots/subscan');
  const moonscan = await parseMoonscanHolderCsv(resolve(options.moonscanCsv!));
  const universe = buildCandidateUniverse(subscan, moonscan);
  const expectedSubscanCount = expectedOption(
    options.expectedSubscanCandidateCount,
    EXPECTED_SUBSCAN_CANDIDATE_COUNT,
  );
  const expectedSubscanSha256 = expectedOption(
    options.expectedSubscanCandidateSha256,
    EXPECTED_SUBSCAN_CANDIDATE_SHA256,
  );
  const expectedMoonscanCount = expectedOption(
    options.expectedMoonscanOnlyCount,
    EXPECTED_MOONSCAN_ONLY_COUNT,
  );
  const expectedMoonscanAddressCount = expectedOption(
    options.expectedMoonscanAddressCount,
    EXPECTED_MOONSCAN_ADDRESS_COUNT,
  );
  const expectedMoonscanSha256 = expectedOption(
    options.expectedMoonscanOnlySha256,
    EXPECTED_MOONSCAN_ONLY_SHA256,
  );
  if (
    subscan.addresses.length !== expectedSubscanCount ||
    universe.subscanAddressSha256 !== expectedSubscanSha256 ||
    moonscan.records.length !== expectedMoonscanAddressCount ||
    universe.moonscanOnly.length !== expectedMoonscanCount ||
    universe.moonscanOnlySha256 !== expectedMoonscanSha256
  ) {
    throw new FinalStateIdentityMismatchError(
      'Subscan/Moonscan candidate reconciliation differs from the expected set.',
      {
        expectedSubscanCount,
        actualSubscanCount: subscan.addresses.length,
        expectedSubscanSha256,
        actualSubscanSha256: universe.subscanAddressSha256,
        expectedMoonscanAddressCount,
        actualMoonscanAddressCount: moonscan.records.length,
        expectedMoonscanOnlyCount: expectedMoonscanCount,
        actualMoonscanOnlyCount: universe.moonscanOnly.length,
        expectedMoonscanOnlySha256: expectedMoonscanSha256,
        actualMoonscanOnlySha256: universe.moonscanOnlySha256,
      },
    );
  }
  progress(
    `CANDIDATE_UNION=PASS subscan=${subscan.addresses.length} moonscanOnly=${universe.moonscanOnly.length} union=${universe.addresses.length}`,
  );

  const baseWork = resolve(options.work ?? DEFAULT_WORK);
  const extensionWork = join(baseWork, 'extensions', EXTENSION_NAME);
  const diffDirectory = resolve(options.candidateDiffOut ?? DEFAULT_DIFF_OUT);
  if (options.force || options.forceSourceChange)
    await rm(extensionWork, { recursive: true, force: true });
  await mkdir(join(extensionWork, 'candidate-input'), { recursive: true });
  const candidateInput = join(extensionWork, 'candidate-input');
  await writeFile(
    join(candidateInput, 'provenance.ndjson'),
    universe.addresses
      .map((address) =>
        JSON.stringify({ address, subscanBalancePlanck: subscan.sourceBalances.get(address) }),
      )
      .join('\n') + '\n',
    'utf8',
  );

  const totalKey = deriveTotalSupplyAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, 2n);
  const zeroKey = deriveBalanceAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, ZERO_ADDRESS, 0n);
  const subscanKeys = subscan.addresses.map((address) => ({
    address,
    ...deriveBalanceAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, address, 0n),
  }));
  const unionKeys = universe.addresses.map((address) => ({
    address,
    ...deriveBalanceAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, address, 0n),
  }));
  const addressByKey = new Map(unionKeys.map((item) => [item.substrateStorageKey, item.address]));
  const oldCacheDirectory = join(baseWork, 'storage-batches');
  const oldCache = await loadFinalBalanceCache(
    oldCacheDirectory,
    MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  );
  const extensionBatchCache = await loadOptionalCache(
    join(extensionWork, 'storage-batches'),
    MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  );
  const values = new Map<string, string | null>();
  mergeMaps(values, oldCache.values, oldCacheDirectory);
  mergeMaps(values, extensionBatchCache, join(extensionWork, 'storage-batches'));
  const context: ExtensionContext = {
    schemaVersion: 1,
    source: 'moonscan',
    chainId: 1284,
    blockNumber: MOONBEAM_FINAL_BLOCK_NUMBER,
    blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
    evmBlockHash: MOONBEAM_OBSERVED_EVM_BLOCK_HASH,
    contract: XC_DOT_XC20_ADDRESS,
    balancesSlot: '0',
    totalSupplyPlanck: options.expectedTotalSupplyPlanck ?? EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
    candidateAddressesSha256: universe.unionSha256,
    moonscanOnlyCount: universe.moonscanOnly.length,
    moonscanOnlySha256: universe.moonscanOnlySha256,
    moonscanSourceSha256: moonscan.sourceSha256,
  };
  const contextPath = join(extensionWork, 'checkpoint.json');
  if (await pathExists(contextPath)) {
    const previous = JSON.parse(await readFile(contextPath, 'utf8')) as Partial<ExtensionContext>;
    for (const field of [
      'chainId',
      'blockNumber',
      'blockHash',
      'stateRoot',
      'evmBlockHash',
      'contract',
      'balancesSlot',
      'totalSupplyPlanck',
      'candidateAddressesSha256',
      'moonscanOnlyCount',
      'moonscanOnlySha256',
      'moonscanSourceSha256',
    ] as const) {
      if (previous[field] !== context[field] && !options.forceSourceChange) {
        throw new FinalStateIdentityMismatchError(
          'Moonscan final-state resume context differs from the pinned run.',
          {
            field,
            expected: context[field],
            actual: String(previous[field]),
          },
        );
      }
    }
  }
  await writeExtensionContext(contextPath, context);
  const resultsPath = join(extensionWork, 'results.ndjson');
  const resultCount = await loadExtensionResults(resultsPath, values, context, addressByKey);

  const expectedCachedCount = expectedOption(
    options.expectedExistingCachedAddressCount,
    EXPECTED_SUBSCAN_CANDIDATE_COUNT,
  );
  const expectedCachedSum = BigInt(
    options.expectedExistingFinalSumPlanck ?? EXPECTED_SUBSCAN_CACHED_FINAL_SUM_PLANCK,
  );
  const cachedStats = readCachedStats(values, subscanKeys);
  if (cachedStats.successful !== expectedCachedCount || cachedStats.sum !== expectedCachedSum) {
    throw new FinalStateIdentityMismatchError(
      'Existing Dwellir cache does not match the frozen Subscan final-state evidence.',
      {
        expectedCachedAddressCount: expectedCachedCount,
        actualCachedAddressCount: cachedStats.successful,
        expectedCachedFinalSumPlanck: expectedCachedSum.toString(10),
        actualCachedFinalSumPlanck: cachedStats.sum.toString(10),
      },
    );
  }
  const cachedTotal = values.get(totalKey.substrateStorageKey);
  if (
    !values.has(totalKey.substrateStorageKey) ||
    decodeU256Storage(cachedTotal) !== BigInt(context.totalSupplyPlanck)
  ) {
    throw new FinalStateSupplyChangedError(
      'Existing Dwellir cache totalSupply does not match the pinned final supply.',
      {
        expectedTotalSupplyPlanck: context.totalSupplyPlanck,
        actualTotalSupplyPlanck: decodeU256Storage(cachedTotal).toString(10),
      },
    );
  }
  if (
    !values.has(zeroKey.substrateStorageKey) ||
    decodeU256Storage(values.get(zeroKey.substrateStorageKey)) !== 0n
  ) {
    throw new FinalStateStorageLayoutError(
      'Existing Dwellir cache zero-address balance is not zero.',
    );
  }
  progress(
    `CACHE_REUSE=PASS cached=${cachedStats.successful} cachedSum=${cachedStats.sum.toString(10)} extensionResults=${resultCount}`,
  );
  await writeReconciliationArtifacts(diffDirectory, subscan, moonscan, universe, options, {
    count: cachedStats.successful,
    sum: cachedStats.sum,
  });

  const transport =
    options.transport ??
    createDwellirCurlTransport({
      key: await resolveDwellirKey(options.key, options.keyFile),
      ...(options.endpointBase === undefined ? {} : { endpointBase: options.endpointBase }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.connectTimeoutMs === undefined
        ? {}
        : { connectTimeoutMs: options.connectTimeoutMs }),
      ...(options.retries === undefined ? {} : { retries: options.retries }),
    });
  const cachedTransport = new CachedDwellirTransport(
    transport,
    values,
    addressByKey,
    resultsPath,
    context,
  );
  const baseOptions: DwellirFinalStateRecoveryOptions = {
    ...options,
    dataset: candidateInput,
    work: extensionWork,
    ...(options.out === undefined ? {} : { out: options.out }),
    expectedCandidateCount: universe.addresses.length,
    expectedCandidateSha256: universe.unionSha256,
    transport: cachedTransport,
    force: false,
    retainWorkDirectory: true,
  };
  delete baseOptions.moonscanCsv;
  progress(
    `FINAL_STATE_RECONSTRUCTION=START union=${universe.addresses.length} liveCandidates=${universe.moonscanOnly.length}`,
  );
  try {
    const result = await recoverDwellirFinalStateBase(baseOptions);
    const enriched = await enrichVerifiedOutput(result, universe, subscan, moonscan, options);
    await writeExtensionContext(contextPath, context);
    await writeIncompleteSummary(
      diffDirectory,
      context,
      readCachedStats(cachedTransport.cache, unionKeys),
      'PROOF_VERIFIED',
    );
    await writeFinalStateDiagnostics(
      diffDirectory,
      universe,
      subscan,
      cachedTransport.cache,
      unionKeys,
      readCachedStats(cachedTransport.cache, unionKeys),
    );
    return enriched;
  } catch (error) {
    const stats = readCachedStats(cachedTransport.cache, unionKeys);
    const classified = isFinalSupplyClassification(error);
    const status = classified
      ? error instanceof FinalStateSupplyShortfallError
        ? 'FINAL_STATE_SUPPLY_SHORTFALL'
        : 'FINAL_STATE_SUPPLY_OVERFLOW'
      : isSafeIncompleteError(error)
        ? 'FINAL_STATE_INCOMPLETE'
        : undefined;
    if (status === undefined) throw error;
    await writeFinalStateDiagnostics(
      diffDirectory,
      universe,
      subscan,
      cachedTransport.cache,
      unionKeys,
      stats,
    );
    await writeIncompleteSummary(diffDirectory, context, stats, status, error);
    const unaccounted = BigInt(context.totalSupplyPlanck) - stats.sum;
    progress(
      `FINAL_STATE_STATUS=${status} knownFinalSum=${stats.sum.toString(10)} unaccounted=${unaccounted.toString(10)}`,
    );
    return {
      status,
      outputDirectory: resolve(
        options.out ?? `snapshots/final-state-recovered/moonbeam-${MOONBEAM_FINAL_BLOCK_NUMBER}`,
      ),
      holderCount: stats.positive,
      zeroCandidateCount: stats.zero,
      totalSupplyPlanck: context.totalSupplyPlanck,
      candidateCount: universe.addresses.length,
      candidateAddressesSha256: universe.unionSha256,
      proofBatchCount: 0,
      unaccountedSupplyPlanck: unaccounted.toString(10),
      ...(error instanceof XcDotError
        ? { errorCode: error.code, errorMessage: error.message }
        : {}),
    };
  }
}
