import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import {
  EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
} from '../final-state/constants.js';
import {
  createDwellirCurlTransport,
  type DwellirRpcTransport,
  resolveDwellirKey,
} from '../storage/dwellir-final-state-recovery.js';
import {
  deriveBalanceAccountStoragesKeyDirect,
  deriveTotalSupplyAccountStoragesKeyDirect,
} from '../storage/substrate-evm.js';
import { decodeU256Storage, encodeU256Storage } from '../storage/solidity.js';
import { sha256Hex } from '../snapshot/digest.js';
import { compareCanonicalStrings } from '../utils/order.js';
import { writeReleaseSums, readFrozenPositiveBalances, BALANCE_BATCH_SIZE } from './build.js';

const TOTAL_SUPPLY_SLOT = 2n;
const BALANCES_SLOT = 0n;

export interface CaptureReleaseProofOptions {
  data?: string;
  source?: string;
  key?: string;
  keyFile?: string;
  endpointBase?: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  bodyTimeoutMs?: number;
  retries?: number;
  resume?: boolean;
  transport?: DwellirRpcTransport;
  projectRoot?: string;
  progress?: (message: string) => void;
}

interface RawEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ProofEntry {
  address: string;
  solidityStorageSlot: string;
  substrateStorageKey: string;
  storageValue: string;
  balancePlanck: string;
}

interface CapturedProof {
  proofNodes: string[];
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function updateSnapshotProofStatus(
  dataDirectory: string,
  knownBalanceProofsCaptured: number,
): Promise<void> {
  const snapshotPath = join(dataDirectory, 'snapshot.json');
  if (!(await exists(snapshotPath))) return;
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
    proofStatus?: Record<string, unknown>;
  };
  snapshot.proofStatus = {
    ...(snapshot.proofStatus ?? {}),
    totalSupplyCaptured: true,
    knownBalanceProofsCaptured,
  };
  await writeAtomic(snapshotPath, json(snapshot));
}

function resultFromEnvelope(envelope: unknown, method: string): unknown {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error(`${method} returned a malformed JSON-RPC envelope`);
  }
  const record = envelope as RawEnvelope;
  if (record.error !== undefined)
    throw new Error(`${method} RPC error: ${JSON.stringify(record.error)}`);
  if (!('result' in record)) throw new Error(`${method} response has no result`);
  return record.result;
}

function proofNodes(value: unknown, method: string): { at: string; nodes: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${method} result is not an object`);
  }
  const record = value as { at?: unknown; proof?: unknown };
  if (
    typeof record.at !== 'string' ||
    record.at.toLowerCase() !== MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH
  ) {
    throw new Error(`${method} returned a proof for a different block`);
  }
  if (
    !Array.isArray(record.proof) ||
    record.proof.length === 0 ||
    !record.proof.every((node) => typeof node === 'string' && /^0x[0-9a-fA-F]+$/.test(node))
  ) {
    throw new Error(`${method} returned an invalid proof array`);
  }
  return {
    at: record.at.toLowerCase(),
    nodes: record.proof.map((node) => (node as string).toLowerCase()),
  };
}

function isBisectableProofError(error: unknown): boolean {
  const record = error as { message?: unknown; details?: unknown };
  const detail = [record?.message, JSON.stringify(record?.details)]
    .filter((value) => value !== undefined)
    .join(' ');
  return /timed out|timeout|ECONNRESET|fetch failed|HTTP (429|502|503|504)|curl:\s*\(\d+\)/i.test(
    detail,
  );
}

function mergedProofNodes(...proofs: CapturedProof[]): string[] {
  return [...new Set(proofs.flatMap((proof) => proof.proofNodes))];
}

async function captureProof(
  transport: DwellirRpcTransport,
  entries: readonly ProofEntry[],
  rawPath: string,
  progress: (message: string) => void,
): Promise<CapturedProof> {
  if (await exists(rawPath)) {
    try {
      const envelope = JSON.parse(await readFile(rawPath, 'utf8')) as unknown;
      return {
        proofNodes: proofNodes(
          resultFromEnvelope(envelope, 'state_getReadProof'),
          'state_getReadProof',
        ).nodes,
      };
    } catch {
      // Re-query malformed or incomplete evidence below.
    }
  }
  try {
    const envelope = await rawCall(transport, 'state_getReadProof', [
      entries.map((entry) => entry.substrateStorageKey),
      MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    ]);
    const parsed = proofNodes(
      resultFromEnvelope(envelope, 'state_getReadProof'),
      'state_getReadProof',
    );
    await writeAtomic(rawPath, json(envelope));
    return { proofNodes: parsed.nodes };
  } catch (error) {
    if (entries.length <= 1 || !isBisectableProofError(error)) throw error;
    const midpoint = Math.ceil(entries.length / 2);
    progress(`BALANCE_PROOF_SPLIT=${entries.length}->${midpoint}+${entries.length - midpoint}`);
    const left = await captureProof(
      transport,
      entries.slice(0, midpoint),
      `${rawPath}.part-0`,
      progress,
    );
    const right = await captureProof(
      transport,
      entries.slice(midpoint),
      `${rawPath}.part-1`,
      progress,
    );
    const proof = { proofNodes: mergedProofNodes(left, right) };
    await writeAtomic(
      rawPath,
      json({
        jsonrpc: '2.0',
        id: 0,
        result: {
          at: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
          proof: proof.proofNodes,
        },
        split: true,
        partCount: 2,
      }),
    );
    return proof;
  }
}

async function rawCall(
  transport: DwellirRpcTransport,
  method: string,
  params: readonly unknown[],
): Promise<unknown> {
  if (transport.rawCall) return transport.rawCall(method, params);
  const result = await transport.call(method, params);
  return { jsonrpc: '2.0', id: 0, result };
}

function derivedEntries(
  holders: readonly { address: string; balancePlanck: string }[],
): ProofEntry[] {
  return holders
    .map((holder) => {
      const key = deriveBalanceAccountStoragesKeyDirect(
        XC_DOT_XC20_ADDRESS,
        holder.address,
        BALANCES_SLOT,
      );
      return {
        address: holder.address,
        solidityStorageSlot: key.evmStorageSlot,
        substrateStorageKey: key.substrateStorageKey,
        storageValue: encodeU256Storage(BigInt(holder.balancePlanck)),
        balancePlanck: holder.balancePlanck,
      };
    })
    .sort((a, b) => compareCanonicalStrings(a.substrateStorageKey, b.substrateStorageKey));
}

async function loadExistingBatch(
  path: string,
  expectedKeys: readonly string[],
): Promise<{ proofNodes: string[] } | undefined> {
  if (!(await exists(path))) return undefined;
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as {
      blockHash?: string;
      stateRoot?: string;
      keys?: ProofEntry[];
      proofNodes?: string[];
    };
    if (
      value.blockHash !== MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH ||
      value.stateRoot !== MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT ||
      JSON.stringify(value.keys?.map((entry) => entry.substrateStorageKey)) !==
        JSON.stringify(expectedKeys) ||
      !Array.isArray(value.proofNodes) ||
      value.proofNodes.length === 0
    )
      return undefined;
    return { proofNodes: value.proofNodes };
  } catch {
    return undefined;
  }
}

export async function captureReleaseProofs(options: CaptureReleaseProofOptions = {}): Promise<{
  dataDirectory: string;
  balanceBatchCount: number;
  balanceProofCount: number;
  totalSupplyPlanck: string;
}> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const dataDirectory = resolve(options.data ?? join(projectRoot, 'data'));
  const source = resolve(
    options.source ??
      join(
        projectRoot,
        'diagnostics/candidate-extension/candidate-cd2e0f20e5d49992/final-balances.ndjson',
      ),
  );
  const holders = await readFrozenPositiveBalances(source);
  if (holders.length !== 11785)
    throw new Error(`expected 11785 frozen positive holders, got ${holders.length}`);
  const entries = derivedEntries(holders);
  await Promise.all([
    mkdir(join(dataDirectory, 'raw', 'total-supply'), { recursive: true }),
    mkdir(join(dataDirectory, 'raw', 'balances'), { recursive: true }),
    mkdir(join(dataDirectory, 'proofs', 'balance'), { recursive: true }),
  ]);
  const transport =
    options.transport ??
    createDwellirCurlTransport({
      key: await resolveDwellirKey(options.key, options.keyFile),
      ...(options.endpointBase === undefined ? {} : { endpointBase: options.endpointBase }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.connectTimeoutMs === undefined
        ? {}
        : { connectTimeoutMs: options.connectTimeoutMs }),
      ...(options.bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs: options.bodyTimeoutMs }),
      ...(options.retries === undefined ? {} : { retries: options.retries }),
    });
  const progress = options.progress ?? (() => undefined);
  const totalKey = deriveTotalSupplyAccountStoragesKeyDirect(
    XC_DOT_XC20_ADDRESS,
    TOTAL_SUPPLY_SLOT,
  );
  const totalStorageRawPath = join(dataDirectory, 'raw', 'total-supply', 'storage.json');
  let totalStorageEnvelope: unknown;
  if (options.resume && (await exists(totalStorageRawPath))) {
    totalStorageEnvelope = JSON.parse(await readFile(totalStorageRawPath, 'utf8')) as unknown;
  } else {
    totalStorageEnvelope = await rawCall(transport, 'state_getStorage', [
      totalKey.substrateStorageKey,
      MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    ]);
    await writeAtomic(totalStorageRawPath, json(totalStorageEnvelope));
  }
  const totalRaw = resultFromEnvelope(totalStorageEnvelope, 'state_getStorage');
  if (typeof totalRaw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(totalRaw))
    throw new Error('totalSupply storage is not a 32-byte value');
  const totalSupply = decodeU256Storage(totalRaw);
  if (totalSupply.toString(10) !== EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK)
    throw new Error(`totalSupply mismatch: ${totalSupply.toString(10)}`);

  const totalProofPath = join(dataDirectory, 'raw', 'total-supply', 'read-proof.json');
  let totalProofEnvelope: unknown;
  if (options.resume && (await exists(totalProofPath)))
    totalProofEnvelope = JSON.parse(await readFile(totalProofPath, 'utf8')) as unknown;
  else {
    totalProofEnvelope = await rawCall(transport, 'state_getReadProof', [
      [totalKey.substrateStorageKey],
      MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    ]);
    await writeAtomic(totalProofPath, json(totalProofEnvelope));
  }
  const totalProof = proofNodes(
    resultFromEnvelope(totalProofEnvelope, 'state_getReadProof'),
    'state_getReadProof',
  );
  await writeFile(
    join(dataDirectory, 'proofs', 'total-supply.json'),
    json({
      schemaVersion: 1,
      proofId: 'total-supply',
      blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
      stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
      storageKey: totalKey.substrateStorageKey,
      storageValue: totalRaw.toLowerCase(),
      decodedPlanck: totalSupply.toString(10),
      proofNodes: totalProof.nodes,
    }),
    'utf8',
  );
  await updateSnapshotProofStatus(dataDirectory, 0);
  progress('TOTAL_SUPPLY_PROOF_CAPTURED=PASS');

  const indexLines: string[] = [];
  const indexPath = join(dataDirectory, 'proofs', 'index.ndjson');
  await writeAtomic(
    join(dataDirectory, 'raw', 'balances', 'values.ndjson'),
    `${entries.map((entry) => JSON.stringify({ ...entry, source: 'frozen-final-state-recovery-cache' })).join('\n')}\n`,
  );
  const batches = [] as ProofEntry[][];
  for (let offset = 0; offset < entries.length; offset += BALANCE_BATCH_SIZE)
    batches.push(entries.slice(offset, offset + BALANCE_BATCH_SIZE));
  for (const [batchIndex, batchEntries] of batches.entries()) {
    const proofId = `balance-${batchIndex.toString().padStart(6, '0')}`;
    const normalizedPath = join(dataDirectory, 'proofs', 'balance', `${proofId}.json`);
    const keys = batchEntries.map((entry) => entry.substrateStorageKey);
    let stored = await loadExistingBatch(normalizedPath, keys);
    if (!stored) {
      const proof = await captureProof(
        transport,
        batchEntries,
        join(dataDirectory, 'raw', 'balances', `${proofId}.json`),
        progress,
      );
      await writeFile(
        normalizedPath,
        json({
          schemaVersion: 1,
          proofId,
          blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
          stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
          keys: batchEntries,
          proofNodes: proof.proofNodes,
        }),
        'utf8',
      );
      stored = { proofNodes: proof.proofNodes };
    } else if (!(await exists(join(dataDirectory, 'raw', 'balances', `${proofId}.json`)))) {
      throw new Error(`normalized proof ${proofId} exists without its raw RPC response`);
    }
    indexLines.push(
      JSON.stringify({
        batch: batchIndex,
        file: `${proofId}.json`,
        keyCount: batchEntries.length,
        firstKey: keys[0],
        lastKey: keys.at(-1),
        sha256: sha256Hex(await readFile(normalizedPath)),
      }),
    );
    await writeAtomic(indexPath, `${indexLines.join('\n')}\n`);
    const capturedCount = batches
      .slice(0, batchIndex + 1)
      .reduce((count, entriesInBatch) => count + entriesInBatch.length, 0);
    await updateSnapshotProofStatus(dataDirectory, capturedCount);
    progress(`BALANCE_PROOF_PROGRESS=${batchIndex + 1}/${batches.length}`);
    void stored;
  }

  await updateSnapshotProofStatus(dataDirectory, entries.length);
  await writeReleaseSums(projectRoot, dataDirectory);
  return {
    dataDirectory,
    balanceBatchCount: batches.length,
    balanceProofCount: entries.length,
    totalSupplyPlanck: totalSupply.toString(10),
  };
}
