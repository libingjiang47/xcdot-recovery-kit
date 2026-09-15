import { appendFile, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  createPublicClient,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { XC_DOT_DECIMALS, XC_DOT_SYMBOL, XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import {
  EXPECTED_SUBSCAN_CANDIDATE_COUNT,
  EXPECTED_XC_DOT_CODE_HASH,
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
  RANK565_HISTORICAL_BALANCE_PLANCK,
} from '../final-state/constants.js';
import {
  candidateAddressesSha256,
  discoverCandidateAddresses,
  serializeCandidateAddresses,
  type CandidateDiscovery,
} from '../subscan/candidates.js';
import {
  FinalStateBalanceConflictError,
  FinalStateDiscoveryPartialError,
  FinalStateIdentityMismatchError,
  FinalStateOutputExistsError,
  FinalStateResumeContextMismatchError,
  FinalStateSupplyChangedError,
  XcDotError,
} from '../utils/errors.js';
import { compareCanonicalStrings } from '../utils/order.js';
import { sha256Hex } from '../snapshot/digest.js';

export const FINAL_STATE_ABI = [
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

export type FinalStateFunction = 'symbol' | 'decimals' | 'totalSupply' | 'balanceOf';

export interface FinalStateEvmClient {
  getChainId(): Promise<number>;
  getBlock(args: {
    blockNumber: bigint;
  }): Promise<{ number: bigint | null; hash: Hex | null; stateRoot?: Hex | null }>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  readContract(args: {
    address: Address;
    functionName: FinalStateFunction;
    blockNumber: bigint;
    args?: readonly [Address];
  }): Promise<unknown>;
}

function wrapPublicClient(client: PublicClient): FinalStateEvmClient {
  return {
    getChainId: () => client.getChainId(),
    getBlock: async ({ blockNumber }) => {
      const block = await client.getBlock({ blockNumber });
      return {
        number: block.number,
        hash: block.hash,
        ...((block as { stateRoot?: Hex | null }).stateRoot === undefined
          ? {}
          : { stateRoot: (block as { stateRoot?: Hex | null }).stateRoot }),
      };
    },
    getCode: ({ address, blockNumber }) => client.getCode({ address, blockNumber }),
    readContract: async ({ address, functionName, blockNumber, args }) =>
      client.readContract({
        address,
        abi: FINAL_STATE_ABI,
        functionName,
        blockNumber,
        ...(args ? { args } : {}),
      }),
  };
}

export function createFinalStateEvmClient(rpc: string, timeoutMs = 15_000): FinalStateEvmClient {
  if (!rpc) throw new FinalStateIdentityMismatchError('An EVM RPC endpoint is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new FinalStateIdentityMismatchError(
      'EVM timeout must be an integer from 1 to 120000 ms.',
      {
        timeoutMs,
      },
    );
  }
  try {
    return wrapPublicClient(
      createPublicClient({
        transport: http(rpc, { timeout: timeoutMs, retryCount: 0 }),
      }),
    );
  } catch (error) {
    throw new FinalStateIdentityMismatchError(
      `Could not create the EVM RPC client: ${String(error)}`,
      { rpc },
    );
  }
}

export interface RetryOptions {
  attempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function errorText(error: unknown): string {
  if (error instanceof XcDotError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as {
    status?: unknown;
    details?: { status?: unknown };
    response?: { status?: unknown };
  };
  for (const value of [record.status, record.response?.status, record.details?.status]) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}

export function isTransientFinalStateError(error: unknown): boolean {
  const status = statusCode(error);
  if (status !== undefined && [429, 502, 503, 504].includes(status)) return true;
  return /timeout|timed out|network|fetch failed|socket|econn|temporar|rate.?limit|429|502|503|504/i.test(
    errorText(error),
  );
}

export async function retryFinalStateRpc<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new FinalStateIdentityMismatchError('RPC attempts must be an integer from 1 to 10.', {
      attempts,
    });
  }
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientFinalStateError(error) || attempt === attempts - 1) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

export interface FinalStatePreflight {
  chainId: number;
  blockNumber: string;
  evmBlockHash: string;
  evmStateRoot?: string;
  contract: string;
  codeHash: string;
  codeSize: number;
  symbol: string;
  decimals: number;
  zeroAddressBalancePlanck: string;
  totalSupplyPlanck: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

function exactU256(value: unknown): bigint | undefined {
  if (typeof value === 'bigint' && value >= 0n && value <= (1n << 256n) - 1n) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = BigInt(value);
    return parsed <= (1n << 256n) - 1n ? parsed : undefined;
  }
  return undefined;
}

function exactDecimals(value: unknown): number | undefined {
  const parsed =
    typeof value === 'bigint'
      ? value
      : typeof value === 'number' && Number.isInteger(value)
        ? BigInt(value)
        : undefined;
  if (parsed === undefined || parsed < 0n || parsed > 255n) return undefined;
  return Number(parsed);
}

function normalizeBlockNumber(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new FinalStateIdentityMismatchError('Block number must be an unsigned decimal integer.', {
      blockNumber: value,
    });
  }
  return BigInt(value).toString(10);
}

function normalizeHash(value: string | null | undefined, label: string): string {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new FinalStateIdentityMismatchError(`EVM RPC returned an invalid ${label}.`, {
      value: value ?? 'null',
    });
  }
  return value.toLowerCase();
}

export async function preflightFinalStateEvm(
  client: FinalStateEvmClient,
  blockNumberText: string,
  options: {
    attempts?: number;
    expectedTotalSupplyPlanck?: string;
    expectedCodeHash?: string;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<FinalStatePreflight> {
  const blockNumber = normalizeBlockNumber(blockNumberText);
  const block = BigInt(blockNumber);
  const retry = <T>(operation: () => Promise<T>): Promise<T> =>
    retryFinalStateRpc(operation, {
      ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  const chainId = await retry(() => client.getChainId());
  if (chainId !== 1284) {
    throw new FinalStateIdentityMismatchError('EVM RPC is not Moonbeam mainnet.', {
      expectedChainId: 1284,
      actualChainId: chainId,
    });
  }
  const pinnedBlock = await retry(() => client.getBlock({ blockNumber: block }));
  if (pinnedBlock.number !== block) {
    throw new FinalStateIdentityMismatchError('EVM RPC returned a different block number.', {
      expectedBlockNumber: blockNumber,
      actualBlockNumber: pinnedBlock.number?.toString(10) ?? 'null',
    });
  }
  const evmBlockHash = normalizeHash(pinnedBlock.hash, 'block hash');
  const evmStateRoot =
    pinnedBlock.stateRoot === undefined || pinnedBlock.stateRoot === null
      ? undefined
      : normalizeHash(pinnedBlock.stateRoot, 'state root');
  const code = await retry(() =>
    client.getCode({ address: XC_DOT_XC20_ADDRESS as Address, blockNumber: block }),
  );
  if (!code || code === '0x') {
    throw new FinalStateIdentityMismatchError(
      'xcDOT contract has no runtime code at the pinned block.',
      {
        contract: XC_DOT_XC20_ADDRESS,
      },
    );
  }
  if (!/^0x[0-9a-fA-F]*$/.test(code) || (code.length - 2) % 2 !== 0) {
    throw new FinalStateIdentityMismatchError('xcDOT contract code is not valid bytecode.');
  }
  const codeHash = keccak256(code).toLowerCase();
  if (
    options.expectedCodeHash !== undefined &&
    codeHash !== options.expectedCodeHash.toLowerCase()
  ) {
    throw new FinalStateIdentityMismatchError(
      'xcDOT contract code hash changed at the pinned block.',
      {
        expectedCodeHash: options.expectedCodeHash,
        actualCodeHash: codeHash,
      },
    );
  }
  const symbolRaw = await retry(() =>
    client.readContract({
      address: XC_DOT_XC20_ADDRESS as Address,
      functionName: 'symbol',
      blockNumber: block,
    }),
  );
  const decimalsRaw = await retry(() =>
    client.readContract({
      address: XC_DOT_XC20_ADDRESS as Address,
      functionName: 'decimals',
      blockNumber: block,
    }),
  );
  const totalRaw = await retry(() =>
    client.readContract({
      address: XC_DOT_XC20_ADDRESS as Address,
      functionName: 'totalSupply',
      blockNumber: block,
    }),
  );
  const zeroRaw = await retry(() =>
    client.readContract({
      address: XC_DOT_XC20_ADDRESS as Address,
      functionName: 'balanceOf',
      args: [ZERO_ADDRESS],
      blockNumber: block,
    }),
  );
  const symbol = typeof symbolRaw === 'string' ? symbolRaw : undefined;
  const decimals = exactDecimals(decimalsRaw);
  const totalSupply = exactU256(totalRaw);
  const zeroBalance = exactU256(zeroRaw);
  if (symbol !== XC_DOT_SYMBOL || decimals !== XC_DOT_DECIMALS) {
    throw new FinalStateIdentityMismatchError(
      'xcDOT contract metadata does not match expected identity.',
      {
        expectedSymbol: XC_DOT_SYMBOL,
        actualSymbol: symbol ?? 'invalid',
        expectedDecimals: XC_DOT_DECIMALS,
        actualDecimals: decimals ?? 'invalid',
      },
    );
  }
  if (totalSupply === undefined) {
    throw new FinalStateIdentityMismatchError('totalSupply() did not return an unsigned U256.');
  }
  if (zeroBalance === undefined) {
    throw new FinalStateIdentityMismatchError('balanceOf(0x0) did not return an unsigned U256.');
  }
  if (zeroBalance !== 0n) {
    throw new FinalStateIdentityMismatchError('xcDOT zero-address balance is not zero.', {
      actual: zeroBalance.toString(10),
    });
  }
  const totalSupplyPlanck = totalSupply.toString(10);
  if (
    options.expectedTotalSupplyPlanck !== undefined &&
    totalSupplyPlanck !== options.expectedTotalSupplyPlanck
  ) {
    throw new FinalStateSupplyChangedError(
      'xcDOT totalSupply changed from the expected pinned value.',
      {
        expectedTotalSupply: options.expectedTotalSupplyPlanck,
        actualTotalSupply: totalSupplyPlanck,
      },
    );
  }
  return {
    chainId,
    blockNumber,
    evmBlockHash,
    ...(evmStateRoot === undefined ? {} : { evmStateRoot }),
    contract: XC_DOT_XC20_ADDRESS,
    codeHash,
    codeSize: (code.length - 2) / 2,
    symbol,
    decimals,
    zeroAddressBalancePlanck: zeroBalance.toString(10),
    totalSupplyPlanck,
  };
}

export type FinalStateResultStatus = 'SUCCESS' | 'RPC_ERROR' | 'INVALID_RESULT';

export interface FinalStateBalanceResult {
  address: string;
  status: FinalStateResultStatus;
  finalBalancePlanck?: string;
  error?: string;
}

export interface FinalStateCheckpointContext {
  schemaVersion: 1;
  candidateAddressesSha256: string;
  contract: string;
  chainId: number;
  blockNumber: string;
  evmBlockHash: string;
  totalSupplyPlanck: string;
}

export interface FinalStateCheckpoint {
  schemaVersion: 1;
  context: FinalStateCheckpointContext;
  updatedAt: string;
  successfulCount: number;
  rpcErrorCount: number;
  invalidResultCount: number;
  attemptedCount: number;
}

export interface FinalStateSummary {
  schemaVersion: 1;
  chain: {
    name: 'Moonbeam';
    chainId: number;
    blockNumber: string;
    evmBlockHash: string;
    evmStateRoot?: string;
    substrateBlockHash: string;
    substrateStateRoot: string;
  };
  asset: {
    symbol: string;
    decimals: number;
    contract: string;
    codeHash: string;
    codeSize: number;
    totalSupplyPlanck: string;
    zeroAddressBalancePlanck: string;
  };
  candidateSet: {
    source: 'Moonbeam Subscan address discovery';
    knownValidUniqueAddresses: number;
    candidateAddressesSha256: string;
    rawFileCount: number;
    rawRowCount: number;
    validRowCount: number;
    invalidRowCount: number;
    exactDuplicateAddressCount: number;
    rawDatasetDigest?: string;
  };
  finalState: {
    queried: number;
    successful: number;
    rpcErrors: number;
    invalidResults: number;
    remaining: number;
    positive: number;
    zero: number;
    knownFinalSumPlanck: string;
    unaccountedSupplyPlanck: string | null;
    subscanBalanceMatchCount: number;
    subscanBalanceMismatchCount: number;
  };
  rank565: {
    historicalBalancePlanck: string;
    requiredForFinalCompleteness: boolean | null;
  };
  status:
    | 'FINAL_STATE_RECONSTRUCTION_IN_PROGRESS'
    | 'FINAL_STATE_RPC_VERIFIED'
    | 'FINAL_STATE_SUPPLY_SHORTFALL'
    | 'FINAL_STATE_SUPPLY_OVERFLOW'
    | 'FINAL_STATE_INCOMPLETE';
}

export interface FinalStateReconstructionOptions {
  dataset: string;
  evmRpc: string;
  blockNumber: string;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  delayMs?: number;
  resume?: boolean;
  out?: string;
  force?: boolean;
  expectedTotalSupplyPlanck?: string;
  expectedCodeHash?: string;
  expectedCandidateCount?: number;
  substrateBlockHash?: string;
  substrateStateRoot?: string;
  workDirectory?: string;
}

export interface FinalStateReconstructionResult {
  outputDirectory: string;
  status: FinalStateSummary['status'];
  summary: FinalStateSummary;
  preflight: FinalStatePreflight;
  discovery: CandidateDiscovery;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function serializeResult(result: FinalStateBalanceResult): string {
  if (result.status === 'SUCCESS') {
    return JSON.stringify({
      address: result.address,
      finalBalancePlanck: result.finalBalancePlanck,
      status: result.status,
    });
  }
  return JSON.stringify({
    address: result.address,
    status: result.status,
    error: result.error ?? 'unknown error',
  });
}

function resultNdjson(results: readonly FinalStateBalanceResult[]): string {
  return results.length > 0 ? results.map(serializeResult).join('\n') + '\n' : '';
}

function positiveNdjson(results: readonly FinalStateBalanceResult[]): string {
  const positive = results
    .filter(
      (result): result is FinalStateBalanceResult & { finalBalancePlanck: string } =>
        result.status === 'SUCCESS' &&
        result.finalBalancePlanck !== undefined &&
        BigInt(result.finalBalancePlanck) > 0n,
    )
    .map((result) => ({ address: result.address, balancePlanck: result.finalBalancePlanck }))
    .sort((a, b) => compareCanonicalStrings(a.address, b.address));
  return positive.length > 0
    ? positive.map((record) => JSON.stringify(record)).join('\n') + '\n'
    : '';
}

function zeroNdjson(results: readonly FinalStateBalanceResult[]): string {
  const zero = results
    .filter((result) => result.status === 'SUCCESS' && result.finalBalancePlanck === '0')
    .map((result) => ({ address: result.address }))
    .sort((a, b) => compareCanonicalStrings(a.address, b.address));
  return zero.length > 0 ? zero.map((record) => JSON.stringify(record)).join('\n') + '\n' : '';
}

function sumSuccessful(results: readonly FinalStateBalanceResult[]): bigint {
  return results.reduce(
    (sum, result) =>
      sum +
      (result.status === 'SUCCESS' && result.finalBalancePlanck !== undefined
        ? BigInt(result.finalBalancePlanck)
        : 0n),
    0n,
  );
}

function subscanDiffNdjson(
  results: readonly FinalStateBalanceResult[],
  sourceBalances: ReadonlyMap<string, string>,
): { text: string; matches: number; mismatches: number } {
  let matches = 0;
  let mismatches = 0;
  const records = results
    .filter(
      (result): result is FinalStateBalanceResult & { finalBalancePlanck: string } =>
        result.status === 'SUCCESS' &&
        result.finalBalancePlanck !== undefined &&
        sourceBalances.has(result.address),
    )
    .map((result) => {
      const subscanBalancePlanck = sourceBalances.get(result.address) as string;
      const finalBalancePlanck = result.finalBalancePlanck;
      if (subscanBalancePlanck === finalBalancePlanck) matches += 1;
      else mismatches += 1;
      return {
        address: result.address,
        subscanBalancePlanck,
        finalBalancePlanck,
        deltaPlanck: (BigInt(finalBalancePlanck) - BigInt(subscanBalancePlanck)).toString(10),
      };
    })
    .sort((a, b) => compareCanonicalStrings(a.address, b.address));
  return {
    text:
      records.length > 0 ? records.map((record) => JSON.stringify(record)).join('\n') + '\n' : '',
    matches,
    mismatches,
  };
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let handle;
  try {
    handle = await open(temporary, 'w');
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    throw new FinalStateResumeContextMismatchError(`Could not read checkpoint ${path}.`, {
      path,
      error: errorText(error),
    });
  }
}

function assertCheckpointContext(
  actual: FinalStateCheckpointContext,
  expected: FinalStateCheckpointContext,
): void {
  const keys: Array<keyof FinalStateCheckpointContext> = [
    'schemaVersion',
    'candidateAddressesSha256',
    'contract',
    'chainId',
    'blockNumber',
    'evmBlockHash',
    'totalSupplyPlanck',
  ];
  for (const key of keys) {
    if (actual[key] !== expected[key]) {
      throw new FinalStateResumeContextMismatchError(
        'Final-state checkpoint belongs to a different pinned reconstruction context.',
        { field: key, expected: String(expected[key]), actual: String(actual[key]) },
      );
    }
  }
}

function parseCheckpointResult(value: unknown, lineNumber: number): FinalStateBalanceResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FinalStateResumeContextMismatchError(
      'Final-state results contain a non-object record.',
      {
        lineNumber,
      },
    );
  }
  const record = value as {
    address?: unknown;
    status?: unknown;
    finalBalancePlanck?: unknown;
    error?: unknown;
  };
  if (typeof record.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(record.address)) {
    throw new FinalStateResumeContextMismatchError(
      'Final-state results contain an invalid address.',
      {
        lineNumber,
      },
    );
  }
  const address = record.address.toLowerCase();
  if (record.status === 'SUCCESS') {
    if (
      typeof record.finalBalancePlanck !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(record.finalBalancePlanck)
    ) {
      throw new FinalStateResumeContextMismatchError(
        'Successful final-state result has an invalid balance.',
        {
          lineNumber,
          address,
        },
      );
    }
    return { address, status: 'SUCCESS', finalBalancePlanck: record.finalBalancePlanck };
  }
  if (record.status === 'RPC_ERROR' || record.status === 'INVALID_RESULT') {
    return {
      address,
      status: record.status,
      error: typeof record.error === 'string' ? record.error : 'unknown error',
    };
  }
  throw new FinalStateResumeContextMismatchError('Final-state results contain an unknown status.', {
    lineNumber,
    address,
  });
}

async function loadCheckpointResults(
  resultsPath: string,
  addresses: ReadonlySet<string>,
): Promise<{
  successful: Map<string, FinalStateBalanceResult>;
  latest: Map<string, FinalStateBalanceResult>;
}> {
  const successful = new Map<string, FinalStateBalanceResult>();
  const latest = new Map<string, FinalStateBalanceResult>();
  let text: string;
  try {
    text = await readFile(resultsPath, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { successful, latest };
    throw new FinalStateResumeContextMismatchError(
      `Could not read final-state results ${resultsPath}.`,
      {
        path: resultsPath,
        error: errorText(error),
      },
    );
  }
  if (text !== '' && !text.endsWith('\n')) {
    throw new FinalStateResumeContextMismatchError('Final-state results must end with LF.', {
      path: resultsPath,
    });
  }
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '') continue;
    let result: FinalStateBalanceResult;
    try {
      result = parseCheckpointResult(JSON.parse(line) as unknown, index + 1);
    } catch (error) {
      if (error instanceof XcDotError) throw error;
      throw new FinalStateResumeContextMismatchError('Final-state results contain invalid JSON.', {
        lineNumber: index + 1,
        error: errorText(error),
      });
    }
    if (!addresses.has(result.address)) {
      throw new FinalStateResumeContextMismatchError(
        'Checkpoint contains an address outside the candidate set.',
        {
          address: result.address,
        },
      );
    }
    const previous = successful.get(result.address);
    if (result.status === 'SUCCESS') {
      if (previous !== undefined && previous.finalBalancePlanck !== result.finalBalancePlanck) {
        throw new FinalStateBalanceConflictError(
          'Conflicting successful balance results exist for the same address at the pinned block.',
          {
            address: result.address,
            first: previous.finalBalancePlanck ?? 'missing',
            second: result.finalBalancePlanck ?? 'missing',
          },
        );
      }
      successful.set(result.address, result);
    }
    latest.set(result.address, result);
  }
  return { successful, latest };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(root, path).split('\\').join('/'));
    }
  }
  await visit(root);
  return files.sort(compareCanonicalStrings);
}

async function writeSums(root: string): Promise<void> {
  const files = (await listFiles(root)).filter((file) => file !== 'SHA256SUMS');
  const lines: string[] = [];
  for (const file of files) lines.push(`${sha256Hex(await readFile(join(root, file)))}  ${file}`);
  await writeAtomic(join(root, 'SHA256SUMS'), lines.join('\n') + (lines.length > 0 ? '\n' : ''));
}

async function writeFinalArtifacts(
  outputDirectory: string,
  discovery: CandidateDiscovery,
  preflight: FinalStatePreflight,
  results: readonly FinalStateBalanceResult[],
  status: FinalStateSummary['status'],
  options: FinalStateReconstructionOptions,
): Promise<FinalStateSummary> {
  const evmDirectory = join(outputDirectory, 'evm-rpc');
  await mkdir(evmDirectory, { recursive: true });
  const candidateText = serializeCandidateAddresses(discovery.addresses);
  const candidateDigest = candidateAddressesSha256(discovery.addresses);
  await writeAtomic(join(outputDirectory, 'candidate-addresses.ndjson'), candidateText);
  await writeAtomic(join(outputDirectory, 'candidate-addresses.sha256'), candidateDigest + '\n');
  const finalResults = [...results].sort((a, b) => compareCanonicalStrings(a.address, b.address));
  const successful = finalResults.filter((result) => result.status === 'SUCCESS');
  const rpcErrors = finalResults.filter((result) => result.status === 'RPC_ERROR');
  const invalidResults = finalResults.filter((result) => result.status === 'INVALID_RESULT');
  const finalSum = sumSuccessful(finalResults);
  const complete =
    finalResults.length === discovery.addresses.length &&
    rpcErrors.length === 0 &&
    invalidResults.length === 0;
  const unaccounted = complete
    ? (BigInt(preflight.totalSupplyPlanck) - finalSum).toString(10)
    : null;
  const diff = subscanDiffNdjson(finalResults, discovery.sourceBalances);
  const expectedCandidateCount = options.expectedCandidateCount ?? EXPECTED_SUBSCAN_CANDIDATE_COUNT;
  const summary: FinalStateSummary = {
    schemaVersion: 1,
    chain: {
      name: 'Moonbeam',
      chainId: preflight.chainId,
      blockNumber: preflight.blockNumber,
      evmBlockHash: preflight.evmBlockHash,
      ...(preflight.evmStateRoot === undefined ? {} : { evmStateRoot: preflight.evmStateRoot }),
      substrateBlockHash: options.substrateBlockHash ?? MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
      substrateStateRoot: options.substrateStateRoot ?? MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
    },
    asset: {
      symbol: preflight.symbol,
      decimals: preflight.decimals,
      contract: preflight.contract,
      codeHash: preflight.codeHash,
      codeSize: preflight.codeSize,
      totalSupplyPlanck: preflight.totalSupplyPlanck,
      zeroAddressBalancePlanck: preflight.zeroAddressBalancePlanck,
    },
    candidateSet: {
      source: 'Moonbeam Subscan address discovery',
      knownValidUniqueAddresses: discovery.uniqueValidAddressCount,
      candidateAddressesSha256: candidateDigest,
      rawFileCount: discovery.rawFileCount,
      rawRowCount: discovery.rawRowCount,
      validRowCount: discovery.validRowCount,
      invalidRowCount: discovery.invalidRowCount,
      exactDuplicateAddressCount: discovery.exactDuplicateAddressCount,
      ...(discovery.rawDatasetDigest === undefined
        ? {}
        : { rawDatasetDigest: discovery.rawDatasetDigest }),
    },
    finalState: {
      queried: finalResults.length,
      successful: successful.length,
      rpcErrors: rpcErrors.length,
      invalidResults: invalidResults.length,
      remaining: discovery.addresses.length - finalResults.length,
      positive: successful.filter((result) => result.finalBalancePlanck !== '0').length,
      zero: successful.filter((result) => result.finalBalancePlanck === '0').length,
      knownFinalSumPlanck: finalSum.toString(10),
      unaccountedSupplyPlanck: unaccounted,
      subscanBalanceMatchCount: diff.matches,
      subscanBalanceMismatchCount: diff.mismatches,
    },
    rank565: {
      historicalBalancePlanck: RANK565_HISTORICAL_BALANCE_PLANCK,
      requiredForFinalCompleteness:
        unaccounted === null
          ? null
          : unaccounted === '0'
            ? false
            : unaccounted === RANK565_HISTORICAL_BALANCE_PLANCK
              ? true
              : null,
    },
    status,
  };
  await writeAtomic(
    join(evmDirectory, 'contract-state.json'),
    json({ schemaVersion: 1, ...preflight }),
  );
  await writeAtomic(join(evmDirectory, 'balances.ndjson'), resultNdjson(finalResults));
  if (complete) {
    await writeAtomic(join(evmDirectory, 'positive-holders.ndjson'), positiveNdjson(finalResults));
    await writeAtomic(
      join(evmDirectory, 'zero-balance-candidates.ndjson'),
      zeroNdjson(finalResults),
    );
    await writeAtomic(join(evmDirectory, 'subscan-vs-final.ndjson'), diff.text);
  } else {
    for (const name of [
      'positive-holders.ndjson',
      'zero-balance-candidates.ndjson',
      'subscan-vs-final.ndjson',
    ]) {
      await rm(join(evmDirectory, name), { force: true });
    }
  }
  await writeAtomic(join(evmDirectory, 'summary.json'), json(summary));
  const manifest = {
    schemaVersion: 1,
    artifact: 'xcdot-final-state-v0.26',
    status,
    candidateAddressesSha256: candidateDigest,
    blockNumber: preflight.blockNumber,
    evmBlockHash: preflight.evmBlockHash,
    contract: preflight.contract,
    totalSupplyPlanck: preflight.totalSupplyPlanck,
    expectedCandidateCount,
    generatedFiles: await listFiles(outputDirectory),
  };
  await writeAtomic(join(outputDirectory, 'manifest.json'), json(manifest));
  await writeSums(outputDirectory);
  return summary;
}

export async function reconstructFinalState(
  options: FinalStateReconstructionOptions,
  client: FinalStateEvmClient = createFinalStateEvmClient(
    options.evmRpc,
    options.timeoutMs ?? 15_000,
  ),
  emitProgress: (message: string) => void = (message) => console.error(message),
): Promise<FinalStateReconstructionResult> {
  const concurrency = options.concurrency ?? 1;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 5;
  const delayMs = options.delayMs ?? 100;
  const expectedCandidateCount = options.expectedCandidateCount ?? EXPECTED_SUBSCAN_CANDIDATE_COUNT;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new FinalStateIdentityMismatchError('Concurrency must be an integer between 1 and 8.', {
      concurrency,
    });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new FinalStateIdentityMismatchError('Timeout must be an integer from 1 to 120000 ms.', {
      timeoutMs,
    });
  }
  if (!Number.isInteger(retries) || retries < 1 || retries > 10) {
    throw new FinalStateIdentityMismatchError('Retries must be an integer from 1 to 10.', {
      retries,
    });
  }
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5000) {
    throw new FinalStateIdentityMismatchError('Delay must be an integer from 0 to 5000 ms.', {
      delayMs,
    });
  }
  if (!Number.isInteger(expectedCandidateCount) || expectedCandidateCount < 1) {
    throw new FinalStateIdentityMismatchError(
      'Expected candidate count must be a positive integer.',
      {
        expectedCandidateCount,
      },
    );
  }
  const blockNumber = normalizeBlockNumber(options.blockNumber);
  const outputDirectory = resolve(options.out ?? `snapshots/final-state/moonbeam-${blockNumber}`);
  const workDirectory = resolve(options.workDirectory ?? 'work/final-state');
  if (await pathExists(outputDirectory)) {
    if (!options.force && !options.resume) {
      throw new FinalStateOutputExistsError(
        `Final-state output already exists: ${outputDirectory}; use --resume or --force.`,
        { outputDirectory },
      );
    }
  }
  const discovery = await discoverCandidateAddresses(options.dataset);
  const candidateText = serializeCandidateAddresses(discovery.addresses);
  const candidateDigest = candidateAddressesSha256(discovery.addresses);
  await mkdir(outputDirectory, { recursive: true });
  await writeAtomic(join(outputDirectory, 'candidate-addresses.ndjson'), candidateText);
  await writeAtomic(join(outputDirectory, 'candidate-addresses.sha256'), candidateDigest + '\n');
  if (discovery.uniqueValidAddressCount !== expectedCandidateCount) {
    throw new FinalStateDiscoveryPartialError(
      'Subscan candidate discovery count differs from the expected recovery set.',
      {
        expectedCandidateCount,
        actualCandidateCount: discovery.uniqueValidAddressCount,
        status: 'SUBSCAN_DISCOVERY_PARTIAL',
      },
    );
  }
  const preflight = await preflightFinalStateEvm(client, blockNumber, {
    attempts: retries,
    ...(options.expectedTotalSupplyPlanck === undefined
      ? {}
      : { expectedTotalSupplyPlanck: options.expectedTotalSupplyPlanck }),
    ...(options.expectedCodeHash === undefined
      ? {}
      : { expectedCodeHash: options.expectedCodeHash }),
  });
  const context: FinalStateCheckpointContext = {
    schemaVersion: 1,
    candidateAddressesSha256: candidateDigest,
    contract: preflight.contract,
    chainId: preflight.chainId,
    blockNumber: preflight.blockNumber,
    evmBlockHash: preflight.evmBlockHash,
    totalSupplyPlanck: preflight.totalSupplyPlanck,
  };
  const resultsPath = join(workDirectory, 'results.ndjson');
  const checkpointPath = join(workDirectory, 'checkpoint.json');
  if (!options.resume && options.force) await rm(workDirectory, { recursive: true, force: true });
  if (
    !options.resume &&
    !options.force &&
    ((await pathExists(resultsPath)) || (await pathExists(checkpointPath)))
  ) {
    throw new FinalStateResumeContextMismatchError(
      `Final-state work already exists; use --resume or --force: ${workDirectory}`,
      { workDirectory },
    );
  }
  await mkdir(workDirectory, { recursive: true });
  if (options.resume && !(await pathExists(checkpointPath)) && (await pathExists(resultsPath))) {
    throw new FinalStateResumeContextMismatchError('Results exist without a checkpoint.', {
      resultsPath,
    });
  }
  if (options.resume && (await pathExists(checkpointPath))) {
    const checkpoint = await readJsonFile<FinalStateCheckpoint>(checkpointPath);
    if (checkpoint.schemaVersion !== 1) {
      throw new FinalStateResumeContextMismatchError('Unsupported final-state checkpoint schema.', {
        checkpointPath,
      });
    }
    assertCheckpointContext(checkpoint.context, context);
  }
  const addresses = discovery.addresses;
  const addressSet = new Set(addresses);
  const loaded = await loadCheckpointResults(resultsPath, addressSet);
  const successful = loaded.successful;
  const latest = loaded.latest;
  let appendChain = Promise.resolve();
  const sleep = (milliseconds: number): Promise<void> =>
    new Promise<void>((done) => setTimeout(done, milliseconds));
  const persist = async (result: FinalStateBalanceResult): Promise<void> => {
    latest.set(result.address, result);
    if (result.status === 'SUCCESS') successful.set(result.address, result);
    appendChain = appendChain.then(async () => {
      await appendFile(resultsPath, serializeResult(result) + '\n', 'utf8');
      const terminal = [...latest.values()];
      await writeAtomic(
        checkpointPath,
        json({
          schemaVersion: 1,
          context,
          updatedAt: new Date().toISOString(),
          successfulCount: terminal.filter((item) => item.status === 'SUCCESS').length,
          rpcErrorCount: terminal.filter((item) => item.status === 'RPC_ERROR').length,
          invalidResultCount: terminal.filter((item) => item.status === 'INVALID_RESULT').length,
          attemptedCount: terminal.length,
        } satisfies FinalStateCheckpoint),
      );
    });
    await appendChain;
  };
  const pending = addresses.filter((address) => !successful.has(address));
  emitProgress(
    `[final-state] verified=${successful.size}/${addresses.length} positive=${[...successful.values()].filter((item) => item.finalBalancePlanck !== '0').length} zero=${[...successful.values()].filter((item) => item.finalBalancePlanck === '0').length} remaining=${pending.length} errors=${[...latest.values()].filter((item) => item.status !== 'SUCCESS').length}`,
  );
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const address = pending[index];
      if (address === undefined) return;
      if (concurrency === 1 && delayMs > 0) await sleep(delayMs);
      let result: FinalStateBalanceResult;
      try {
        const raw = await retryFinalStateRpc(
          () =>
            client.readContract({
              address: XC_DOT_XC20_ADDRESS as Address,
              functionName: 'balanceOf',
              args: [address as Address],
              blockNumber: BigInt(blockNumber),
            }),
          { attempts: retries },
        );
        const balance = exactU256(raw);
        result =
          balance === undefined
            ? {
                address,
                status: 'INVALID_RESULT',
                error: 'balanceOf did not return an unsigned U256',
              }
            : { address, status: 'SUCCESS', finalBalancePlanck: balance.toString(10) };
      } catch (error) {
        result = { address, status: 'RPC_ERROR', error: errorText(error) };
      }
      await persist(result);
      if (
        (successful.size +
          [...latest.values()].filter((item) => item.status !== 'SUCCESS').length) %
          100 ===
          0 ||
        successful.size +
          [...latest.values()].filter((item) => item.status !== 'SUCCESS').length ===
          addresses.length
      ) {
        const errorCount = [...latest.values()].filter((item) => item.status !== 'SUCCESS').length;
        emitProgress(
          `[final-state] verified=${successful.size}/${addresses.length} positive=${[...successful.values()].filter((item) => item.finalBalancePlanck !== '0').length} zero=${[...successful.values()].filter((item) => item.finalBalancePlanck === '0').length} remaining=${addresses.length - successful.size} errors=${errorCount}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
  await appendChain;
  const finalResults = addresses
    .map((address) => successful.get(address) ?? latest.get(address))
    .filter((result): result is FinalStateBalanceResult => result !== undefined)
    .sort((a, b) => compareCanonicalStrings(a.address, b.address));
  const complete =
    finalResults.length === addresses.length &&
    finalResults.every((result) => result.status === 'SUCCESS');
  let status: FinalStateSummary['status'] = 'FINAL_STATE_INCOMPLETE';
  if (complete) {
    const delta = BigInt(preflight.totalSupplyPlanck) - sumSuccessful(finalResults);
    status =
      delta === 0n
        ? 'FINAL_STATE_RPC_VERIFIED'
        : delta > 0n
          ? 'FINAL_STATE_SUPPLY_SHORTFALL'
          : 'FINAL_STATE_SUPPLY_OVERFLOW';
  }
  const summary = await writeFinalArtifacts(
    outputDirectory,
    discovery,
    preflight,
    finalResults,
    status,
    options,
  );
  return { outputDirectory, status, summary, preflight, discovery };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path, { encoding: 'utf8' });
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== 'ENOENT';
  }
}

export const FINAL_STATE_FIXED_CONTEXT = {
  blockNumber: MOONBEAM_FINAL_BLOCK_NUMBER,
  expectedCodeHash: EXPECTED_XC_DOT_CODE_HASH,
};
