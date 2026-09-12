import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { URL } from 'node:url';
import {
  ARCHIVE_PROBE_BLOCK_HASH,
  ARCHIVE_PROBE_BLOCK_NUMBER,
  ARCHIVE_PROBE_STATE_ROOT,
  ARCHIVE_PROBE_STATE_VERSION,
  ARCHIVE_PROBE_STORAGE_KEY,
  verifyArchiveProofOffline,
  type ArchiveOfflineProofInput,
  type ArchiveOfflineProofResult,
  type ArchiveOfflineVerifier,
  type ArchiveOfflineVerifierOptions,
} from './substrate-archive.js';
import { SubstrateArchiveProbeInputError } from '../utils/errors.js';

export const NOWNODES_FINAL_STATE_PROBE_ENDPOINT = 'https://moonbeam.nownodes.io/' as const;
export const NOWNODES_FINAL_STATE_PROBE_BLOCK_NUMBER = ARCHIVE_PROBE_BLOCK_NUMBER;
export const NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH = ARCHIVE_PROBE_BLOCK_HASH;
export const NOWNODES_FINAL_STATE_PROBE_STATE_ROOT = ARCHIVE_PROBE_STATE_ROOT;
export const NOWNODES_FINAL_STATE_PROBE_STATE_VERSION = ARCHIVE_PROBE_STATE_VERSION;
export const NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY = ARCHIVE_PROBE_STORAGE_KEY;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000, 5_000] as const;

export type NownodesProbeFieldStatus = 'PASS' | 'FAIL' | 'NOT_RUN';

export type NownodesErrorCode =
  | 'NOWNODES_AUTH_FAILED'
  | 'NOWNODES_RATE_LIMITED'
  | 'NOWNODES_TRANSPORT_ERROR'
  | 'NOWNODES_TIMEOUT'
  | 'NOWNODES_METHOD_NOT_FOUND'
  | 'NOWNODES_BLOCK_NOT_FOUND'
  | 'PINNED_HEADER_MISMATCH'
  | 'NOWNODES_ARCHIVE_STATE_UNAVAILABLE'
  | 'NOWNODES_READ_PROOF_UNAVAILABLE'
  | 'NOWNODES_READ_PROOF_INVALID'
  | 'RUNTIME_VERSION_MISMATCH'
  | 'UNKNOWN_NOWNODES_ERROR';

export type NownodesProbeStatus =
  | 'NOWNODES_HISTORICAL_PROOF_CAPABLE'
  | 'NOWNODES_HISTORICAL_STORAGE_ONLY'
  | 'NOWNODES_ARCHIVE_STATE_UNAVAILABLE'
  | 'NOWNODES_READ_PROOF_UNAVAILABLE'
  | 'NOWNODES_READ_PROOF_INVALID'
  | 'NOWNODES_AUTH_FAILED'
  | 'NOWNODES_RATE_LIMITED'
  | 'NOWNODES_TRANSPORT_ERROR'
  | 'NOWNODES_TIMEOUT'
  | 'NOWNODES_METHOD_NOT_FOUND'
  | 'NOWNODES_BLOCK_NOT_FOUND'
  | 'PINNED_HEADER_MISMATCH'
  | 'UNKNOWN_NOWNODES_ERROR';

export class NownodesRpcError extends Error {
  readonly code: NownodesErrorCode;
  readonly transient: boolean;
  readonly method: string;
  readonly httpStatus: number | undefined;
  readonly rpcCode: number | undefined;
  attempts: number | undefined;

  constructor(
    code: NownodesErrorCode,
    message: string,
    method: string,
    options: {
      transient?: boolean;
      httpStatus?: number;
      rpcCode?: number;
    } = {},
  ) {
    super(message);
    this.name = 'NownodesRpcError';
    this.code = code;
    this.transient = options.transient ?? false;
    this.method = method;
    this.httpStatus = options.httpStatus;
    this.rpcCode = options.rpcCode;
  }
}

export interface NownodesProbeRpcClient {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

export interface NownodesProbeRetryOptions {
  attempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface NownodesProbeStage {
  status: NownodesProbeFieldStatus;
  method: string;
  blockHash: string;
  attempts?: number;
  errorCode?: NownodesErrorCode;
  errorDetail?: string;
}

export interface NownodesFinalStateProbeReport {
  schemaVersion: 1;
  provider: 'NOWNODES';
  endpoint: string;
  nownodesKeyPresent: boolean;
  block: {
    number: string;
    hash: string;
    expectedStateRoot: string;
    observedStateRoot?: string;
  };
  header: NownodesProbeStage & {
    number?: string;
    stateRoot?: string;
  };
  storage: NownodesProbeStage & {
    key: string;
    valueBytes?: number;
    valueSha256?: string;
    codeHash?: string;
  };
  readProof: NownodesProbeStage & {
    key: string;
    at?: string;
    nodeCount?: number;
    totalBytes?: number;
    proofSha256?: string;
  };
  runtime: NownodesProbeStage & {
    specVersion?: string;
    stateVersion?: string;
    match?: NownodesProbeFieldStatus;
  };
  offlineProof: {
    status: 'PASS' | 'FAIL' | 'UNAVAILABLE' | 'NOT_RUN';
    detail?: string;
  };
  canReconstructFinalState: boolean;
  canGenerateVerifiableProofs: boolean;
  status: NownodesProbeStatus;
  errorCode?: NownodesErrorCode;
  errorDetail?: string;
}

export interface NownodesFinalStateProbeResult {
  outputDirectory: string;
  report: NownodesFinalStateProbeReport;
  reportText: string;
}

export interface NownodesFinalStateProbeOptions {
  endpoint?: string;
  key?: string;
  timeoutMs?: number;
  retries?: number;
  out?: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  offlineVerifier?: ArchiveOfflineVerifier;
  verifierBinary?: string;
  projectRoot?: string;
}

interface NownodesProbeArtifacts {
  header: Record<string, unknown>;
  storage: Record<string, unknown>;
  readProof: Record<string, unknown>;
  offlineProof?: Record<string, unknown>;
}

interface CallSuccess {
  ok: true;
  value: unknown;
  attempts: number;
}

interface CallFailure {
  ok: false;
  error: NownodesRpcError;
  attempts: number;
}

type CallOutcome = CallSuccess | CallFailure;

function inputError(message: string, details: Record<string, string | number | boolean> = {}) {
  return new SubstrateArchiveProbeInputError(message, details);
}

function safeText(value: unknown): string {
  if (value instanceof NownodesRpcError) {
    const details = [
      value.rpcCode === undefined ? undefined : `rpcCode=${value.rpcCode}`,
      value.httpStatus === undefined ? undefined : `httpStatus=${value.httpStatus}`,
    ].filter((item): item is string => item !== undefined);
    return [value.message, ...details].join('; ');
  }
  if (value instanceof Error) {
    const cause = (value as Error & { cause?: unknown }).cause;
    return `${value.name}: ${value.message}${cause === undefined ? '' : `; cause=${safeText(cause)}`}`;
  }
  return String(value);
}

function redactSecret(value: string, secret: string | undefined): string {
  return secret === undefined || secret === '' ? value : value.split(secret).join('<redacted-key>');
}

function safeDetail(value: unknown, secret?: string): string {
  return redactSecret(safeText(value), secret);
}

function bodyPreview(value: string): string {
  return value.length > 4096 ? `${value.slice(0, 4096)}…` : value;
}

function validateEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch (error) {
    throw inputError('NOWNodes endpoint URL is invalid.', { error: safeText(error) });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host === '') {
    throw inputError('NOWNodes endpoint must use http(s) with a host.', {
      endpoint: `${parsed.protocol}//${parsed.host}`,
    });
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw inputError('NOWNodes endpoint must not contain credentials or query parameters.');
  }
  return parsed.toString();
}

function hashSha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function hexBytes(value: string, label: string): number {
  if (!/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new NownodesRpcError(
      'UNKNOWN_NOWNODES_ERROR',
      `${label} is not valid even-length hex.`,
      label,
    );
  }
  return (value.length - 2) / 2;
}

function asHex(value: unknown, label: string, requireBytes = false): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new NownodesRpcError(
      'UNKNOWN_NOWNODES_ERROR',
      `${label} is not valid even-length hex.`,
      label,
    );
  }
  if (requireBytes && value.length <= 2) {
    throw new NownodesRpcError('NOWNODES_ARCHIVE_STATE_UNAVAILABLE', `${label} is empty.`, label);
  }
  return value.toLowerCase();
}

function asHash(value: unknown, label: string): string {
  const hash = asHex(value, label, true);
  if (hash.length !== 66) {
    throw new NownodesRpcError('UNKNOWN_NOWNODES_ERROR', `${label} is not a 32-byte hash.`, label);
  }
  return hash;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NownodesRpcError('UNKNOWN_NOWNODES_ERROR', `${label} is not an object.`, label);
  }
  return value as Record<string, unknown>;
}

function asUnsignedNumber(value: unknown, label: string): string {
  try {
    if (typeof value === 'bigint' && value >= 0n) return value.toString(10);
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      return String(value);
    }
    if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
      return BigInt(value).toString(10);
    }
  } catch {
    // Fall through to the normalized RPC error below.
  }
  throw new NownodesRpcError(
    'UNKNOWN_NOWNODES_ERROR',
    `${label} is not an unsigned integer.`,
    label,
  );
}

function errorCodeForRpcResponse(
  method: string,
  value: unknown,
  httpStatus?: number,
): NownodesRpcError {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const error =
    typeof record.error === 'object' && record.error !== null
      ? (record.error as Record<string, unknown>)
      : {};
  const rpcCode = typeof error.code === 'number' ? error.code : undefined;
  const message =
    typeof error.message === 'string' ? error.message : `NOWNodes request failed for ${method}`;
  const lower = message.toLowerCase();
  const blockNotFound =
    /unknown block|block[^\n]*(not found|unavailable|missing)|cannot find[^\n]*block/i.test(lower);
  const historical = /state|histor|prun|discard|archive|old|block|unavailable|missing/i.test(lower);
  let code: NownodesErrorCode;
  if (httpStatus === 401 || httpStatus === 403) code = 'NOWNODES_AUTH_FAILED';
  else if (httpStatus === 429) code = 'NOWNODES_RATE_LIMITED';
  else if (rpcCode === -32601) code = 'NOWNODES_METHOD_NOT_FOUND';
  else if (blockNotFound) code = 'NOWNODES_BLOCK_NOT_FOUND';
  else if (method === 'state_getStorage' && historical) code = 'NOWNODES_ARCHIVE_STATE_UNAVAILABLE';
  else if (method === 'state_getReadProof' && historical) code = 'NOWNODES_READ_PROOF_UNAVAILABLE';
  else code = 'UNKNOWN_NOWNODES_ERROR';
  return new NownodesRpcError(code, message, method, {
    transient: httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(rpcCode === undefined ? {} : { rpcCode }),
  });
}

function normalizeError(error: unknown, method: string): NownodesRpcError {
  if (error instanceof NownodesRpcError) return error;
  const message = safeText(error);
  if (/timeout|timed out|abort/i.test(message)) {
    return new NownodesRpcError('NOWNODES_TIMEOUT', message, method, { transient: true });
  }
  return new NownodesRpcError('NOWNODES_TRANSPORT_ERROR', message, method, { transient: true });
}

class HttpNownodesRpcClient implements NownodesProbeRpcClient {
  private nextId = 1;

  constructor(
    private readonly endpoint: string,
    private readonly key: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async request(method: string, params: readonly unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': this.key },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params: [...params] }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new NownodesRpcError('NOWNODES_TIMEOUT', `Request timed out for ${method}.`, method, {
          transient: true,
        });
      }
      throw new NownodesRpcError('NOWNODES_TRANSPORT_ERROR', safeText(error), method, {
        transient: true,
      });
    }
    clearTimeout(timer);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new NownodesRpcError('NOWNODES_TRANSPORT_ERROR', safeText(error), method, {
        transient: response.status >= 500,
        httpStatus: response.status,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new NownodesRpcError(
        response.status >= 500 ? 'NOWNODES_TRANSPORT_ERROR' : 'UNKNOWN_NOWNODES_ERROR',
        `HTTP ${response.status} returned invalid JSON; body=${redactSecret(bodyPreview(text), this.key)}.`,
        method,
        {
          transient: response.status === 429 || response.status >= 500,
          httpStatus: response.status,
        },
      );
    }
    if (!response.ok) throw errorCodeForRpcResponse(method, parsed, response.status);
    if (typeof parsed !== 'object' || parsed === null || !('result' in parsed)) {
      throw errorCodeForRpcResponse(method, parsed);
    }
    if ('error' in parsed) throw errorCodeForRpcResponse(method, parsed);
    return (parsed as { result: unknown }).result;
  }

  async close(): Promise<void> {}
}

export function createNownodesRpcClient(
  endpoint: string,
  key: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): NownodesProbeRpcClient {
  return new HttpNownodesRpcClient(validateEndpoint(endpoint), key, timeoutMs, fetchImpl);
}

export async function retryNownodesRpc<T>(
  operation: () => Promise<T>,
  options: NownodesProbeRetryOptions = {},
): Promise<{ value: T; attempts: number }> {
  const attemptsLimit = options.attempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isInteger(attemptsLimit) || attemptsLimit < 1 || attemptsLimit > 5) {
    throw inputError('NOWNodes attempts must be an integer from 1 to 5.', {
      attempts: attemptsLimit,
    });
  }
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  let lastError: NownodesRpcError | undefined;
  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    try {
      return { value: await operation(), attempts: attempt };
    } catch (error) {
      const normalized = normalizeError(error, 'nownodes');
      normalized.attempts = attempt;
      lastError = normalized;
      if (!normalized.transient || attempt === attemptsLimit) throw normalized;
      const delay =
        RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ??
        RETRY_DELAYS_MS.at(-1)!;
      await sleep(delay);
    }
  }
  throw (
    lastError ??
    new NownodesRpcError('UNKNOWN_NOWNODES_ERROR', 'NOWNodes request failed.', 'nownodes')
  );
}

async function callRpc(
  client: NownodesProbeRpcClient,
  method: string,
  params: readonly unknown[],
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<CallOutcome> {
  try {
    const result = await retryNownodesRpc(() => client.request(method, params), {
      attempts,
      sleep,
    });
    return { ok: true, value: result.value, attempts: result.attempts };
  } catch (error) {
    const normalized = normalizeError(error, method);
    return { ok: false, error: normalized, attempts: normalized.attempts ?? attempts };
  }
}

function passStage<T extends NownodesProbeStage>(stage: T, attempts: number): T {
  return { ...stage, status: 'PASS', attempts };
}

function failStage<T extends NownodesProbeStage>(
  stage: T,
  error: NownodesRpcError,
  attempts: number,
  secret?: string,
): T {
  return {
    ...stage,
    status: 'FAIL',
    attempts,
    errorCode: error.code,
    errorDetail: safeDetail(error, secret),
  };
}

function stageFailureStatus(
  stage: 'header' | 'storage' | 'proof',
  code: NownodesErrorCode,
): NownodesProbeStatus {
  if (stage === 'header') return code as NownodesProbeStatus;
  if (
    code === 'NOWNODES_AUTH_FAILED' ||
    code === 'NOWNODES_RATE_LIMITED' ||
    code === 'NOWNODES_TRANSPORT_ERROR' ||
    code === 'NOWNODES_TIMEOUT'
  ) {
    return code;
  }
  if (stage === 'storage') {
    return code === 'NOWNODES_METHOD_NOT_FOUND'
      ? 'NOWNODES_METHOD_NOT_FOUND'
      : 'NOWNODES_ARCHIVE_STATE_UNAVAILABLE';
  }
  return code === 'NOWNODES_READ_PROOF_INVALID' ? code : 'NOWNODES_READ_PROOF_UNAVAILABLE';
}

function reportText(report: NownodesFinalStateProbeReport): string {
  const line = (key: string, value: string | number | boolean | undefined): string =>
    `${key}=${value === undefined ? 'NOT_RECORDED' : value}`;
  return [
    line('PROVIDER', report.provider),
    line('ENDPOINT', report.endpoint),
    '',
    line('NOWNODES_KEY_PRESENT', report.nownodesKeyPresent),
    '',
    line('BLOCK_NUMBER', report.block.number),
    line('BLOCK_HASH', report.block.hash),
    line('EXPECTED_STATE_ROOT', report.block.expectedStateRoot),
    line('OBSERVED_STATE_ROOT', report.block.observedStateRoot),
    '',
    line('FINAL_HEADER', report.header.status),
    line('HISTORICAL_STORAGE', report.storage.status),
    line('CODE_VALUE_BYTE_LENGTH', report.storage.valueBytes),
    line('CODE_VALUE_SHA256', report.storage.valueSha256),
    line('CODE_HASH', report.storage.codeHash),
    '',
    line('READ_PROOF_RPC', report.readProof.status),
    line('READ_PROOF_NODE_COUNT', report.readProof.nodeCount),
    line('READ_PROOF_TOTAL_BYTES', report.readProof.totalBytes),
    line('READ_PROOF_OFFLINE_VERIFY', report.offlineProof.status),
    '',
    line('RUNTIME_VERSION_MATCH', report.runtime.match),
    line('CAN_RECONSTRUCT_FINAL_STATE', report.canReconstructFinalState),
    line('CAN_GENERATE_VERIFIABLE_PROOFS', report.canGenerateVerifiableProofs),
    '',
    line('STATUS', report.status),
    line('ERROR_CODE', report.errorCode),
    `ERROR_DETAIL=${JSON.stringify(report.errorDetail ?? '')}`,
    '',
  ].join('\n');
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
  await writeAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

async function persistProbe(
  outputDirectory: string,
  report: NownodesFinalStateProbeReport,
  artifacts: NownodesProbeArtifacts,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const writes = [
    writeJson(join(outputDirectory, 'header.json'), artifacts.header),
    writeJson(join(outputDirectory, 'storage-code.json'), artifacts.storage),
    writeJson(join(outputDirectory, 'read-proof.json'), artifacts.readProof),
    writeAtomic(join(outputDirectory, 'report.txt'), reportText(report)),
  ];
  if (artifacts.offlineProof !== undefined) {
    writes.push(
      writeJson(join(outputDirectory, 'offline-proof-verification.json'), artifacts.offlineProof),
    );
  }
  await Promise.all(writes);
}

function initialReport(endpoint: string, keyPresent: boolean): NownodesFinalStateProbeReport {
  return {
    schemaVersion: 1,
    provider: 'NOWNODES',
    endpoint,
    nownodesKeyPresent: keyPresent,
    block: {
      number: NOWNODES_FINAL_STATE_PROBE_BLOCK_NUMBER,
      hash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
      expectedStateRoot: NOWNODES_FINAL_STATE_PROBE_STATE_ROOT,
    },
    header: {
      status: 'NOT_RUN',
      method: 'chain_getHeader',
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
    },
    storage: {
      status: 'NOT_RUN',
      method: 'state_getStorage',
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
      key: NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
    },
    readProof: {
      status: 'NOT_RUN',
      method: 'state_getReadProof',
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
      key: NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
    },
    runtime: {
      status: 'NOT_RUN',
      method: 'state_getRuntimeVersion',
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
    },
    offlineProof: { status: 'NOT_RUN' },
    canReconstructFinalState: false,
    canGenerateVerifiableProofs: false,
    status: 'UNKNOWN_NOWNODES_ERROR',
  };
}

function initialArtifacts(): NownodesProbeArtifacts {
  return {
    header: {
      status: 'NOT_RUN',
      method: 'chain_getHeader',
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
    },
    storage: {
      status: 'NOT_RUN',
      method: 'state_getStorage',
      key: NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
    },
    readProof: {
      status: 'NOT_RUN',
      method: 'state_getReadProof',
      keys: [NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY],
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
    },
  };
}

function setFailure(
  report: NownodesFinalStateProbeReport,
  status: NownodesProbeStatus,
  errorCode: NownodesErrorCode,
  detail: string,
): void {
  report.status = status;
  report.errorCode = errorCode;
  report.errorDetail = detail;
}

export async function runNownodesFinalStateProbe(
  options: NownodesFinalStateProbeOptions = {},
  suppliedClient?: NownodesProbeRpcClient,
): Promise<NownodesFinalStateProbeResult> {
  const endpoint = validateEndpoint(options.endpoint ?? NOWNODES_FINAL_STATE_PROBE_ENDPOINT);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = options.retries ?? DEFAULT_ATTEMPTS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw inputError('NOWNodes timeout must be an integer from 1 to 120000 ms.', { timeoutMs });
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw inputError('NOWNodes attempts must be an integer from 1 to 5.', { attempts });
  }
  const key = (options.key ?? process.env.NOWNODES_KEY)?.trim();
  const outputDirectory = resolve(options.out ?? 'diagnostics/nownodes-final-state-probe');
  const report = initialReport(endpoint, key !== undefined && key !== '');
  const artifacts = initialArtifacts();

  if (key === undefined || key === '') {
    const error = new NownodesRpcError('NOWNODES_AUTH_FAILED', 'NOWNODES_KEY is not set.', 'auth');
    report.header = failStage(report.header, error, 0);
    setFailure(report, 'NOWNODES_AUTH_FAILED', error.code, error.message);
    artifacts.header = {
      status: 'FAIL',
      method: 'auth',
      errorCode: error.code,
      error: error.message,
    };
    await persistProbe(outputDirectory, report, artifacts);
    return { outputDirectory, report, reportText: reportText(report) };
  }

  let client = suppliedClient;
  let ownsClient = false;
  if (client === undefined) {
    client = createNownodesRpcClient(endpoint, key, timeoutMs, options.fetchImpl ?? fetch);
    ownsClient = true;
  }
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  try {
    const header = await callRpc(
      client,
      'chain_getHeader',
      [NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH],
      attempts,
      sleep,
    );
    if (!header.ok) {
      report.header = failStage(report.header, header.error, header.attempts, key);
      artifacts.header = {
        status: 'FAIL',
        method: 'chain_getHeader',
        blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
        attempts: header.attempts,
        errorCode: header.error.code,
        error: safeDetail(header.error, key),
      };
      setFailure(
        report,
        stageFailureStatus('header', header.error.code),
        header.error.code,
        safeDetail(header.error, key),
      );
      return { outputDirectory, report, reportText: reportText(report) };
    }
    artifacts.header = {
      status: 'PASS',
      method: 'chain_getHeader',
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
      attempts: header.attempts,
      result: header.value,
    };
    try {
      if (header.value === null) {
        throw new NownodesRpcError(
          'NOWNODES_BLOCK_NOT_FOUND',
          'chain_getHeader returned null for the pinned block.',
          'chain_getHeader',
        );
      }
      const headerRecord = asRecord(header.value, 'chain_getHeader result');
      const number = asUnsignedNumber(headerRecord.number, 'header.number');
      const stateRoot = asHash(headerRecord.stateRoot, 'header.stateRoot');
      report.header = {
        ...passStage(report.header, header.attempts),
        number,
        stateRoot,
      };
      report.block.observedStateRoot = stateRoot;
      if (
        number !== NOWNODES_FINAL_STATE_PROBE_BLOCK_NUMBER ||
        stateRoot !== NOWNODES_FINAL_STATE_PROBE_STATE_ROOT
      ) {
        throw new NownodesRpcError(
          'PINNED_HEADER_MISMATCH',
          `Pinned header mismatch: number=${number} stateRoot=${stateRoot}.`,
          'chain_getHeader',
        );
      }
    } catch (error) {
      const normalized = normalizeError(error, 'chain_getHeader');
      report.header = failStage(report.header, normalized, header.attempts, key);
      artifacts.header = {
        ...artifacts.header,
        status: 'FAIL',
        errorCode: normalized.code,
        error: safeDetail(normalized, key),
      };
      setFailure(
        report,
        normalized.code === 'NOWNODES_BLOCK_NOT_FOUND'
          ? 'NOWNODES_BLOCK_NOT_FOUND'
          : 'PINNED_HEADER_MISMATCH',
        normalized.code,
        safeDetail(normalized, key),
      );
      return { outputDirectory, report, reportText: reportText(report) };
    }

    const runtime = await callRpc(
      client,
      'state_getRuntimeVersion',
      [NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH],
      attempts,
      sleep,
    );
    if (!runtime.ok) {
      report.runtime = failStage(report.runtime, runtime.error, runtime.attempts, key);
    } else {
      try {
        const runtimeRecord = asRecord(runtime.value, 'state_getRuntimeVersion result');
        const specVersion = asUnsignedNumber(runtimeRecord.specVersion, 'runtime.specVersion');
        const stateVersion = asUnsignedNumber(runtimeRecord.stateVersion, 'runtime.stateVersion');
        const match =
          specVersion === '4401' &&
          stateVersion === String(NOWNODES_FINAL_STATE_PROBE_STATE_VERSION);
        report.runtime = {
          ...passStage(report.runtime, runtime.attempts),
          specVersion,
          stateVersion,
          match: match ? 'PASS' : 'FAIL',
          ...(match
            ? {}
            : {
                errorCode: 'RUNTIME_VERSION_MISMATCH',
                errorDetail: `Runtime mismatch: specVersion=${specVersion} stateVersion=${stateVersion}.`,
              }),
        };
      } catch (error) {
        const normalized = normalizeError(error, 'state_getRuntimeVersion');
        report.runtime = failStage(report.runtime, normalized, runtime.attempts, key);
      }
    }

    const storage = await callRpc(
      client,
      'state_getStorage',
      [NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY, NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH],
      attempts,
      sleep,
    );
    if (!storage.ok) {
      report.storage = failStage(report.storage, storage.error, storage.attempts, key);
      artifacts.storage = {
        status: 'FAIL',
        method: 'state_getStorage',
        key: NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
        blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
        attempts: storage.attempts,
        errorCode: storage.error.code,
        error: safeDetail(storage.error, key),
      };
      setFailure(
        report,
        stageFailureStatus('storage', storage.error.code),
        storage.error.code,
        safeDetail(storage.error, key),
      );
      return { outputDirectory, report, reportText: reportText(report) };
    }
    artifacts.storage = {
      status: 'PASS',
      method: 'state_getStorage',
      key: NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
      attempts: storage.attempts,
      result: storage.value,
    };
    let code: string;
    try {
      if (storage.value === null) {
        throw new NownodesRpcError(
          'NOWNODES_ARCHIVE_STATE_UNAVAILABLE',
          'state_getStorage returned null for :code at the pinned block.',
          'state_getStorage',
        );
      }
      code = asHex(storage.value, ':code', true);
      const bytes = hexBytes(code, ':code');
      const valueBytes = Buffer.from(code.slice(2), 'hex');
      const codeSha256 = hashSha256(valueBytes);
      report.storage = {
        ...passStage(report.storage, storage.attempts),
        valueBytes: bytes,
        valueSha256: codeSha256,
        codeHash: codeSha256,
      };
    } catch (error) {
      const normalized = normalizeError(error, 'state_getStorage');
      report.storage = failStage(report.storage, normalized, storage.attempts, key);
      artifacts.storage = {
        ...artifacts.storage,
        status: 'FAIL',
        errorCode: normalized.code,
        error: safeDetail(normalized, key),
      };
      setFailure(
        report,
        stageFailureStatus('storage', normalized.code),
        normalized.code,
        safeDetail(normalized, key),
      );
      return { outputDirectory, report, reportText: reportText(report) };
    }
    report.canReconstructFinalState = true;

    const proof = await callRpc(
      client,
      'state_getReadProof',
      [[NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY], NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH],
      attempts,
      sleep,
    );
    if (!proof.ok) {
      report.readProof = failStage(report.readProof, proof.error, proof.attempts, key);
      artifacts.readProof = {
        status: 'FAIL',
        method: 'state_getReadProof',
        keys: [NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY],
        blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
        attempts: proof.attempts,
        errorCode: proof.error.code,
        error: safeDetail(proof.error, key),
      };
      setFailure(
        report,
        stageFailureStatus('proof', proof.error.code),
        proof.error.code,
        safeDetail(proof.error, key),
      );
      return { outputDirectory, report, reportText: reportText(report) };
    }
    artifacts.readProof = {
      status: 'PASS',
      method: 'state_getReadProof',
      keys: [NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY],
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
      attempts: proof.attempts,
      result: proof.value,
    };
    let proofAt: string;
    let proofNodes: string[];
    try {
      const proofRecord = asRecord(proof.value, 'state_getReadProof result');
      proofAt = asHash(proofRecord.at, 'read proof at');
      if (proofAt !== NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH) {
        throw new NownodesRpcError(
          'NOWNODES_READ_PROOF_INVALID',
          `state_getReadProof returned at=${proofAt}, expected ${NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH}.`,
          'state_getReadProof',
        );
      }
      if (!Array.isArray(proofRecord.proof) || proofRecord.proof.length === 0) {
        throw new NownodesRpcError(
          'NOWNODES_READ_PROOF_INVALID',
          'state_getReadProof returned no proof nodes.',
          'state_getReadProof',
        );
      }
      proofNodes = proofRecord.proof.map((node, index) => asHex(node, `proof node ${index}`, true));
      const totalBytes = proofNodes.reduce((sum, node) => sum + hexBytes(node, 'proof node'), 0);
      const proofSha256 = hashSha256(proofNodes.join('\n') + '\n');
      report.readProof = {
        ...passStage(report.readProof, proof.attempts),
        at: proofAt,
        nodeCount: proofNodes.length,
        totalBytes,
        proofSha256,
      };
    } catch (error) {
      const normalized = normalizeError(error, 'state_getReadProof');
      report.readProof = failStage(report.readProof, normalized, proof.attempts, key);
      artifacts.readProof = {
        ...artifacts.readProof,
        status: 'FAIL',
        errorCode: normalized.code,
        error: safeDetail(normalized, key),
      };
      setFailure(
        report,
        'NOWNODES_READ_PROOF_INVALID',
        'NOWNODES_READ_PROOF_INVALID',
        safeDetail(normalized, key),
      );
      return { outputDirectory, report, reportText: reportText(report) };
    }

    const offlineInput: ArchiveOfflineProofInput = {
      schemaVersion: 1,
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
      stateRoot: NOWNODES_FINAL_STATE_PROBE_STATE_ROOT,
      stateVersion: NOWNODES_FINAL_STATE_PROBE_STATE_VERSION,
      key: NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
      value: code,
      proof: proofNodes,
    };
    let offline: ArchiveOfflineProofResult;
    try {
      const verifier =
        options.offlineVerifier ??
        ((input) => {
          const verifierOptions: ArchiveOfflineVerifierOptions = {
            ...(options.verifierBinary === undefined
              ? {}
              : { verifierBinary: options.verifierBinary }),
            ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
          };
          return verifyArchiveProofOffline(input, verifierOptions);
        });
      offline = await verifier(offlineInput);
    } catch (error) {
      offline = { status: 'FAIL', detail: safeDetail(error, key) };
    }
    report.offlineProof = {
      status: offline.status,
      ...(offline.detail === undefined ? {} : { detail: safeDetail(offline.detail, key) }),
    };
    artifacts.offlineProof = {
      status: offline.status,
      blockHash: NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
      stateRoot: NOWNODES_FINAL_STATE_PROBE_STATE_ROOT,
      stateVersion: NOWNODES_FINAL_STATE_PROBE_STATE_VERSION,
      key: NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
      valueBytes: report.storage.valueBytes,
      ...(offline.detail === undefined ? {} : { detail: safeDetail(offline.detail, key) }),
      ...(offline.stdout === undefined ? {} : { stdout: safeDetail(offline.stdout, key) }),
      ...(offline.stderr === undefined ? {} : { stderr: safeDetail(offline.stderr, key) }),
    };
    if (offline.status === 'PASS') {
      report.canGenerateVerifiableProofs = true;
      report.status = 'NOWNODES_HISTORICAL_PROOF_CAPABLE';
    } else if (offline.status === 'UNAVAILABLE') {
      setFailure(
        report,
        'NOWNODES_READ_PROOF_UNAVAILABLE',
        'NOWNODES_READ_PROOF_UNAVAILABLE',
        offline.detail ?? 'Offline proof verifier unavailable.',
      );
    } else {
      setFailure(
        report,
        'NOWNODES_READ_PROOF_INVALID',
        'NOWNODES_READ_PROOF_INVALID',
        offline.detail ?? 'Offline proof verification failed.',
      );
    }
    return { outputDirectory, report, reportText: reportText(report) };
  } finally {
    if (ownsClient) await client.close().catch(() => undefined);
    await persistProbe(outputDirectory, report, artifacts);
  }
}
