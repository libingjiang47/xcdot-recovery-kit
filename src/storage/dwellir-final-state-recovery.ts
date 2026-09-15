import { execFile } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import { batchFileName, partition, validateBatchSize } from '../evidence/batching.js';
import {
  EXPECTED_SUBSCAN_CANDIDATE_COUNT,
  EXPECTED_SUBSCAN_CANDIDATE_SHA256,
  EXPECTED_XC_DOT_CODE_HASH,
  EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
} from '../final-state/constants.js';
import { sha256Hex } from '../snapshot/digest.js';
import { candidateAddressesSha256, discoverCandidateAddresses } from '../subscan/candidates.js';
import { compareCanonicalStrings } from '../utils/order.js';
import {
  FinalStateIdentityMismatchError,
  FinalStateStorageLayoutError,
  FinalStateStorageBackendUnsupportedError,
  FinalStateSupplyChangedError,
  FinalStateSupplyOverflowError,
  FinalStateSupplyShortfallError,
} from '../utils/errors.js';
import { decodeU256Storage } from './solidity.js';
import {
  deriveBalanceAccountStoragesKeyDirect,
  deriveTotalSupplyAccountStoragesKeyDirect,
} from './substrate-evm.js';

const execFileAsync = promisify(execFile);

export const DWELLIR_ENDPOINT_BASE = 'https://api-moonbeam.n.dwellir.com/' as const;
export const XC_DOT_BALANCES_SLOT = 0n;
export const XC_DOT_TOTAL_SUPPLY_SLOT = 2n;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_STORAGE_BATCH_SIZE = 50;
const DEFAULT_STORAGE_CONCURRENCY = 8;
const DEFAULT_PROOF_BATCH_SIZE = 32;
const DEFAULT_RETRIES = 5;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const CURL_STATUS_MARKER = '__XCDOT_HTTP_STATUS__:';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: readonly unknown[];
}

interface JsonRpcEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface DwellirRpcTransport {
  call(method: string, params: readonly unknown[]): Promise<unknown>;
  batch(calls: readonly { method: string; params: readonly unknown[] }[]): Promise<unknown[]>;
  /** Return the complete JSON-RPC envelope for evidence capture when available. */
  rawCall?(method: string, params: readonly unknown[]): Promise<unknown>;
}

export interface DwellirFinalStateRecoveryOptions {
  key?: string;
  keyFile?: string;
  endpointBase?: string;
  dataset?: string;
  moonscanCsv?: string;
  candidateExtension?: string;
  candidateDiffOut?: string;
  forceSourceChange?: boolean;
  out?: string;
  work?: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  retries?: number;
  storageBatchSize?: number;
  storageConcurrency?: number;
  proofBatchSize?: number;
  force?: boolean;
  resume?: boolean;
  verifierBinary?: string;
  projectRoot?: string;
  transport?: DwellirRpcTransport;
  offlineVerifier?: (outputDirectory: string) => Promise<{ stdout?: string }>;
  expectedCandidateCount?: number;
  expectedCandidateSha256?: string;
  expectedSubscanCandidateCount?: number;
  expectedSubscanCandidateSha256?: string;
  expectedMoonscanOnlyCount?: number;
  expectedMoonscanOnlySha256?: string;
  expectedMoonscanAddressCount?: number;
  expectedExistingCachedAddressCount?: number;
  expectedExistingFinalSumPlanck?: string;
  expectedTotalSupplyPlanck?: string;
  retainWorkDirectory?: boolean;
  progress?: (message: string) => void;
}

export interface DwellirFinalStateRecoveryResult {
  status:
    | 'VERIFIED'
    | 'FINAL_STATE_SUPPLY_SHORTFALL'
    | 'FINAL_STATE_SUPPLY_OVERFLOW'
    | 'FINAL_STATE_INCOMPLETE';
  outputDirectory: string;
  holderCount: number;
  zeroCandidateCount: number;
  totalSupplyPlanck: string;
  candidateCount: number;
  candidateAddressesSha256: string;
  proofBatchCount: number;
  unaccountedSupplyPlanck?: string;
  errorCode?: string;
  errorMessage?: string;
}

interface StorageValueRecord {
  kind: 'balance';
  address: string;
  evmStorageSlot: string;
  substrateStorageKey: string;
  rawValue: string | null;
  balancePlanck: string;
}

interface TotalSupplyRecord {
  kind: 'totalSupply';
  evmStorageSlot: string;
  substrateStorageKey: string;
  rawValue: string;
  totalSupplyPlanck: string;
}

interface StorageFetchBatch {
  schemaVersion: 1;
  blockHash: string;
  batchIndex: number;
  keys: string[];
  values: Array<string | null>;
}

interface ProofBatch {
  schemaVersion: 1;
  blockHash: string;
  stateRoot: string;
  batchIndex: number;
  keys: string[];
  proof: string[];
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
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

function normalizeStorageValue(value: unknown): string | null {
  if (value === null) return null;
  if (!isHex(value, 32)) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Dwellir returned a malformed pallet_evm::AccountStorages value.',
      { value: String(value).slice(0, 160) },
    );
  }
  return value.toLowerCase();
}

function redact(text: string, key: string): string {
  if (key === '') return text;
  return text
    .replaceAll(key, '<redacted-key>')
    .replaceAll(encodeURIComponent(key), '<redacted-key>');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseKeyFile(text: string): string | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?DWELLIR_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    let value = (match[1] ?? '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim() || undefined;
  }
  return undefined;
}

export async function resolveDwellirKey(explicit?: string, keyFile?: string): Promise<string> {
  const direct = explicit?.trim() || process.env.DWELLIR_KEY?.trim();
  if (direct) return direct;
  const candidates = keyFile
    ? [resolve(keyFile)]
    : [resolve('.key'), resolve(homedir(), 'xcdot-recovery-kit.key')];
  for (const path of candidates) {
    try {
      const key = parseKeyFile(await readFile(path, 'utf8'));
      if (key) return key;
    } catch {
      // Try the next local credential file. Secret material is never persisted to diagnostics.
    }
  }
  throw new FinalStateStorageBackendUnsupportedError(
    'DWELLIR_KEY is not set and no local key file containing DWELLIR_KEY could be read.',
    { checkedKeyFiles: candidates.join(',') },
  );
}

function rpcError(method: string, error: unknown): FinalStateStorageBackendUnsupportedError {
  const detail =
    typeof error === 'object' && error !== null ? JSON.stringify(error) : String(error);
  return new FinalStateStorageBackendUnsupportedError(`JSON-RPC ${method} failed.`, {
    method,
    detail: detail.slice(0, 1024),
  });
}

function parseRpcEnvelope(envelope: unknown, method: string): unknown {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw rpcError(method, 'response is not a JSON-RPC object');
  }
  const record = envelope as JsonRpcEnvelope;
  if (record.error !== undefined) throw rpcError(method, record.error);
  if (!('result' in record)) throw rpcError(method, 'response has no result');
  return record.result;
}

function validateTimeouts(timeoutMs: number, connectTimeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new FinalStateStorageBackendUnsupportedError('timeout-ms must be a positive integer.', {
      timeoutMs,
    });
  }
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 1) {
    throw new FinalStateStorageBackendUnsupportedError(
      'connect-timeout-ms must be a positive integer.',
      { connectTimeoutMs },
    );
  }
  if (connectTimeoutMs > timeoutMs) {
    throw new FinalStateStorageBackendUnsupportedError(
      'connect-timeout-ms must not exceed timeout-ms.',
      { connectTimeoutMs, timeoutMs },
    );
  }
}

function validateBodyTimeout(timeoutMs: number, bodyTimeoutMs: number | undefined): void {
  if (bodyTimeoutMs === undefined) return;
  if (!Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1) {
    throw new FinalStateStorageBackendUnsupportedError(
      'body-timeout-ms must be a positive integer.',
      { bodyTimeoutMs },
    );
  }
  if (bodyTimeoutMs > timeoutMs) {
    throw new FinalStateStorageBackendUnsupportedError(
      'body-timeout-ms must not exceed timeout-ms.',
      { bodyTimeoutMs, timeoutMs },
    );
  }
}

export function buildDwellirCurlArguments(options: {
  endpoint: string;
  body: JsonRpcRequest | JsonRpcRequest[];
  timeoutMs: number;
  connectTimeoutMs?: number;
  bodyTimeoutMs?: number | undefined;
  retries: number;
}): string[] {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  validateTimeouts(options.timeoutMs, connectTimeoutMs);
  validateBodyTimeout(options.timeoutMs, options.bodyTimeoutMs);
  const connectTimeoutSeconds = Math.max(1, Math.ceil(connectTimeoutMs / 1000));
  const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
  const args = [
    '--silent',
    '--show-error',
    '--connect-timeout',
    String(connectTimeoutSeconds),
    '--max-time',
    String(timeoutSeconds),
    '--retry',
    String(Math.max(0, options.retries - 1)),
    '--retry-connrefused',
    '--retry-delay',
    '2',
    '--request',
    'POST',
    '--header',
    'Content-Type: application/json',
    '--data-raw',
    JSON.stringify(options.body),
    '--write-out',
    `\n${CURL_STATUS_MARKER}%{http_code}\n`,
    options.endpoint,
  ];
  if (options.bodyTimeoutMs !== undefined) {
    const speedTimeIndex = args.indexOf('--max-time') + 2;
    args.splice(
      speedTimeIndex,
      0,
      '--speed-limit',
      '1',
      '--speed-time',
      String(Math.max(1, Math.ceil(options.bodyTimeoutMs / 1000))),
    );
  }
  return args;
}

async function curlJson(
  endpoint: string,
  body: JsonRpcRequest | JsonRpcRequest[],
  timeoutMs: number,
  connectTimeoutMs: number,
  bodyTimeoutMs: number | undefined,
  retries: number,
  key: string,
): Promise<unknown> {
  try {
    const result = await execFileAsync(
      'curl',
      buildDwellirCurlArguments({
        endpoint,
        body,
        timeoutMs,
        connectTimeoutMs,
        bodyTimeoutMs,
        retries,
      }),
      { maxBuffer: 256 * 1024 * 1024 },
    );
    const marker = `\n${CURL_STATUS_MARKER}`;
    const markerIndex = result.stdout.lastIndexOf(marker);
    if (markerIndex < 0) throw new Error('curl response lacks HTTP status marker');
    const status = Number(result.stdout.slice(markerIndex + marker.length).trim());
    const responseBody = result.stdout.slice(0, markerIndex);
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new Error(`HTTP ${status}: ${responseBody.slice(0, 1024)}`);
    }
    return JSON.parse(responseBody) as unknown;
  } catch (error) {
    const child = error as { stderr?: string; message?: string };
    const detail = redact(
      [child.message, child.stderr].filter((item): item is string => Boolean(item)).join('\n'),
      key,
    );
    throw new FinalStateStorageBackendUnsupportedError('JSON-RPC curl request failed.', {
      detail: detail.slice(0, 2048),
    });
  }
}

export function createDwellirCurlTransport(options: {
  key: string;
  endpointBase?: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  bodyTimeoutMs?: number;
  retries?: number;
}): DwellirRpcTransport {
  const key = options.key.trim();
  const endpointBase = options.endpointBase ?? DWELLIR_ENDPOINT_BASE;
  const endpoint = `${endpointBase}${encodeURIComponent(key)}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const bodyTimeoutMs = options.bodyTimeoutMs;
  const retries = options.retries ?? DEFAULT_RETRIES;
  validateTimeouts(timeoutMs, connectTimeoutMs);
  validateBodyTimeout(timeoutMs, bodyTimeoutMs);
  return createCurlRpcTransport(endpoint, timeoutMs, connectTimeoutMs, bodyTimeoutMs, retries, key);
}

export function createPublicCurlTransport(options: {
  endpoint: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  retries?: number;
}): DwellirRpcTransport {
  const endpoint = options.endpoint.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(endpoint)) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Public JSON-RPC endpoint must be an absolute HTTP(S) URL.',
      { endpoint },
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  validateTimeouts(timeoutMs, connectTimeoutMs);
  return createCurlRpcTransport(endpoint, timeoutMs, connectTimeoutMs, undefined, retries, '');
}

function createCurlRpcTransport(
  endpoint: string,
  timeoutMs: number,
  connectTimeoutMs: number,
  bodyTimeoutMs: number | undefined,
  retries: number,
  redactionKey: string,
): DwellirRpcTransport {
  let nextId = 1;
  const rawCall = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const id = nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return curlJson(
      endpoint,
      payload,
      timeoutMs,
      connectTimeoutMs,
      bodyTimeoutMs,
      retries,
      redactionKey,
    );
  };
  return {
    rawCall,
    async call(method, params) {
      const response = await rawCall(method, params);
      return parseRpcEnvelope(response, method);
    },
    async batch(calls) {
      const requests = calls.map((call) => ({
        jsonrpc: '2.0' as const,
        id: nextId++,
        method: call.method,
        params: call.params,
      }));
      const response = await curlJson(
        endpoint,
        requests,
        timeoutMs,
        connectTimeoutMs,
        bodyTimeoutMs,
        retries,
        redactionKey,
      );
      if (!Array.isArray(response)) {
        throw rpcError('batch', 'server did not return a JSON-RPC batch array');
      }
      const byId = new Map<number, unknown>();
      for (const envelope of response) {
        if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
          throw rpcError('batch', 'batch contains a non-object response');
        }
        const id = (envelope as JsonRpcEnvelope).id;
        if (typeof id !== 'number') throw rpcError('batch', 'batch response has no numeric id');
        byId.set(id, envelope);
      }
      return requests.map((request) => {
        const envelope = byId.get(request.id);
        if (envelope === undefined)
          throw rpcError(request.method, `missing batch id ${request.id}`);
        return parseRpcEnvelope(envelope, request.method);
      });
    },
  };
}

async function readStorageBatch(
  transport: DwellirRpcTransport,
  keys: readonly string[],
  concurrency: number,
): Promise<Array<string | null>> {
  try {
    const values = await transport.batch(
      keys.map((key) => ({
        method: 'state_getStorage',
        params: [key, MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH],
      })),
    );
    return values.map(normalizeStorageValue);
  } catch {
    // Some JSON-RPC gateways disable JSON batch requests. Fall back to the same
    // state_getStorage method with modest concurrency rather than 7,288 serial curl processes.
    const values: Array<string | null> = new Array(keys.length);
    for (let offset = 0; offset < keys.length; offset += concurrency) {
      const slice = keys.slice(offset, offset + concurrency);
      const resolved = await Promise.all(
        slice.map((key) =>
          transport
            .call('state_getStorage', [key, MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH])
            .then(normalizeStorageValue),
        ),
      );
      resolved.forEach((value, index) => {
        values[offset + index] = value;
      });
    }
    return values;
  }
}

function validateStoredFetchBatch(
  value: unknown,
  batchIndex: number,
  keys: readonly string[],
): StorageFetchBatch | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<StorageFetchBatch>;
  if (
    record.schemaVersion !== 1 ||
    record.blockHash !== MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH ||
    record.batchIndex !== batchIndex ||
    !Array.isArray(record.keys) ||
    !Array.isArray(record.values) ||
    JSON.stringify(record.keys) !== JSON.stringify(keys) ||
    record.values.length !== keys.length
  ) {
    return undefined;
  }
  try {
    record.values.forEach(normalizeStorageValue);
  } catch {
    return undefined;
  }
  return record as StorageFetchBatch;
}

async function loadOrFetchStorageBatch(
  transport: DwellirRpcTransport,
  workDirectory: string,
  batchIndex: number,
  keys: readonly string[],
  resume: boolean,
  storageConcurrency: number,
): Promise<StorageFetchBatch> {
  const directory = join(workDirectory, 'storage-batches');
  const path = join(directory, batchFileName(batchIndex));
  await mkdir(directory, { recursive: true });
  if (resume && (await pathExists(path))) {
    try {
      const stored = validateStoredFetchBatch(
        JSON.parse(await readFile(path, 'utf8')),
        batchIndex,
        keys,
      );
      if (stored) return stored;
    } catch {
      // Refetch malformed/incomplete checkpoint.
    }
  }
  const values = await readStorageBatch(transport, keys, storageConcurrency);
  const batch: StorageFetchBatch = {
    schemaVersion: 1,
    blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    batchIndex,
    keys: [...keys],
    values,
  };
  await atomicWriteFile(path, json(batch));
  return batch;
}

function parseProof(
  value: unknown,
  expectedKeys: readonly string[],
  batchIndex: number,
): ProofBatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw rpcError('state_getReadProof', 'result is not an object');
  }
  const record = value as { at?: unknown; proof?: unknown };
  if (
    typeof record.at !== 'string' ||
    record.at.toLowerCase() !== MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH
  ) {
    throw new FinalStateIdentityMismatchError('Dwellir returned a proof for a different block.', {
      expectedBlockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
      actualBlockHash: String(record.at),
    });
  }
  if (!Array.isArray(record.proof) || record.proof.length === 0) {
    throw rpcError('state_getReadProof', 'proof array is empty');
  }
  const proof = record.proof.map((node) => {
    if (!isHex(node) || node.length <= 2)
      throw rpcError('state_getReadProof', 'malformed proof node');
    return node.toLowerCase();
  });
  return {
    schemaVersion: 1,
    blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
    stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
    batchIndex,
    keys: [...expectedKeys],
    proof,
  };
}

function validateStoredProofBatch(
  value: unknown,
  batchIndex: number,
  keys: readonly string[],
): ProofBatch | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<ProofBatch>;
  if (
    record.schemaVersion !== 1 ||
    record.blockHash !== MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH ||
    record.stateRoot !== MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT ||
    record.batchIndex !== batchIndex ||
    JSON.stringify(record.keys) !== JSON.stringify(keys) ||
    !Array.isArray(record.proof) ||
    record.proof.length === 0 ||
    !record.proof.every((node) => isHex(node) && node.length > 2)
  ) {
    return undefined;
  }
  return record as ProofBatch;
}

async function captureProofs(
  transport: DwellirRpcTransport,
  keys: readonly string[],
  proofBatchSize: number,
  proofsDirectory: string,
  resume: boolean,
  progress: (message: string) => void = () => undefined,
): Promise<{ batchCount: number; index: string }> {
  validateBatchSize(proofBatchSize);
  const sortedKeys = [...keys].sort(compareCanonicalStrings);
  const batches = partition(sortedKeys, proofBatchSize);
  await mkdir(proofsDirectory, { recursive: true });
  const output: ProofBatch[] = [];
  for (const [batchIndex, batchKeys] of batches.entries()) {
    const path = join(proofsDirectory, batchFileName(batchIndex));
    let batch: ProofBatch | undefined;
    if (resume && (await pathExists(path))) {
      try {
        batch = validateStoredProofBatch(
          JSON.parse(await readFile(path, 'utf8')),
          batchIndex,
          batchKeys,
        );
      } catch {
        batch = undefined;
      }
    }
    if (!batch) {
      const response = await transport.call('state_getReadProof', [
        batchKeys,
        MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
      ]);
      batch = parseProof(response, batchKeys, batchIndex);
      await atomicWriteFile(path, json(batch));
    }
    output.push(batch);
    progress(`PROOF_PROGRESS=${batchIndex + 1}/${batches.length}`);
  }
  const index =
    output
      .map((batch) => {
        const file = batchFileName(batch.batchIndex);
        return JSON.stringify({
          batch: batch.batchIndex,
          file,
          firstKey: batch.keys[0] ?? '',
          lastKey: batch.keys.at(-1) ?? '',
          keyCount: batch.keys.length,
          sha256: sha256Hex(json(batch)),
        });
      })
      .join('\n') + (output.length > 0 ? '\n' : '');
  await atomicWriteFile(join(proofsDirectory, 'index.ndjson'), index);
  return { batchCount: output.length, index };
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

export async function writeSums(root: string): Promise<void> {
  const files = (await listFiles(root)).filter((file) => file !== 'SHA256SUMS');
  const lines: string[] = [];
  for (const file of files) lines.push(`${sha256Hex(await readFile(join(root, file)))}  ${file}`);
  await writeFile(
    join(root, 'SHA256SUMS'),
    lines.join('\n') + (lines.length > 0 ? '\n' : ''),
    'utf8',
  );
}

export async function defaultOfflineVerifier(
  outputDirectory: string,
  options: Pick<DwellirFinalStateRecoveryOptions, 'verifierBinary' | 'projectRoot'>,
): Promise<{ stdout?: string }> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const configuredBinary = options.verifierBinary ?? process.env.EVIDENCE_VERIFIER_BIN;
  const localBinary = join(projectRoot, 'target/debug/evidence-verifier');
  let command: string;
  let args: string[];
  let cwd: string | undefined;
  if (configuredBinary) {
    command = configuredBinary;
    args = [outputDirectory, '--final-state'];
  } else if (await pathExists(localBinary)) {
    command = localBinary;
    args = [outputDirectory, '--final-state'];
  } else {
    command = 'cargo';
    args = [
      'run',
      '--quiet',
      '--manifest-path',
      join(projectRoot, 'crates/evidence-verifier/Cargo.toml'),
      '--',
      outputDirectory,
      '--final-state',
    ];
    cwd = projectRoot;
  }
  try {
    const result = await execFileAsync(command, args, {
      ...(cwd ? { cwd } : {}),
      timeout: 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!result.stdout.includes('FINAL_STATE_OFFLINE_VERIFICATION=PASS')) {
      throw new Error(`verifier did not report PASS: ${result.stdout.slice(0, 2048)}`);
    }
    return { ...(result.stdout ? { stdout: result.stdout.trim() } : {}) };
  } catch (error) {
    const child = error as { stdout?: string; stderr?: string; message?: string };
    throw new FinalStateStorageLayoutError('Offline Substrate proof verification failed.', {
      detail: [child.message, child.stdout, child.stderr]
        .filter((item): item is string => Boolean(item))
        .join('\n')
        .slice(0, 4096),
    });
  }
}

export async function recoverDwellirFinalStateBase(
  options: DwellirFinalStateRecoveryOptions = {},
): Promise<DwellirFinalStateRecoveryResult> {
  const resume = options.resume ?? true;
  const progress = options.progress ?? (() => undefined);
  const dataset = resolve(options.dataset ?? 'snapshots/subscan');
  const outputDirectory = resolve(
    options.out ?? `snapshots/final-state-recovered/moonbeam-${MOONBEAM_FINAL_BLOCK_NUMBER}`,
  );
  const workDirectory = resolve(
    options.work ??
      `diagnostics/dwellir-final-state-recovery-work/moonbeam-${MOONBEAM_FINAL_BLOCK_NUMBER}`,
  );
  const storageBatchSize = options.storageBatchSize ?? DEFAULT_STORAGE_BATCH_SIZE;
  const storageConcurrency = options.storageConcurrency ?? DEFAULT_STORAGE_CONCURRENCY;
  const proofBatchSize = options.proofBatchSize ?? DEFAULT_PROOF_BATCH_SIZE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  if (!Number.isInteger(storageBatchSize) || storageBatchSize < 1 || storageBatchSize > 200) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Storage batch size must be an integer between 1 and 200.',
      { storageBatchSize },
    );
  }
  if (
    !Number.isInteger(storageConcurrency) ||
    storageConcurrency < 1 ||
    storageConcurrency > DEFAULT_STORAGE_CONCURRENCY
  ) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Storage concurrency must be an integer between 1 and 8.',
      { storageConcurrency },
    );
  }
  validateTimeouts(timeoutMs, connectTimeoutMs);
  validateBatchSize(proofBatchSize);

  if (options.force) {
    await Promise.all([
      rm(outputDirectory, { recursive: true, force: true }),
      rm(workDirectory, { recursive: true, force: true }),
    ]);
  }
  await mkdir(workDirectory, { recursive: true });

  const candidates = await discoverCandidateAddresses(dataset);
  const expectedCandidateCount = options.expectedCandidateCount ?? EXPECTED_SUBSCAN_CANDIDATE_COUNT;
  const expectedCandidateSha256 =
    options.expectedCandidateSha256 ?? EXPECTED_SUBSCAN_CANDIDATE_SHA256;
  const actualCandidateSha256 = candidateAddressesSha256(candidates.addresses);
  if (
    candidates.addresses.length !== expectedCandidateCount ||
    actualCandidateSha256 !== expectedCandidateSha256
  ) {
    throw new FinalStateIdentityMismatchError(
      'Candidate address set differs from the frozen v0.26 set.',
      {
        expectedCandidateCount,
        actualCandidateCount: candidates.addresses.length,
        expectedCandidateSha256,
        actualCandidateSha256,
      },
    );
  }
  progress(
    `CANDIDATE_SET=PASS count=${candidates.addresses.length} sha256=${actualCandidateSha256}`,
  );

  const transport =
    options.transport ??
    createDwellirCurlTransport({
      key: await resolveDwellirKey(options.key, options.keyFile),
      ...(options.endpointBase === undefined ? {} : { endpointBase: options.endpointBase }),
      timeoutMs,
      connectTimeoutMs,
      retries: options.retries ?? DEFAULT_RETRIES,
    });

  const totalKey = deriveTotalSupplyAccountStoragesKeyDirect(
    XC_DOT_XC20_ADDRESS,
    XC_DOT_TOTAL_SUPPLY_SLOT,
  );
  const zeroKey = deriveBalanceAccountStoragesKeyDirect(
    XC_DOT_XC20_ADDRESS,
    ZERO_ADDRESS,
    XC_DOT_BALANCES_SLOT,
  );
  const candidateKeys = candidates.addresses.map((address) => ({
    address,
    ...deriveBalanceAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, address, XC_DOT_BALANCES_SLOT),
  }));
  const allKeys = [
    totalKey.substrateStorageKey,
    zeroKey.substrateStorageKey,
    ...candidateKeys.map((item) => item.substrateStorageKey),
  ];
  if (new Set(allKeys).size !== allKeys.length) {
    throw new FinalStateStorageLayoutError('Derived AccountStorages keys are not unique.');
  }

  // Validate the two layout invariants before spending requests on all 7,288 candidates.
  const valueByKey = new Map<string, string | null>();
  const sanity = await loadOrFetchStorageBatch(
    transport,
    workDirectory,
    0,
    [totalKey.substrateStorageKey, zeroKey.substrateStorageKey],
    resume,
    storageConcurrency,
  );
  sanity.keys.forEach((key, index) => {
    const value = sanity.values[index];
    if (value === undefined) throw new Error(`sanity storage checkpoint lacks value ${index}`);
    valueByKey.set(key, normalizeStorageValue(value));
  });

  const totalRaw = valueByKey.get(totalKey.substrateStorageKey) ?? null;
  if (totalRaw === null) {
    throw new FinalStateStorageLayoutError(
      'The pinned _totalSupply AccountStorages entry is absent.',
    );
  }
  const totalSupply = decodeU256Storage(totalRaw);
  const expectedSupply = BigInt(
    options.expectedTotalSupplyPlanck ?? EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
  );
  if (totalSupply !== expectedSupply) {
    throw new FinalStateSupplyChangedError(
      'Pinned slot 2 does not equal the independently known xcDOT totalSupply.',
      {
        expectedTotalSupplyPlanck: expectedSupply.toString(10),
        actualTotalSupplyPlanck: totalSupply.toString(10),
      },
    );
  }
  const zeroRaw = valueByKey.get(zeroKey.substrateStorageKey) ?? null;
  const zeroBalance = decodeU256Storage(zeroRaw);
  if (zeroBalance !== 0n) {
    throw new FinalStateStorageLayoutError(
      'xcDOT zero-address balance is non-zero at the final state.',
      {
        zeroAddressBalancePlanck: zeroBalance.toString(10),
      },
    );
  }
  progress(`LAYOUT_SANITY=PASS totalSupply=${totalSupply.toString(10)} zeroAddress=0`);

  const candidateKeyBatches = partition(
    candidateKeys.map((item) => item.substrateStorageKey),
    storageBatchSize,
  );
  for (const [index, batchKeys] of candidateKeyBatches.entries()) {
    const batchIndex = index + 1;
    const batch = await loadOrFetchStorageBatch(
      transport,
      workDirectory,
      batchIndex,
      batchKeys,
      resume,
      storageConcurrency,
    );
    batch.keys.forEach((key, valueIndex) => {
      const value = batch.values[valueIndex];
      if (value === undefined) {
        throw new Error(`storage checkpoint ${batchIndex} lacks value ${valueIndex}`);
      }
      valueByKey.set(key, normalizeStorageValue(value));
    });
    progress(`BALANCE_PROGRESS=${index + 1}/${candidateKeyBatches.length}`);
  }
  if (valueByKey.size !== allKeys.length) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Dwellir storage fetch did not cover every derived key.',
      { expected: allKeys.length, actual: valueByKey.size },
    );
  }

  const storage: StorageValueRecord[] = candidateKeys.map((item) => {
    const rawValue = valueByKey.get(item.substrateStorageKey) ?? null;
    const balance = decodeU256Storage(rawValue);
    return {
      kind: 'balance',
      address: item.address,
      evmStorageSlot: item.evmStorageSlot,
      substrateStorageKey: item.substrateStorageKey,
      rawValue,
      balancePlanck: balance.toString(10),
    };
  });
  const sum = storage.reduce(
    (accumulator, record) => accumulator + BigInt(record.balancePlanck),
    0n,
  );
  if (sum !== totalSupply) {
    const error =
      sum < totalSupply
        ? new FinalStateSupplyShortfallError(
            'Final candidate balances do not sum to the proven xcDOT totalSupply; refusing to publish an incomplete snapshot.',
            {
              candidateSumPlanck: sum.toString(10),
              totalSupplyPlanck: totalSupply.toString(10),
              deficitPlanck: (totalSupply - sum).toString(10),
            },
          )
        : new FinalStateSupplyOverflowError(
            'Final candidate balances exceed the proven xcDOT totalSupply; refusing to publish an inconsistent snapshot.',
            {
              candidateSumPlanck: sum.toString(10),
              totalSupplyPlanck: totalSupply.toString(10),
              excessPlanck: (sum - totalSupply).toString(10),
            },
          );
    throw error;
  }

  progress(`BALANCE_COMPLETENESS=PASS sum=${sum.toString(10)}`);

  const positive = storage
    .filter((record) => record.balancePlanck !== '0')
    .map((record) => ({ address: record.address, balancePlanck: record.balancePlanck }));
  const totalRecord: TotalSupplyRecord = {
    kind: 'totalSupply',
    evmStorageSlot: totalKey.evmStorageSlot,
    substrateStorageKey: totalKey.substrateStorageKey,
    rawValue: totalRaw,
    totalSupplyPlanck: totalSupply.toString(10),
  };
  const zeroRecord: StorageValueRecord = {
    kind: 'balance',
    address: ZERO_ADDRESS,
    evmStorageSlot: zeroKey.evmStorageSlot,
    substrateStorageKey: zeroKey.substrateStorageKey,
    rawValue: zeroRaw,
    balancePlanck: '0',
  };

  const workProofsDirectory = join(workDirectory, 'proofs');
  const proofResult = await captureProofs(
    transport,
    allKeys,
    proofBatchSize,
    workProofsDirectory,
    resume,
    progress,
  );

  // The published artifact is assembled only after all live reads and proofs exist.
  await rm(outputDirectory, { recursive: true, force: true });
  const storageDirectory = join(outputDirectory, 'substrate-storage');
  const proofsDirectory = join(outputDirectory, 'proofs');
  const layoutDirectory = join(outputDirectory, 'storage-layout');
  const verificationDirectory = join(outputDirectory, 'verification');
  await Promise.all([
    mkdir(storageDirectory, { recursive: true }),
    mkdir(layoutDirectory, { recursive: true }),
    mkdir(verificationDirectory, { recursive: true }),
  ]);
  await cp(workProofsDirectory, proofsDirectory, { recursive: true });

  await Promise.all([
    writeFile(
      join(storageDirectory, 'storage.ndjson'),
      ndjson([totalRecord, zeroRecord, ...storage]),
      'utf8',
    ),
    writeFile(join(storageDirectory, 'balances.ndjson'), ndjson(storage), 'utf8'),
    writeFile(join(storageDirectory, 'positive-holders.ndjson'), ndjson(positive), 'utf8'),
    writeFile(
      join(layoutDirectory, 'layout.json'),
      json({
        schemaVersion: 2,
        contract: XC_DOT_XC20_ADDRESS,
        balancesSlot: XC_DOT_BALANCES_SLOT.toString(10),
        totalSupplySlot: XC_DOT_TOTAL_SUPPLY_SLOT.toString(10),
        solidityProvenance: {
          moonbeamRuntimeTag: 'runtime-4401',
          moonbeamCommit: 'c6d58748be27e40126788c3eca48234e85a6e6ec',
          foreignAssetSource: 'pallets/moonbeam-foreign-assets/resources/foreign_erc20.sol',
          openZeppelinVersion: '5.0.2',
          erc20StorageOrder: ['_balances', '_allowances', '_totalSupply', '_name', '_symbol'],
        },
        substrateProvenance: {
          palletPrefix: 'EVM',
          storagePrefix: 'AccountStorages',
          key1: 'Blake2_128Concat<H160>',
          key2: 'Blake2_128Concat<H256>',
          frontierBranch: 'moonbeam-polkadot-stable2512',
        },
        liveValidation: {
          totalSupplySlotMatch: 'PASS',
          zeroAddressBalance: 'PASS',
          candidateSumEqualsTotalSupply: 'PASS',
        },
      }),
      'utf8',
    ),
  ]);

  const summary = {
    schemaVersion: 2,
    status: 'PROOF_READY',
    chain: {
      name: 'Moonbeam',
      paraId: 2004,
      blockNumber: MOONBEAM_FINAL_BLOCK_NUMBER,
      substrateBlockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
      substrateStateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
      specName: 'moonbeam',
      specVersion: 4401,
      stateVersion: 1,
    },
    accountStorages: {
      pallet: 'EVM',
      storage: 'AccountStorages',
      keyDerivation: 'pinned-frontier-source',
      hashers: ['Blake2_128Concat', 'Blake2_128Concat'],
    },
    asset: {
      symbol: 'xcDOT',
      decimals: 10,
      contract: XC_DOT_XC20_ADDRESS,
      codeHash: EXPECTED_XC_DOT_CODE_HASH,
      balancesSlot: XC_DOT_BALANCES_SLOT.toString(10),
      totalSupplySlot: XC_DOT_TOTAL_SUPPLY_SLOT.toString(10),
      totalSupplyPlanck: totalSupply.toString(10),
    },
    candidateSet: {
      count: candidates.addresses.length,
      candidateAddressesSha256: actualCandidateSha256,
      source: 'Frozen Moonbeam Subscan address discovery; balances ignored',
    },
    storage: {
      queried: storage.length,
      missing: storage.filter((record) => record.rawValue === null).length,
      positive: positive.length,
      zero: storage.length - positive.length,
      knownFinalSumPlanck: sum.toString(10),
      completeness: 'PASS',
      zeroAddressBalancePlanck: '0',
      rpc: 'Dwellir state_getStorage at pinned Substrate block',
    },
    proofs: {
      batchSize: proofBatchSize,
      batchCount: proofResult.batchCount,
      blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
      stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
      rpc: 'Dwellir state_getReadProof',
    },
  };
  await writeFile(join(storageDirectory, 'summary.json'), json(summary), 'utf8');
  await writeFile(
    join(verificationDirectory, 'completeness.json'),
    json({
      status: 'PASS',
      theorem:
        'Every candidate balance was read from the pinned Moonbeam AccountStorages map and their non-negative sum equals the independently pinned _totalSupply.',
      candidateSumPlanck: sum.toString(10),
      totalSupplyPlanck: totalSupply.toString(10),
      offlineProofVerification: 'PENDING',
    }),
    'utf8',
  );
  await writeFile(
    join(outputDirectory, 'manifest.json'),
    json({
      schemaVersion: 2,
      artifact: 'xcdot-final-state-dwellir-substrate-proof-v1',
      status: 'PROOF_READY',
      blockNumber: MOONBEAM_FINAL_BLOCK_NUMBER,
      blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
      stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
      stateVersion: 1,
      contract: XC_DOT_XC20_ADDRESS,
      totalSupplyPlanck: totalSupply.toString(10),
      holderCount: positive.length,
      candidateCount: candidates.addresses.length,
      candidateAddressesSha256: actualCandidateSha256,
    }),
    'utf8',
  );
  await writeSums(outputDirectory);

  const verifier =
    options.offlineVerifier ?? ((directory: string) => defaultOfflineVerifier(directory, options));
  progress('OFFLINE_PROOF_VERIFY=RUNNING');
  const firstVerification = await verifier(outputDirectory);
  await writeFile(
    join(verificationDirectory, 'offline-verification.txt'),
    `${firstVerification.stdout ?? 'FINAL_STATE_OFFLINE_VERIFICATION=PASS'}\n`,
    'utf8',
  );
  await writeFile(
    join(verificationDirectory, 'completeness.json'),
    json({
      status: 'PASS',
      theorem:
        'All 7,288 candidate AccountStorages values plus _totalSupply are covered by Substrate read proofs rooted at the pinned final Moonbeam state root, and candidate balances sum exactly to totalSupply.',
      candidateSumPlanck: sum.toString(10),
      totalSupplyPlanck: totalSupply.toString(10),
      offlineProofVerification: 'PASS',
    }),
    'utf8',
  );
  await writeFile(
    join(outputDirectory, 'manifest.json'),
    json({
      schemaVersion: 2,
      artifact: 'xcdot-final-state-dwellir-substrate-proof-v1',
      status: 'VERIFIED',
      blockNumber: MOONBEAM_FINAL_BLOCK_NUMBER,
      blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
      stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
      stateVersion: 1,
      contract: XC_DOT_XC20_ADDRESS,
      totalSupplyPlanck: totalSupply.toString(10),
      holderCount: positive.length,
      zeroCandidateCount: storage.length - positive.length,
      candidateCount: candidates.addresses.length,
      candidateAddressesSha256: actualCandidateSha256,
      proofBatchCount: proofResult.batchCount,
      offlineProofVerification: 'PASS',
    }),
    'utf8',
  );
  await writeSums(outputDirectory);
  // Verify the exact final bytes after manifest/completeness/status were upgraded to VERIFIED.
  await verifier(outputDirectory);
  progress('OFFLINE_PROOF_VERIFY=PASS');
  if (!options.retainWorkDirectory) await rm(workDirectory, { recursive: true, force: true });

  return {
    status: 'VERIFIED',
    outputDirectory,
    holderCount: positive.length,
    zeroCandidateCount: storage.length - positive.length,
    totalSupplyPlanck: totalSupply.toString(10),
    candidateCount: candidates.addresses.length,
    candidateAddressesSha256: actualCandidateSha256,
    proofBatchCount: proofResult.batchCount,
  };
}

export async function recoverDwellirFinalState(
  options: DwellirFinalStateRecoveryOptions = {},
): Promise<DwellirFinalStateRecoveryResult> {
  if (options.moonscanCsv !== undefined) {
    const { recoverDwellirWithMoonscan } = await import('./moonscan-final-state-reconciliation.js');
    return recoverDwellirWithMoonscan(options);
  }
  if (options.candidateExtension !== undefined) {
    const { recoverDwellirWithCandidateExtension } = await import(
      './candidate-extension-final-state-reconciliation.js'
    );
    return recoverDwellirWithCandidateExtension(options);
  }
  return recoverDwellirFinalStateBase(options);
}
