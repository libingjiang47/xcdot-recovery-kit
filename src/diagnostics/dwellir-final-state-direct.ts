import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  verifyArchiveProofOffline,
  type ArchiveOfflineProofInput,
  type ArchiveOfflineProofResult,
} from './substrate-archive.js';
import {
  DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
  DWELLIR_FINAL_STATE_PROBE_BLOCK_NUMBER,
  DWELLIR_FINAL_STATE_PROBE_ENDPOINT,
  DWELLIR_FINAL_STATE_PROBE_STATE_ROOT,
  DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY,
} from './dwellir-final-state.js';
import { SubstrateArchiveProbeInputError } from '../utils/errors.js';

export {
  DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
  DWELLIR_FINAL_STATE_PROBE_BLOCK_NUMBER,
  DWELLIR_FINAL_STATE_PROBE_ENDPOINT,
  DWELLIR_FINAL_STATE_PROBE_STATE_ROOT,
  DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY,
} from './dwellir-final-state.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const RETRY_DELAYS_MS = [1_000, 3_000, 5_000] as const;
const CURL_STATUS_MARKER = '__XCDOT_HTTP_STATUS__:';

export type DwellirDirectFieldStatus = 'PASS' | 'FAIL' | 'NOT_RUN';
export type DwellirDirectStatus =
  | 'DWELLIR_HISTORICAL_PROOF_CAPABLE'
  | 'DWELLIR_HISTORICAL_STORAGE_ONLY'
  | 'DWELLIR_ARCHIVE_STATE_UNAVAILABLE'
  | 'DWELLIR_READ_PROOF_INVALID'
  | 'DWELLIR_TRANSPORT_ERROR'
  | 'DWELLIR_TIMEOUT'
  | 'DWELLIR_AUTH_FAILED'
  | 'DWELLIR_RATE_LIMITED'
  | 'DWELLIR_METHOD_NOT_FOUND'
  | 'DWELLIR_BLOCK_NOT_FOUND'
  | 'UNKNOWN_DWELLIR_ERROR';

export interface DwellirDirectRpcResponse {
  httpStatus: number;
  body: string;
}

export type DwellirDirectRpcExecutor = (
  endpoint: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
) => Promise<DwellirDirectRpcResponse>;

export interface DwellirDirectProbeOptions {
  endpointBase?: string;
  key?: string;
  timeoutMs?: number;
  retries?: number;
  out?: string;
  rpcExecutor?: DwellirDirectRpcExecutor;
  sleep?: (milliseconds: number) => Promise<void>;
  offlineVerifier?: (input: ArchiveOfflineProofInput) => Promise<ArchiveOfflineProofResult>;
  verifierBinary?: string;
  projectRoot?: string;
}

export interface DwellirDirectProbeReport {
  schemaVersion: 1;
  provider: 'DWELLIR';
  endpoint: string;
  dwellirKeyPresent: boolean;
  blockNumber: string;
  blockHash: string;
  expectedStateRoot: string;
  storage: {
    status: DwellirDirectFieldStatus;
    httpStatus?: number;
    valueByteLength?: number;
    valueSha256?: string;
    rpcError?: string;
  };
  readProof: {
    status: DwellirDirectFieldStatus;
    httpStatus?: number;
    nodeCount?: number;
    rpcError?: string;
  };
  offlineProof: {
    status: 'PASS' | 'FAIL' | 'UNAVAILABLE' | 'NOT_RUN';
    detail?: string;
  };
  canReconstructFinalState: boolean;
  canGenerateVerifiableProofs: boolean;
  status: DwellirDirectStatus;
  errorStage?: string;
  errorDetail?: string;
}

export interface DwellirDirectProbeResult {
  outputDirectory: string;
  report: DwellirDirectProbeReport;
  reportText: string;
}

class DwellirDirectError extends Error {
  readonly code: DwellirDirectStatus;
  readonly transient: boolean;
  readonly httpStatus: number | undefined;
  readonly rpcCode: number | undefined;

  constructor(
    code: DwellirDirectStatus,
    message: string,
    options: { transient?: boolean; httpStatus?: number; rpcCode?: number } = {},
  ) {
    super(message);
    this.name = 'DwellirDirectError';
    this.code = code;
    this.transient = options.transient ?? false;
    this.httpStatus = options.httpStatus;
    this.rpcCode = options.rpcCode;
  }
}

function inputError(message: string, details: Record<string, string | number | boolean> = {}) {
  return new SubstrateArchiveProbeInputError(message, details);
}

function safeText(value: unknown): string {
  if (value instanceof DwellirDirectError) {
    return [
      value.message,
      value.httpStatus === undefined ? undefined : `httpStatus=${value.httpStatus}`,
      value.rpcCode === undefined ? undefined : `rpcCode=${value.rpcCode}`,
    ]
      .filter((item): item is string => item !== undefined)
      .join('; ');
  }
  if (value instanceof Error) {
    const cause = (value as Error & { cause?: unknown }).cause;
    return `${value.name}: ${value.message}${cause === undefined ? '' : `; cause=${safeText(cause)}`}`;
  }
  return String(value);
}

function redact(value: string, key: string): string {
  if (key === '') return value;
  return [key, encodeURIComponent(key)].reduce(
    (redacted, candidate) => redacted.split(candidate).join('<redacted-key>'),
    value,
  );
}

function safeDetail(value: unknown, key: string): string {
  return redact(safeText(value), key);
}

function bodyPreview(value: string): string {
  return value.length > 4096 ? `${value.slice(0, 4096)}…` : value;
}

function transientHttpStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function hashSha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseHex(value: unknown, label: string, nonEmpty = false): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new DwellirDirectError('UNKNOWN_DWELLIR_ERROR', `${label} is not valid even-length hex.`);
  }
  if (nonEmpty && value.length <= 2) {
    throw new DwellirDirectError('DWELLIR_ARCHIVE_STATE_UNAVAILABLE', `${label} is empty.`);
  }
  return value.toLowerCase();
}

function parseJsonRpcBody(body: string, method: string, httpStatus: number): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new DwellirDirectError(
      httpStatus >= 500 ? 'DWELLIR_TRANSPORT_ERROR' : 'UNKNOWN_DWELLIR_ERROR',
      `HTTP ${httpStatus} returned non-JSON body: ${bodyPreview(body)}`,
      { httpStatus, transient: httpStatus === 429 || httpStatus >= 500 },
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new DwellirDirectError(
      'UNKNOWN_DWELLIR_ERROR',
      `${method} returned a non-object JSON body.`,
      {
        httpStatus,
      },
    );
  }
  const record = parsed as Record<string, unknown>;
  if (httpStatus === 401 || httpStatus === 403) {
    throw new DwellirDirectError('DWELLIR_AUTH_FAILED', JSON.stringify(record), { httpStatus });
  }
  if (httpStatus === 429) {
    throw new DwellirDirectError('DWELLIR_RATE_LIMITED', JSON.stringify(record), {
      httpStatus,
      transient: true,
    });
  }
  if ('error' in record) {
    const error =
      typeof record.error === 'object' && record.error !== null
        ? (record.error as Record<string, unknown>)
        : {};
    const rpcCode = typeof error.code === 'number' ? error.code : undefined;
    const message =
      typeof error.message === 'string' ? error.message : JSON.stringify(record.error);
    const lower = message.toLowerCase();
    const blockNotFound =
      /unknown block|block[^\n]*(not found|unavailable|missing)|cannot find[^\n]*block/i.test(
        lower,
      );
    const methodNotFound = rpcCode === -32601 || /method not found/i.test(lower);
    const code = methodNotFound
      ? 'DWELLIR_METHOD_NOT_FOUND'
      : blockNotFound
        ? 'DWELLIR_BLOCK_NOT_FOUND'
        : method === 'state_getStorage'
          ? 'DWELLIR_ARCHIVE_STATE_UNAVAILABLE'
          : 'UNKNOWN_DWELLIR_ERROR';
    throw new DwellirDirectError(code, JSON.stringify(record.error), {
      httpStatus,
      transient: transientHttpStatus(httpStatus) && !methodNotFound && !blockNotFound,
      ...(rpcCode === undefined ? {} : { rpcCode }),
    });
  }
  if (!('result' in record)) {
    throw new DwellirDirectError(
      'UNKNOWN_DWELLIR_ERROR',
      `Missing JSON-RPC result for ${method}.`,
      {
        httpStatus,
      },
    );
  }
  return record.result;
}

async function defaultRpcExecutor(
  endpoint: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<DwellirDirectRpcResponse> {
  const result = await execFileAsync(
    'curl',
    [
      '--silent',
      '--show-error',
      '--max-time',
      String(timeoutMs / 1000),
      '--request',
      'POST',
      '--header',
      'Content-Type: application/json',
      '--data-raw',
      JSON.stringify(payload),
      '--write-out',
      `\n${CURL_STATUS_MARKER}%{http_code}\n`,
      endpoint,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const marker = `\n${CURL_STATUS_MARKER}`;
  const markerIndex = result.stdout.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new DwellirDirectError('UNKNOWN_DWELLIR_ERROR', 'curl returned no HTTP status marker.');
  }
  const httpStatus = Number(result.stdout.slice(markerIndex + marker.length).trim());
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    throw new DwellirDirectError('UNKNOWN_DWELLIR_ERROR', 'curl returned an invalid HTTP status.');
  }
  return { httpStatus, body: result.stdout.slice(0, markerIndex) };
}

async function retryRpc<T>(
  operation: () => Promise<T>,
  retries: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<T> {
  let lastError: DwellirDirectError | undefined;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const normalized = normalizeError(error);
      lastError = normalized;
      if (!normalized.transient || attempt === retries) throw normalized;
      await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? 5000);
    }
  }
  throw lastError ?? new DwellirDirectError('UNKNOWN_DWELLIR_ERROR', 'Dwellir request failed.');
}

function normalizeError(error: unknown): DwellirDirectError {
  if (error instanceof DwellirDirectError) return error;
  const message = safeText(error);
  if (/timeout|timed out|operation timed out/i.test(message)) {
    return new DwellirDirectError('DWELLIR_TIMEOUT', message, { transient: true });
  }
  return new DwellirDirectError('DWELLIR_TRANSPORT_ERROR', message, { transient: true });
}

function reportText(report: DwellirDirectProbeReport): string {
  const fieldValue = (value: string | number | boolean | undefined): string => {
    if (value === undefined) return 'NOT_RECORDED';
    if (typeof value !== 'string') return String(value);
    return value.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
  };
  const line = (key: string, value: string | number | boolean | undefined): string =>
    `${key}=${fieldValue(value)}`;
  return [
    line('PROVIDER', report.provider),
    line('ENDPOINT', report.endpoint),
    line('DWELLIR_KEY_PRESENT', report.dwellirKeyPresent),
    '',
    line('BLOCK_NUMBER', report.blockNumber),
    line('BLOCK_HASH', report.blockHash),
    line('EXPECTED_STATE_ROOT', report.expectedStateRoot),
    '',
    line('HISTORICAL_STORAGE', report.storage.status),
    line('CODE_VALUE_BYTE_LENGTH', report.storage.valueByteLength),
    line('CODE_VALUE_SHA256', report.storage.valueSha256),
    line('STORAGE_HTTP_STATUS', report.storage.httpStatus),
    line('STORAGE_RPC_ERROR', report.storage.rpcError),
    '',
    line('READ_PROOF_RPC', report.readProof.status),
    line('READ_PROOF_NODE_COUNT', report.readProof.nodeCount),
    line('READ_PROOF_HTTP_STATUS', report.readProof.httpStatus),
    line('READ_PROOF_OFFLINE_VERIFY', report.offlineProof.status),
    line('READ_PROOF_RPC_ERROR', report.readProof.rpcError),
    '',
    line('CAN_RECONSTRUCT_FINAL_STATE', report.canReconstructFinalState),
    line('CAN_GENERATE_VERIFIABLE_PROOFS', report.canGenerateVerifiableProofs),
    line('STATUS', report.status),
    line('ERROR_STAGE', report.errorStage),
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

async function persist(
  outputDirectory: string,
  report: DwellirDirectProbeReport,
  artifacts: { storage: unknown; readProof: unknown; offlineProof?: unknown },
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const writes = [
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

function initialReport(endpoint: string, keyPresent: boolean): DwellirDirectProbeReport {
  return {
    schemaVersion: 1,
    provider: 'DWELLIR',
    endpoint,
    dwellirKeyPresent: keyPresent,
    blockNumber: DWELLIR_FINAL_STATE_PROBE_BLOCK_NUMBER,
    blockHash: DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
    expectedStateRoot: DWELLIR_FINAL_STATE_PROBE_STATE_ROOT,
    storage: { status: 'NOT_RUN' },
    readProof: { status: 'NOT_RUN' },
    offlineProof: { status: 'NOT_RUN' },
    canReconstructFinalState: false,
    canGenerateVerifiableProofs: false,
    status: 'UNKNOWN_DWELLIR_ERROR',
  };
}

function initialArtifacts(): {
  storage: Record<string, unknown>;
  readProof: Record<string, unknown>;
  offlineProof?: Record<string, unknown>;
} {
  return {
    storage: {
      status: 'NOT_RUN',
      method: 'state_getStorage',
      key: DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY,
      blockHash: DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
    },
    readProof: {
      status: 'NOT_RUN',
      method: 'state_getReadProof',
      keys: [DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY],
      blockHash: DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
    },
  };
}

function setFailure(
  report: DwellirDirectProbeReport,
  status: DwellirDirectStatus,
  stage: string,
  detail: string,
): void {
  report.status = status;
  report.errorStage = stage;
  report.errorDetail = detail;
}

export async function runDwellirFinalStateDirectProbe(
  options: DwellirDirectProbeOptions = {},
): Promise<DwellirDirectProbeResult> {
  const endpointBase = options.endpointBase ?? DWELLIR_FINAL_STATE_PROBE_ENDPOINT;
  const key = (options.key ?? process.env.DWELLIR_KEY)?.trim() ?? '';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const outputDirectory = resolve(options.out ?? 'diagnostics/dwellir-final-state-direct-probe');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw inputError('Dwellir timeout must be an integer from 1 to 120000 ms.', { timeoutMs });
  }
  if (!Number.isInteger(retries) || retries < 1 || retries > 5) {
    throw inputError('Dwellir retries must be an integer from 1 to 5.', { retries });
  }
  const report = initialReport(endpointBase, key !== '');
  const artifacts = initialArtifacts();
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  const endpoint = `${endpointBase}${encodeURIComponent(key)}`;
  const executor = options.rpcExecutor ?? defaultRpcExecutor;

  if (key === '') {
    setFailure(report, 'DWELLIR_AUTH_FAILED', 'credentials', 'DWELLIR_KEY is not set.');
    report.storage.status = 'FAIL';
    artifacts.storage = { ...artifacts.storage, status: 'FAIL', error: report.errorDetail };
    await persist(outputDirectory, report, artifacts);
    return { outputDirectory, report, reportText: reportText(report) };
  }

  const storagePayload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'state_getStorage',
    params: [DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY, DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH],
  };
  let storageValue: string;
  try {
    const response = await retryRpc(
      async () => {
        const raw = await executor(endpoint, storagePayload, timeoutMs);
        report.storage.httpStatus = raw.httpStatus;
        return parseJsonRpcBody(raw.body, 'state_getStorage', raw.httpStatus);
      },
      retries,
      sleep,
    );
    storageValue = parseHex(response, 'state_getStorage result', true);
    const bytes = Buffer.from(storageValue.slice(2), 'hex');
    report.storage = {
      status: 'PASS',
      ...(report.storage.httpStatus === undefined ? {} : { httpStatus: report.storage.httpStatus }),
      valueByteLength: bytes.length,
      valueSha256: hashSha256(bytes),
    };
    artifacts.storage = {
      status: 'PASS',
      method: 'state_getStorage',
      key: DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY,
      blockHash: DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
      httpStatus: report.storage.httpStatus,
      result: storageValue,
    };
    report.canReconstructFinalState = true;
  } catch (error) {
    const normalized = normalizeError(error);
    const detail = safeDetail(normalized, key);
    report.storage = {
      status: 'FAIL',
      ...(report.storage.httpStatus === undefined ? {} : { httpStatus: report.storage.httpStatus }),
      rpcError: detail,
    };
    artifacts.storage = {
      ...artifacts.storage,
      status: 'FAIL',
      ...(report.storage.httpStatus === undefined ? {} : { httpStatus: report.storage.httpStatus }),
      errorCode: normalized.code,
      error: detail,
    };
    const status =
      normalized.code === 'DWELLIR_TIMEOUT' || normalized.code === 'DWELLIR_TRANSPORT_ERROR'
        ? normalized.code
        : normalized.code === 'DWELLIR_AUTH_FAILED'
          ? normalized.code
          : 'DWELLIR_ARCHIVE_STATE_UNAVAILABLE';
    setFailure(report, status, 'state_getStorage', detail);
    await persist(outputDirectory, report, artifacts);
    return { outputDirectory, report, reportText: reportText(report) };
  }

  const proofPayload = {
    jsonrpc: '2.0',
    id: 2,
    method: 'state_getReadProof',
    params: [[DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY], DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH],
  };
  let proofNodes: string[];
  try {
    const response = await retryRpc(
      async () => {
        const raw = await executor(endpoint, proofPayload, timeoutMs);
        report.readProof.httpStatus = raw.httpStatus;
        return parseJsonRpcBody(raw.body, 'state_getReadProof', raw.httpStatus);
      },
      retries,
      sleep,
    );
    if (typeof response !== 'object' || response === null) {
      throw new DwellirDirectError(
        'DWELLIR_READ_PROOF_INVALID',
        'state_getReadProof result is not an object.',
      );
    }
    const record = response as Record<string, unknown>;
    const at = parseHex(record.at, 'state_getReadProof.at', true);
    if (at !== DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH) {
      throw new DwellirDirectError(
        'DWELLIR_READ_PROOF_INVALID',
        `state_getReadProof returned at=${at}.`,
      );
    }
    if (!Array.isArray(record.proof) || record.proof.length === 0) {
      throw new DwellirDirectError(
        'DWELLIR_READ_PROOF_INVALID',
        'state_getReadProof returned no proof nodes.',
      );
    }
    proofNodes = record.proof.map((node, index) => parseHex(node, `proof node ${index}`, true));
    report.readProof = {
      status: 'PASS',
      ...(report.readProof.httpStatus === undefined
        ? {}
        : { httpStatus: report.readProof.httpStatus }),
      nodeCount: proofNodes.length,
    };
    artifacts.readProof = {
      status: 'PASS',
      method: 'state_getReadProof',
      keys: [DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY],
      blockHash: DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
      httpStatus: report.readProof.httpStatus,
      result: { at, proof: proofNodes },
    };
  } catch (error) {
    const normalized = normalizeError(error);
    const detail = safeDetail(normalized, key);
    report.readProof = {
      status: 'FAIL',
      ...(report.readProof.httpStatus === undefined
        ? {}
        : { httpStatus: report.readProof.httpStatus }),
      rpcError: detail,
    };
    artifacts.readProof = {
      ...artifacts.readProof,
      status: 'FAIL',
      ...(report.readProof.httpStatus === undefined
        ? {}
        : { httpStatus: report.readProof.httpStatus }),
      errorCode: normalized.code,
      error: detail,
    };
    if (normalized.code === 'DWELLIR_READ_PROOF_INVALID') {
      setFailure(report, 'DWELLIR_READ_PROOF_INVALID', 'state_getReadProof', detail);
    } else {
      report.status = 'DWELLIR_HISTORICAL_STORAGE_ONLY';
      report.errorStage = 'state_getReadProof';
      report.errorDetail = detail;
    }
    await persist(outputDirectory, report, artifacts);
    return { outputDirectory, report, reportText: reportText(report) };
  }

  const offlineInput: ArchiveOfflineProofInput = {
    schemaVersion: 1,
    blockHash: DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
    stateRoot: DWELLIR_FINAL_STATE_PROBE_STATE_ROOT,
    stateVersion: 1,
    key: DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY,
    value: storageValue,
    proof: proofNodes,
  };
  let offline: ArchiveOfflineProofResult;
  try {
    offline =
      options.offlineVerifier === undefined
        ? await verifyArchiveProofOffline(offlineInput, {
            ...(options.verifierBinary === undefined
              ? {}
              : { verifierBinary: options.verifierBinary }),
            ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
          })
        : await options.offlineVerifier(offlineInput);
  } catch (error) {
    offline = { status: 'FAIL', detail: safeDetail(error, key) };
  }
  report.offlineProof = {
    status: offline.status,
    ...(offline.detail === undefined ? {} : { detail: safeDetail(offline.detail, key) }),
  };
  artifacts.offlineProof = {
    status: offline.status,
    blockHash: DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH,
    stateRoot: DWELLIR_FINAL_STATE_PROBE_STATE_ROOT,
    stateVersion: 1,
    key: DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY,
    ...(offline.detail === undefined ? {} : { detail: safeDetail(offline.detail, key) }),
    ...(offline.stdout === undefined ? {} : { stdout: safeDetail(offline.stdout, key) }),
    ...(offline.stderr === undefined ? {} : { stderr: safeDetail(offline.stderr, key) }),
  };
  if (offline.status === 'PASS') {
    report.canGenerateVerifiableProofs = true;
    report.status = 'DWELLIR_HISTORICAL_PROOF_CAPABLE';
  } else {
    report.status = 'DWELLIR_HISTORICAL_STORAGE_ONLY';
    report.errorStage = 'offline-proof';
    report.errorDetail =
      offline.detail === undefined
        ? 'Offline proof verification did not pass.'
        : safeDetail(offline.detail, key);
  }
  await persist(outputDirectory, report, artifacts);
  return { outputDirectory, report, reportText: reportText(report) };
}
