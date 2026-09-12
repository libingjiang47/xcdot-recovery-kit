import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { HolderSchema } from '../schemas/index.js';
import { XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import { formatDot } from '../utils/numbers.js';
import { compareCanonicalStrings } from '../utils/order.js';
import { fileSha256s, sha256Hex } from '../snapshot/digest.js';
import { createEvmClient, withConcurrency } from './providers.js';
import {
  FinalStateResumeContextMismatchError,
  FinalStateSupplyOverflowError,
  FinalStateSupplyShortfallError,
  SubscanFinalStateVerificationError,
} from '../utils/errors.js';
import { pathExists } from '../snapshot/io.js';
import type { HolderRecord } from '../types.js';

const FINAL_STATE_ABI = [
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

type FinalStateFunction = 'symbol' | 'decimals' | 'totalSupply' | 'balanceOf';

export interface FinalStateClient {
  getChainId(): Promise<number>;
  getBlock(args: { blockNumber: bigint }): Promise<{
    number: bigint | null;
    hash: Hex | null;
    stateRoot?: Hex | null;
  }>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  readContract(args: {
    address: Address;
    functionName: FinalStateFunction;
    blockNumber: bigint;
    args?: readonly [Address];
  }): Promise<unknown>;
}

function wrapPublicClient(client: PublicClient): FinalStateClient {
  return {
    getChainId: () => client.getChainId(),
    getBlock: async ({ blockNumber }) => {
      const block = await client.getBlock({ blockNumber });
      return {
        number: block.number,
        hash: block.hash,
        ...(block.stateRoot ? { stateRoot: block.stateRoot } : {}),
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

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function serializeFinalHoldersNdjson(holders: readonly HolderRecord[]): string {
  return (
    holders.map((holder) => JSON.stringify(holder)).join('\n') + (holders.length > 0 ? '\n' : '')
  );
}

function finalHoldersCsv(holders: readonly HolderRecord[]): string {
  const rows = ['address,balance_planck,balance_xcdot'];
  for (const holder of holders) {
    rows.push(
      `${holder.address},${holder.balancePlanck},${formatDot(BigInt(holder.balancePlanck), 10)}`,
    );
  }
  return rows.join('\n') + '\n';
}

function unsignedBlockNumber(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new SubscanFinalStateVerificationError(
      'Block number must be an unsigned decimal integer.',
      {
        blockNumber: value,
      },
    );
  }
  return BigInt(value);
}

function exactBalance(value: unknown, label: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new SubscanFinalStateVerificationError(`${label} did not return an unsigned U256.`, {
    value: String(value),
  });
}

function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|network|fetch|socket|econn|429|rate.?limit|temporar|502|503|504/i.test(
    message,
  );
}

async function retryHistorical<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === 4) throw error;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1000 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function historicalQuery<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await retryHistorical(operation);
  } catch (error) {
    throw new SubscanFinalStateVerificationError(`Historical ${label} query failed.`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface ProvenanceRecord {
  sourceFile: string;
  sourceRow: number;
  rawAddress: string;
  rawBalance: string;
}

interface AccountResult {
  address: string;
  subscanBalancePlanck: string;
  status: 'MATCH' | 'BALANCE_MISMATCH' | 'ZERO_AT_FINAL' | 'RPC_ERROR';
  finalBalancePlanck?: string;
  error?: string;
  provenance?: ProvenanceRecord[];
}

interface Checkpoint {
  schemaVersion: 1;
  context: {
    holdersSha256: string;
    contract: string;
    blockNumber: string;
    chainId: number;
  };
  results: AccountResult[];
}

export interface VerifySubscanFinalStateOptions {
  dataset: string;
  evmRpc: string;
  blockNumber: string;
  substrateBlockHash: string;
  concurrency?: number;
  resume?: boolean;
  force?: boolean;
}

export interface VerifySubscanFinalStateResult {
  status: 'FINAL_STATE_RPC_VERIFIED' | 'INCOMPLETE';
  summary: Record<string, unknown>;
  outputDirectory: string;
}

async function readCandidateDataset(dataset: string): Promise<{
  holders: HolderRecord[];
  raw: string;
  holdersSha256: string;
  rawDatasetDigest: string;
  provenance: Map<string, ProvenanceRecord[]>;
}> {
  let raw: string;
  let manifest: unknown;
  try {
    raw = await readFile(join(dataset, 'holders.ndjson'), 'utf8');
    manifest = JSON.parse(await readFile(join(dataset, 'import-manifest.json'), 'utf8')) as unknown;
  } catch (error) {
    throw new SubscanFinalStateVerificationError('Cannot read the Subscan derived dataset.', {
      dataset,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const holders: HolderRecord[] = [];
  const lines = raw === '' ? [] : raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (!line)
      throw new SubscanFinalStateVerificationError('Candidate holders contain a blank line.');
    holders.push(HolderSchema.parse(JSON.parse(line) as unknown));
  }
  const rawManifest = manifest as {
    rawDatasetDigest?: unknown;
    candidate?: { holdersSha256?: unknown };
  };
  const expectedDigest = rawManifest.candidate?.holdersSha256;
  const rawDatasetDigest = rawManifest.rawDatasetDigest;
  if (typeof expectedDigest !== 'string' || typeof rawDatasetDigest !== 'string') {
    throw new SubscanFinalStateVerificationError(
      'Subscan import manifest is missing candidate bindings.',
    );
  }
  const holdersSha256 = sha256Hex(raw);
  if (holdersSha256 !== expectedDigest) {
    throw new SubscanFinalStateVerificationError(
      'Candidate holders digest does not match import manifest.',
      {
        expected: expectedDigest,
        actual: holdersSha256,
      },
    );
  }
  const provenance = new Map<string, ProvenanceRecord[]>();
  const provenancePath = join(dataset, 'provenance.ndjson');
  if (await pathExists(provenancePath)) {
    const provenanceRaw = await readFile(provenancePath, 'utf8');
    const provenanceLines = provenanceRaw === '' ? [] : provenanceRaw.split('\n');
    if (provenanceLines.at(-1) === '') provenanceLines.pop();
    for (const line of provenanceLines) {
      if (!line) continue;
      const value = JSON.parse(line) as {
        address?: unknown;
        sourceFile?: unknown;
        sourceRow?: unknown;
        rawAddress?: unknown;
        rawBalance?: unknown;
      };
      if (
        typeof value.address === 'string' &&
        typeof value.sourceFile === 'string' &&
        typeof value.sourceRow === 'number' &&
        typeof value.rawAddress === 'string' &&
        typeof value.rawBalance === 'string'
      ) {
        const item = {
          sourceFile: value.sourceFile,
          sourceRow: value.sourceRow,
          rawAddress: value.rawAddress,
          rawBalance: value.rawBalance,
        };
        provenance.set(value.address, [...(provenance.get(value.address) ?? []), item]);
      }
    }
  }
  return { holders, raw, holdersSha256, rawDatasetDigest, provenance };
}

function checkpointContextEqual(a: Checkpoint['context'], b: Checkpoint['context']): boolean {
  return (
    a.holdersSha256 === b.holdersSha256 &&
    a.contract === b.contract &&
    a.blockNumber === b.blockNumber &&
    a.chainId === b.chainId
  );
}

async function writeCheckpoint(path: string, checkpoint: Checkpoint): Promise<void> {
  await writeFile(path, json(checkpoint), 'utf8');
}

export async function verifySubscanFinalState(
  options: VerifySubscanFinalStateOptions,
  client?: FinalStateClient,
  emitProgress: (message: string) => void = (message) => console.error(message),
): Promise<VerifySubscanFinalStateResult> {
  const blockNumber = unsignedBlockNumber(options.blockNumber);
  if (!/^0x[0-9a-fA-F]{64}$/.test(options.substrateBlockHash)) {
    throw new SubscanFinalStateVerificationError('Substrate block hash must be a 32-byte hash.', {
      substrateBlockHash: options.substrateBlockHash,
    });
  }
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new SubscanFinalStateVerificationError(
      'Concurrency must be an integer between 1 and 16.',
      {
        concurrency,
      },
    );
  }
  const dataset = resolve(options.dataset);
  const outputDirectory = join(dataset, 'final-state');
  if ((await pathExists(outputDirectory)) && !options.force) {
    throw new SubscanFinalStateVerificationError(
      `Final-state output already exists: ${outputDirectory}; use --force to replace it.`,
      { outputDirectory },
    );
  }
  const candidate = await readCandidateDataset(dataset);
  const evm = client ?? wrapPublicClient(createEvmClient(options.evmRpc));
  const chainId = await historicalQuery('chain ID', () => evm.getChainId());
  if (chainId !== 1284) {
    throw new SubscanFinalStateVerificationError('EVM RPC is not Moonbeam mainnet.', { chainId });
  }
  const contract = XC_DOT_XC20_ADDRESS as Address;
  const context: Checkpoint['context'] = {
    holdersSha256: candidate.holdersSha256,
    contract: contract.toLowerCase(),
    blockNumber: options.blockNumber,
    chainId,
  };
  const workDirectory = join(dirname(dataset), 'work');
  await mkdir(workDirectory, { recursive: true });
  const checkpointPath = join(workDirectory, 'final-state-checkpoint.json');
  let checkpoint: Checkpoint = { schemaVersion: 1, context, results: [] };
  if (options.resume && (await pathExists(checkpointPath))) {
    const saved = JSON.parse(await readFile(checkpointPath, 'utf8')) as Checkpoint;
    if (!saved || saved.schemaVersion !== 1 || !checkpointContextEqual(saved.context, context)) {
      throw new FinalStateResumeContextMismatchError(
        'Final-state checkpoint context does not match this run.',
        {
          holdersSha256: candidate.holdersSha256,
          contract,
          blockNumber: options.blockNumber,
          chainId,
        },
      );
    }
    const candidateAddresses = new Set(candidate.holders.map((holder) => holder.address));
    if (
      saved.results.some(
        (result) =>
          !candidateAddresses.has(result.address) ||
          !['MATCH', 'BALANCE_MISMATCH', 'ZERO_AT_FINAL', 'RPC_ERROR'].includes(result.status),
      )
    ) {
      throw new SubscanFinalStateVerificationError(
        'Final-state checkpoint contains invalid candidate results.',
      );
    }
    checkpoint = saved;
  } else {
    await writeCheckpoint(checkpointPath, checkpoint);
  }

  emitProgress(`[dataset] holders=${candidate.holders.length}`);
  emitProgress(`[evm] block=${options.blockNumber}`);
  emitProgress(`[evm] contract=${contract}`);

  const block = await historicalQuery('EVM block', () => evm.getBlock({ blockNumber }));
  if (block.number !== blockNumber || !block.hash) {
    throw new SubscanFinalStateVerificationError(
      'EVM RPC returned the wrong or incomplete historical block.',
      {
        requestedBlock: options.blockNumber,
        returnedBlock: block.number?.toString(10) ?? 'null',
        returnedHash: block.hash ?? 'null',
      },
    );
  }
  const code = await historicalQuery('contract code', () =>
    evm.getCode({ address: contract, blockNumber }),
  );
  if (!code || code === '0x' || code.length <= 2) {
    throw new SubscanFinalStateVerificationError(
      'xcDOT contract has no runtime code at the pinned block.',
      {
        blockNumber: options.blockNumber,
        contract,
      },
    );
  }
  if (!/^0x[0-9a-fA-F]*$/.test(code) || (code.length - 2) % 2 !== 0) {
    throw new SubscanFinalStateVerificationError('EVM RPC returned invalid runtime code.');
  }
  const codeHash = keccak256(code);
  const symbol = await historicalQuery('xcDOT symbol', () =>
    evm.readContract({ address: contract, functionName: 'symbol', blockNumber }),
  );
  const decimals = await historicalQuery('xcDOT decimals', () =>
    evm.readContract({ address: contract, functionName: 'decimals', blockNumber }),
  );
  const totalSupply = exactBalance(
    await historicalQuery('xcDOT totalSupply', () =>
      evm.readContract({ address: contract, functionName: 'totalSupply', blockNumber }),
    ),
    'totalSupply',
  );
  if (symbol !== 'xcDOT' || (decimals !== 10 && decimals !== 10n)) {
    throw new SubscanFinalStateVerificationError(
      'xcDOT contract metadata does not match expected identity.',
      {
        symbol: String(symbol),
        decimals: String(decimals),
        expectedSymbol: 'xcDOT',
        expectedDecimals: 10,
      },
    );
  }
  emitProgress(`[evm] totalSupply=${totalSupply.toString(10)}`);

  const existing = new Map(checkpoint.results.map((result) => [result.address, result]));
  const pending = candidate.holders.filter(
    (holder) =>
      !existing.has(holder.address) || existing.get(holder.address)?.status === 'RPC_ERROR',
  );
  let saveChain = Promise.resolve();
  const saveProgress = async (): Promise<void> => {
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
  let completed = candidate.holders.filter((holder) => existing.has(holder.address)).length;
  await withConcurrency(pending, concurrency, async (holder) => {
    let result: AccountResult;
    try {
      const value = exactBalance(
        await retryHistorical(() =>
          evm.readContract({
            address: contract,
            functionName: 'balanceOf',
            args: [holder.address as Address],
            blockNumber,
          }),
        ),
        `balanceOf(${holder.address})`,
      );
      const subscanBalance = BigInt(holder.balancePlanck);
      const provenance = candidate.provenance.get(holder.address);
      const base = {
        address: holder.address,
        subscanBalancePlanck: holder.balancePlanck,
        finalBalancePlanck: value.toString(10),
      };
      result = {
        ...base,
        status:
          value === 0n ? 'ZERO_AT_FINAL' : value === subscanBalance ? 'MATCH' : 'BALANCE_MISMATCH',
        ...(provenance ? { provenance } : {}),
      };
    } catch (error) {
      const provenance = candidate.provenance.get(holder.address);
      result = {
        address: holder.address,
        subscanBalancePlanck: holder.balancePlanck,
        status: 'RPC_ERROR',
        error: error instanceof Error ? error.message : String(error),
        ...(provenance ? { provenance } : {}),
      };
    }
    existing.set(holder.address, result);
    completed += 1;
    await saveProgress();
    if (completed % 100 === 0 || completed === candidate.holders.length) {
      emitProgress(`[verify] ${completed}/${candidate.holders.length}`);
    }
  });
  await saveProgress();

  const results = [...existing.values()].sort((a, b) =>
    compareCanonicalStrings(a.address, b.address),
  );
  const rpcErrors = results.filter((result) => result.status === 'RPC_ERROR');
  const finalPositive = results
    .filter(
      (result) => result.finalBalancePlanck !== undefined && BigInt(result.finalBalancePlanck) > 0n,
    )
    .map((result) => ({ address: result.address, balancePlanck: result.finalBalancePlanck ?? '0' }))
    .sort((a, b) => compareCanonicalStrings(a.address, b.address));
  const finalHoldersNdjson = serializeFinalHoldersNdjson(finalPositive);
  const finalHoldersSha256 = sha256Hex(finalHoldersNdjson);
  const finalSum = results.reduce(
    (sum, result) => sum + (result.finalBalancePlanck ? BigInt(result.finalBalancePlanck) : 0n),
    0n,
  );
  const balanceMatches = results.filter((result) => result.status === 'MATCH').length;
  const balanceMismatches = results.filter((result) => result.status === 'BALANCE_MISMATCH');
  const zeroAtFinal = results.filter((result) => result.status === 'ZERO_AT_FINAL').length;
  const subscanDiff = balanceMismatches.concat(
    results.filter((result) => result.status === 'ZERO_AT_FINAL'),
  );
  const diffNdjson = subscanDiff
    .map((result) => {
      const finalBalance = result.finalBalancePlanck ?? '0';
      return JSON.stringify({
        address: result.address,
        subscanBalancePlanck: result.subscanBalancePlanck,
        finalBalancePlanck: finalBalance,
        deltaPlanck: (BigInt(finalBalance) - BigInt(result.subscanBalancePlanck)).toString(10),
      });
    })
    .join('\n');
  const accountResultsNdjson =
    results.map((result) => JSON.stringify(result)).join('\n') + (results.length ? '\n' : '');
  const supplyMatches = rpcErrors.length === 0 && finalSum === totalSupply;
  const subscanBalancesMatch = balanceMismatches.length === 0 && zeroAtFinal === 0;
  const checks = {
    assetIdentity: 'PASS',
    allCandidatesQueried: rpcErrors.length === 0 ? 'PASS' : 'FAIL',
    subscanBalancesMatch: subscanBalancesMatch ? 'PASS' : 'FAIL',
    supplyCompleteness: supplyMatches ? 'PASS' : 'FAIL',
  };
  const status = supplyMatches ? 'FINAL_STATE_RPC_VERIFIED' : 'INCOMPLETE';
  const summary: Record<string, unknown> = {
    schemaVersion: 1,
    sourceDataset: {
      rawDatasetDigest: candidate.rawDatasetDigest,
      candidateHoldersSha256: candidate.holdersSha256,
    },
    chain: {
      network: 'Moonbeam',
      blockNumber: options.blockNumber,
      substrateBlockHash: options.substrateBlockHash.toLowerCase(),
      evmBlockHash: block.hash.toLowerCase(),
      ...(block.stateRoot ? { evmStateRoot: block.stateRoot.toLowerCase() } : {}),
      chainId,
    },
    asset: {
      contract,
      symbol: 'xcDOT',
      decimals: 10,
      codeSize: (code.length - 2) / 2,
      codeHash,
      totalSupplyPlanck: totalSupply.toString(10),
    },
    holders: {
      candidateCount: candidate.holders.length,
      finalPositiveCount: finalPositive.length,
      balanceMatches,
      balanceMismatches: balanceMismatches.length,
      zeroAtFinal,
      rpcErrors: rpcErrors.length,
      sumFinalBalancesPlanck: finalSum.toString(10),
      finalHoldersSha256,
    },
    checks,
    status,
  };
  const outputFiles: Record<string, string> = {
    'account-results.ndjson': accountResultsNdjson,
    'holders.csv': finalHoldersCsv(finalPositive),
    'holders.json': json(finalPositive),
    'holders.ndjson': finalHoldersNdjson,
    'subscan-diff.ndjson': diffNdjson === '' ? '' : `${diffNdjson}\n`,
    'summary.json': json(summary),
  };
  const tempDirectory = join(
    dirname(outputDirectory),
    `.tmp-final-state-${process.pid}-${Date.now()}`,
  );
  await mkdir(tempDirectory, { recursive: false });
  try {
    for (const [name, contents] of Object.entries(outputFiles)) {
      await writeFile(join(tempDirectory, name), contents, 'utf8');
    }
    const hashes = fileSha256s(outputFiles);
    const sums =
      Object.entries(hashes)
        .sort(([a], [b]) => compareCanonicalStrings(a, b))
        .map(([name, hash]) => `${hash}  ${name}`)
        .join('\n') + '\n';
    await writeFile(join(tempDirectory, 'SHA256SUMS'), sums, 'utf8');
    if (await pathExists(outputDirectory))
      await rm(outputDirectory, { recursive: true, force: true });
    await rename(tempDirectory, outputDirectory);
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }

  emitProgress(`[verify] balance_matches=${balanceMatches}`);
  emitProgress(`[verify] mismatches=${balanceMismatches.length}`);
  emitProgress(`[verify] final_sum=${finalSum.toString(10)}`);
  emitProgress(`[verify] total_supply=${totalSupply.toString(10)}`);
  emitProgress(`[verify] supply_completeness=${supplyMatches ? 'PASS' : 'FAIL'}`);

  if (rpcErrors.length > 0) {
    throw new SubscanFinalStateVerificationError(
      'Final-state verification is incomplete because RPC calls failed.',
      {
        rpcErrors: rpcErrors.length,
        candidateCount: candidate.holders.length,
      },
    );
  }
  if (finalSum < totalSupply) {
    throw new FinalStateSupplyShortfallError('Final candidate balances are below totalSupply.', {
      candidateCount: candidate.holders.length,
      positiveCount: finalPositive.length,
      shortfallPlanck: (totalSupply - finalSum).toString(10),
    });
  }
  if (finalSum > totalSupply) {
    throw new FinalStateSupplyOverflowError('Final candidate balances exceed totalSupply.', {
      candidateCount: candidate.holders.length,
      positiveCount: finalPositive.length,
      excessPlanck: (finalSum - totalSupply).toString(10),
    });
  }
  return { status, summary, outputDirectory };
}
