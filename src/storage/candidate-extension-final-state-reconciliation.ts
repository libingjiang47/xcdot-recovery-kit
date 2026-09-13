import {
  appendFile,
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
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
import { XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import {
  parseCandidateExtensionNdjson,
  type CandidateExtensionImport,
} from '../candidates/candidate-extension.js';
import {
  buildCandidateUniverse,
  serializeAddressRecords,
  serializeCandidateProvenance,
  type CandidateUniverse,
} from '../candidates/candidate-universe.js';
import { discoverCandidateAddresses } from '../subscan/candidates.js';
import { sha256Hex } from '../snapshot/digest.js';
import {
  FinalStateBalanceCacheConflictError,
  FinalStateIdentityMismatchError,
  FinalStateStorageBackendUnsupportedError,
  FinalStateSupplyOverflowError,
  FinalStateSupplyShortfallError,
  XcDotError,
} from '../utils/errors.js';
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
import { deriveBalanceAccountStoragesKeyDirect } from './substrate-evm.js';
import { decodeU256Storage } from './solidity.js';
import { loadFinalBalanceCache } from './final-balance-cache.js';

const DEFAULT_WORK = `diagnostics/dwellir-final-state-recovery-work/moonbeam-${MOONBEAM_FINAL_BLOCK_NUMBER}`;
const DEFAULT_DIFF_OUT = 'diagnostics/candidate-extension';
const EXTENSION_SOURCE = 'candidate-extension';

interface ExtensionContext {
  schemaVersion: 1;
  source: typeof EXTENSION_SOURCE;
  chainId: 1284;
  blockNumber: string;
  blockHash: string;
  stateRoot: string;
  evmBlockHash: string;
  contract: string;
  balancesSlot: '0';
  totalSupplyPlanck: string;
  candidateAddressesSha256: string;
  extensionOnlyCount: number;
  extensionOnlySha256: string;
  extensionSourceSha256: string;
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
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0)
    return false;
  return bytes === undefined || value.length === 2 + bytes * 2;
}

function canonicalKey(value: unknown): string {
  if (!isHex(value) || value.length <= 2) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Candidate-extension cache contains a malformed storage key.',
    );
  }
  return value.toLowerCase();
}

function normalizeRawValue(value: unknown): string | null {
  if (value === null) return null;
  if (!isHex(value, 32)) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Candidate-extension cache contains a malformed storage value.',
    );
  }
  return value.toLowerCase();
}

function mergeCachedValue(
  target: Map<string, string | null>,
  key: string,
  value: string | null,
  source: string,
): void {
  if (target.has(key) && target.get(key) !== value) {
    throw new FinalStateBalanceCacheConflictError(
      'Candidate-extension caches contain conflicting values for one storage key.',
      { source, key },
    );
  }
  target.set(key, value);
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

async function loadCacheIfPresent(
  directory: string,
  expectedBlockHash: string,
  values: Map<string, string | null>,
): Promise<void> {
  const firstBatch = join(directory, 'batch-000000.json');
  if (!(await pathExists(firstBatch))) return;
  const cache = await loadFinalBalanceCache(directory, expectedBlockHash);
  for (const [key, value] of cache.values) mergeCachedValue(values, key, value, directory);
}

async function loadAllKnownCaches(
  baseWork: string,
  expectedBlockHash: string,
): Promise<Map<string, string | null>> {
  const values = new Map<string, string | null>();
  await loadCacheIfPresent(join(baseWork, 'storage-batches'), expectedBlockHash, values);
  const extensionsDirectory = join(baseWork, 'extensions');
  if (!(await pathExists(extensionsDirectory))) return values;
  const entries = await readdir(extensionsDirectory, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory())) {
    await loadCacheIfPresent(
      join(extensionsDirectory, entry.name, 'storage-batches'),
      expectedBlockHash,
      values,
    );
  }
  return values;
}

async function loadCandidateExtensionResults(
  path: string,
  values: Map<string, string | null>,
  addressByKey: Map<string, string>,
  context: ExtensionContext,
): Promise<number> {
  if (!(await pathExists(path))) return 0;
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim() !== '');
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new FinalStateStorageBackendUnsupportedError(
        'Candidate-extension results contain invalid JSON.',
        { path, line: index + 1 },
      );
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new FinalStateStorageBackendUnsupportedError(
        'Candidate-extension result is not an object.',
        { path, line: index + 1 },
      );
    }
    const record = value as {
      schemaVersion?: unknown;
      address?: unknown;
      substrateStorageKey?: unknown;
      rawValue?: unknown;
      blockHash?: unknown;
      contract?: unknown;
      candidateAddressesSha256?: unknown;
      candidateExtensionSourceSha256?: unknown;
    };
    if (
      record.schemaVersion !== 1 ||
      typeof record.address !== 'string' ||
      record.blockHash !== context.blockHash ||
      record.contract !== context.contract ||
      record.candidateAddressesSha256 !== context.candidateAddressesSha256 ||
      record.candidateExtensionSourceSha256 !== context.extensionSourceSha256
    ) {
      throw new FinalStateIdentityMismatchError(
        'Candidate-extension result context differs from the pinned run.',
        { path, line: index + 1 },
      );
    }
    const key = canonicalKey(record.substrateStorageKey);
    if (addressByKey.get(key) !== record.address.toLowerCase()) {
      throw new FinalStateIdentityMismatchError(
        'Candidate-extension result address/key binding is invalid.',
        { path, line: index + 1, key },
      );
    }
    mergeCachedValue(values, key, normalizeRawValue(record.rawValue), path);
  }
  return lines.length;
}

class CachedCandidateExtensionTransport implements DwellirRpcTransport {
  constructor(
    private readonly inner: DwellirRpcTransport,
    private readonly values: Map<string, string | null>,
    private readonly addressByKey: Map<string, string>,
    private readonly resultsPath: string,
    private readonly context: ExtensionContext,
  ) {}

  async call(method: string, params: readonly unknown[]): Promise<unknown> {
    const key = method === 'state_getStorage' ? canonicalKey(params[0]) : undefined;
    if (key !== undefined && this.values.has(key)) return this.values.get(key) ?? null;
    const value = await this.inner.call(method, params);
    if (key === undefined) return value;
    return this.record(key, value);
  }

  async batch(
    calls: readonly { method: string; params: readonly unknown[] }[],
  ): Promise<unknown[]> {
    const result: Array<unknown> = new Array(calls.length);
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
      const key = canonicalKey(call.params[0]);
      if (this.values.has(key)) result[index] = this.values.get(key) ?? null;
      else missing.push({ index, call, key });
    }
    if (missing.length === 0) return result;
    const fetched = await this.inner.batch(missing.map((item) => item.call));
    if (fetched.length !== missing.length) {
      throw new FinalStateStorageBackendUnsupportedError(
        'Candidate-extension batch response length differs from the request.',
      );
    }
    for (const [index, item] of missing.entries()) {
      result[item.index] = await this.record(item.key, fetched[index]);
    }
    return result;
  }

  private async record(key: string, value: unknown): Promise<string | null> {
    const normalized = normalizeRawValue(value);
    mergeCachedValue(this.values, key, normalized, 'live candidate extension response');
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
          candidateExtensionSourceSha256: this.context.extensionSourceSha256,
        }) + '\n',
        'utf8',
      );
    }
    return normalized;
  }
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

function expectedOption<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

async function writeCandidateDiagnostics(
  directory: string,
  subscan: Awaited<ReturnType<typeof discoverCandidateAddresses>>,
  extension: CandidateExtensionImport,
  universe: CandidateUniverse,
  existingCache: FinalStats,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const sourceMap = universe.records.map((record) => ({
    address: record.address,
    sources: record.sources,
  }));
  const files: Record<string, string> = {
    'subscan-only.ndjson': serializeAddressRecords(universe.subscanOnly),
    'candidate-extension-only.ndjson': serializeAddressRecords(universe.extensionOnly),
    'new-addresses.ndjson': serializeAddressRecords(universe.extensionOnly),
    'intersection.ndjson': serializeAddressRecords(universe.intersection),
    'candidate-union.ndjson': serializeAddressRecords(universe.addresses),
    'candidate-source-map.ndjson': ndjson(sourceMap),
    'candidate-provenance.ndjson': serializeCandidateProvenance(universe.records),
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
        candidateExtension: {
          sourceFile: resolve(extension.sourceFile),
          sourceSha256: extension.sourceSha256,
          rowCount: extension.rowCount,
          validRowCount: extension.validRowCount,
          uniqueAddressCount: extension.uniqueAddressCount,
          duplicateCount: extension.duplicateCount,
          balancesAffectFinalState: false,
        },
      },
      reconciliation: {
        subscanOnlyCount: universe.subscanOnly.length,
        intersectionCount: universe.intersection.length,
        extensionOnlyCount: universe.extensionOnly.length,
        unionCount: universe.addresses.length,
        extensionOnlySha256: universe.extensionOnlySha256,
        unionSha256: universe.unionSha256,
      },
      existingFinalStateCache: {
        cachedAddressCount: existingCache.successful,
        cachedFinalSumPlanck: existingCache.sum.toString(10),
      },
    }),
  };
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      writeFile(join(directory, name), contents, 'utf8'),
    ),
  );
}

async function writeFinalStateDiagnostics(
  directory: string,
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
  await mkdir(directory, { recursive: true });
  const positiveText = ndjson(positive);
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
  const normalized = error instanceof XcDotError ? error : undefined;
  await mkdir(directory, { recursive: true });
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

async function enrichVerifiedOutput(
  result: DwellirFinalStateRecoveryResult,
  subscan: Awaited<ReturnType<typeof discoverCandidateAddresses>>,
  extension: CandidateExtensionImport,
  universe: CandidateUniverse,
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
      'Frozen Subscan discovery unioned with a generic candidate extension; balances diagnostic only',
    count: universe.addresses.length,
    subscanCount: subscan.addresses.length,
    extensionCount: extension.records.length,
    subscanOnlyCount: universe.subscanOnly.length,
    intersectionCount: universe.intersection.length,
    extensionOnlyCount: universe.extensionOnly.length,
    candidateAddressesSha256: universe.unionSha256,
    subscanCandidateAddressesSha256: universe.subscanAddressSha256,
    extensionOnlySha256: universe.extensionOnlySha256,
    extensionSourceSha256: extension.sourceSha256,
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

export async function recoverDwellirWithCandidateExtension(
  options: DwellirFinalStateRecoveryOptions,
): Promise<DwellirFinalStateRecoveryResult> {
  const progress = options.progress ?? (() => undefined);
  const subscan = await discoverCandidateAddresses(options.dataset ?? 'snapshots/subscan');
  const extension = await parseCandidateExtensionNdjson(resolve(options.candidateExtension!));
  const universe = buildCandidateUniverse(subscan, extension, EXTENSION_SOURCE);
  const expectedSubscanCount = expectedOption(
    options.expectedSubscanCandidateCount,
    EXPECTED_SUBSCAN_CANDIDATE_COUNT,
  );
  const expectedSubscanSha256 = expectedOption(
    options.expectedSubscanCandidateSha256,
    EXPECTED_SUBSCAN_CANDIDATE_SHA256,
  );
  if (
    subscan.addresses.length !== expectedSubscanCount ||
    universe.subscanAddressSha256 !== expectedSubscanSha256
  ) {
    throw new FinalStateIdentityMismatchError(
      'Subscan candidate discovery differs from the frozen candidate set.',
      {
        expectedSubscanCount,
        actualSubscanCount: subscan.addresses.length,
        expectedSubscanSha256,
        actualSubscanSha256: universe.subscanAddressSha256,
      },
    );
  }
  progress(
    `CANDIDATE_EXTENSION_UNION=PASS subscan=${subscan.addresses.length} extensionOnly=${universe.extensionOnly.length} union=${universe.addresses.length}`,
  );

  const baseWork = resolve(options.work ?? DEFAULT_WORK);
  const extensionName = `candidate-${extension.sourceSha256.slice(0, 16)}`;
  const extensionWork = join(baseWork, 'extensions', extensionName);
  const diffDirectory = resolve(options.candidateDiffOut ?? DEFAULT_DIFF_OUT);
  if (options.force || options.forceSourceChange)
    await rm(extensionWork, { recursive: true, force: true });
  const candidateInput = join(extensionWork, 'candidate-input');
  await mkdir(candidateInput, { recursive: true });
  await writeFile(
    join(candidateInput, 'provenance.ndjson'),
    serializeAddressRecords(universe.addresses),
    'utf8',
  );

  const unionKeys = universe.addresses.map((address) => ({
    address,
    ...deriveBalanceAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, address, 0n),
  }));
  const addressByKey = new Map(unionKeys.map((item) => [item.substrateStorageKey, item.address]));
  const values = await loadAllKnownCaches(baseWork, MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH);
  const context: ExtensionContext = {
    schemaVersion: 1,
    source: EXTENSION_SOURCE,
    chainId: 1284,
    blockNumber: MOONBEAM_FINAL_BLOCK_NUMBER,
    blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
    evmBlockHash: MOONBEAM_OBSERVED_EVM_BLOCK_HASH,
    contract: XC_DOT_XC20_ADDRESS,
    balancesSlot: '0',
    totalSupplyPlanck: options.expectedTotalSupplyPlanck ?? EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
    candidateAddressesSha256: universe.unionSha256,
    extensionOnlyCount: universe.extensionOnly.length,
    extensionOnlySha256: universe.extensionOnlySha256,
    extensionSourceSha256: extension.sourceSha256,
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
      'extensionOnlyCount',
      'extensionOnlySha256',
      'extensionSourceSha256',
    ] as const) {
      if (previous[field] !== context[field] && !options.forceSourceChange) {
        throw new FinalStateIdentityMismatchError(
          'Candidate-extension resume context differs from the pinned run.',
          { field, expected: String(context[field]), actual: String(previous[field]) },
        );
      }
    }
  }
  await atomicWrite(contextPath, json(context));
  const resultsPath = join(extensionWork, 'results.ndjson');
  if (!(await pathExists(resultsPath))) await writeFile(resultsPath, '', 'utf8');

  const cachedSubscanKeys = subscan.addresses.map((address) => ({
    address,
    ...deriveBalanceAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, address, 0n),
  }));
  const extensionResultCount = await loadCandidateExtensionResults(
    resultsPath,
    values,
    addressByKey,
    context,
  );
  const cachedStats = readCachedStats(values, cachedSubscanKeys);
  const expectedCachedCount = expectedOption(
    options.expectedExistingCachedAddressCount,
    EXPECTED_SUBSCAN_CANDIDATE_COUNT,
  );
  const expectedCachedSum = BigInt(
    options.expectedExistingFinalSumPlanck ?? EXPECTED_SUBSCAN_CACHED_FINAL_SUM_PLANCK,
  );
  if (cachedStats.successful !== expectedCachedCount || cachedStats.sum !== expectedCachedSum) {
    throw new FinalStateIdentityMismatchError(
      'Existing final-state cache does not match the frozen Subscan cache.',
      {
        expectedCachedAddressCount: expectedCachedCount,
        actualCachedAddressCount: cachedStats.successful,
        expectedCachedFinalSumPlanck: expectedCachedSum.toString(10),
        actualCachedFinalSumPlanck: cachedStats.sum.toString(10),
      },
    );
  }
  progress(
    `CACHE_REUSE=PASS cached=${cachedStats.successful} cachedSum=${cachedStats.sum.toString(10)} extensionResults=${extensionResultCount}`,
  );
  await writeCandidateDiagnostics(diffDirectory, subscan, extension, universe, cachedStats);

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
  const cachedTransport = new CachedCandidateExtensionTransport(
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
    expectedCandidateCount: universe.addresses.length,
    expectedCandidateSha256: universe.unionSha256,
    transport: cachedTransport,
    force: false,
    retainWorkDirectory: true,
  };
  delete baseOptions.candidateExtension;
  progress(
    `FINAL_STATE_RECONSTRUCTION=START union=${universe.addresses.length} extensionOnly=${universe.extensionOnly.length}`,
  );
  try {
    const result = await recoverDwellirFinalStateBase(baseOptions);
    return enrichVerifiedOutput(result, subscan, extension, universe, options);
  } catch (error) {
    const stats = readCachedStats(values, unionKeys);
    const status =
      error instanceof FinalStateSupplyShortfallError
        ? 'FINAL_STATE_SUPPLY_SHORTFALL'
        : error instanceof FinalStateSupplyOverflowError
          ? 'FINAL_STATE_SUPPLY_OVERFLOW'
          : error instanceof FinalStateStorageBackendUnsupportedError
            ? 'FINAL_STATE_INCOMPLETE'
            : undefined;
    if (status === undefined) throw error;
    await writeFinalStateDiagnostics(diffDirectory, subscan, values, unionKeys, stats);
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
