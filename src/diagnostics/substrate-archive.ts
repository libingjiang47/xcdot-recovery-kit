import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { URL } from 'node:url';
import { WsProvider } from '@polkadot/rpc-provider';
import {
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
} from '../final-state/constants.js';
import { sha256Hex } from '../snapshot/digest.js';
import { SubstrateArchiveProbeInputError } from '../utils/errors.js';

const execFileAsync = promisify(execFile);

export const ARCHIVE_PROBE_BLOCK_NUMBER = '16796696' as const;
export const ARCHIVE_PROBE_BLOCK_HASH = MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH;
export const ARCHIVE_PROBE_STATE_ROOT = MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT;
export const ARCHIVE_PROBE_SPEC_VERSION = 4401 as const;
export const ARCHIVE_PROBE_STATE_VERSION = 1 as const;
export const ARCHIVE_PROBE_STORAGE_KEY = '0x3a636f6465' as const;

export type ArchiveProbeClassification =
  | 'UNREACHABLE'
  | 'HEADER_ONLY'
  | 'HISTORICAL_METADATA'
  | 'HISTORICAL_STORAGE'
  | 'HISTORICAL_PROOF'
  | 'NO_KNOWN_SUBSTRATE_ENDPOINT';

export type ArchiveProbeStatus = 'PASS' | 'FAIL' | 'NOT_RUN';

export type ArchiveErrorCode =
  | 'TRANSPORT_UNREACHABLE'
  | 'HTTP_ERROR'
  | 'WS_ERROR'
  | 'JSON_RPC_ERROR'
  | 'METHOD_NOT_FOUND'
  | 'BLOCK_NOT_FOUND'
  | 'PINNED_HEADER_MISMATCH'
  | 'HISTORICAL_RUNTIME_UNAVAILABLE'
  | 'HISTORICAL_METADATA_UNAVAILABLE'
  | 'HISTORICAL_STORAGE_UNAVAILABLE'
  | 'READ_PROOF_UNAVAILABLE'
  | 'READ_PROOF_INVALID'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'AUTH_REQUIRED'
  | 'WRONG_CHAIN'
  | 'RUNTIME_VERSION_MISMATCH'
  | 'UNKNOWN_PROVIDER_ERROR'
  | 'NO_KNOWN_SUBSTRATE_ENDPOINT';

export interface ArchiveProbeRpcClient {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

export interface ArchiveProbeRetryOptions {
  retries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class ArchiveRpcError extends Error {
  readonly code: ArchiveErrorCode;
  readonly transient: boolean;
  readonly method: string;
  readonly httpStatus: number | undefined;
  readonly rpcCode: number | undefined;
  attempts: number | undefined;

  constructor(
    code: ArchiveErrorCode,
    message: string,
    method: string,
    options: {
      transient?: boolean;
      httpStatus?: number;
      rpcCode?: number;
    } = {},
  ) {
    super(message);
    this.name = 'ArchiveRpcError';
    this.code = code;
    this.transient = options.transient ?? false;
    this.method = method;
    this.httpStatus = options.httpStatus;
    this.rpcCode = options.rpcCode;
  }
}

export interface SanitizedRpcUrl {
  scheme: string;
  host: string;
  credentialPresent: boolean;
  credentialsRedacted: boolean;
}

function inputError(message: string, details: Record<string, string | number | boolean> = {}) {
  return new SubstrateArchiveProbeInputError(message, details);
}

export function sanitizeRpcUrl(rpc: string): SanitizedRpcUrl {
  let parsed: URL;
  try {
    parsed = new URL(rpc);
  } catch (error) {
    throw inputError('Substrate RPC URL is invalid.', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!['http', 'https', 'ws', 'wss'].includes(scheme) || parsed.host === '') {
    throw inputError('Substrate RPC URL must use http(s) or ws(s) with a host.', { scheme });
  }
  const credentialPresent =
    parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0;
  return {
    scheme,
    host: parsed.host,
    credentialPresent,
    credentialsRedacted: credentialPresent,
  };
}

function redactUrls(text: string): string {
  return text.replace(/\b([a-z][a-z\d+.-]*:\/\/[^\s)]+)/gi, (value) => {
    try {
      const parsed = new URL(value);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return '<redacted-url>';
    }
  });
}

function errorDetail(error: unknown): string {
  if (error instanceof ArchiveRpcError) {
    const transportDetails = [
      error.rpcCode === undefined ? undefined : `rpcCode=${error.rpcCode}`,
      error.httpStatus === undefined ? undefined : `httpStatus=${error.httpStatus}`,
    ].filter((detail): detail is string => detail !== undefined);
    return redactUrls(
      [error.message, ...transportDetails].filter((detail) => detail.length > 0).join('; '),
    );
  }
  if (error instanceof Error) return redactUrls(`${error.name}: ${error.message}`);
  return redactUrls(String(error));
}

function errorCode(error: unknown, method: string): ArchiveErrorCode {
  if (error instanceof ArchiveRpcError) return error.code;
  const text = errorDetail(error);
  if (/timeout|timed out|abort/i.test(text)) return 'TIMEOUT';
  if (/websocket|web socket|ws error|abnormal closure/i.test(text)) return 'WS_ERROR';
  if (/fetch failed|network|econn|socket|connection/i.test(text)) return 'TRANSPORT_UNREACHABLE';
  if (/method not found|-32601/i.test(text)) return 'METHOD_NOT_FOUND';
  return method.startsWith('state_') || method.startsWith('chain_')
    ? 'UNKNOWN_PROVIDER_ERROR'
    : 'TRANSPORT_UNREACHABLE';
}

function transientError(error: unknown): boolean {
  if (error instanceof ArchiveRpcError) return error.transient;
  return /timeout|timed out|fetch failed|network|econn|socket|429|502|503|504|temporar/i.test(
    errorDetail(error),
  );
}

function normalizeError(error: unknown, method: string): ArchiveRpcError {
  if (error instanceof ArchiveRpcError) return error;
  const code = errorCode(error, method);
  return new ArchiveRpcError(code, errorDetail(error), method, {
    transient: transientError(error),
  });
}

function bodyPreview(value: string): string {
  return value.length > 4096 ? `${value.slice(0, 4096)}…` : value;
}

function historicalUnavailableCode(method: string, message: string): ArchiveErrorCode | undefined {
  if (!/state_get(RuntimeVersion|Metadata|Storage)|state_getReadProof/.test(method)) {
    return undefined;
  }
  if (!/state|histor|prun|discard|archive|old|block|unavailable|missing/i.test(message)) {
    return undefined;
  }
  if (method === 'state_getRuntimeVersion') return 'HISTORICAL_RUNTIME_UNAVAILABLE';
  if (method === 'state_getMetadata') return 'HISTORICAL_METADATA_UNAVAILABLE';
  if (method === 'state_getStorage') return 'HISTORICAL_STORAGE_UNAVAILABLE';
  return 'READ_PROOF_UNAVAILABLE';
}

function rpcErrorFromResponse(
  method: string,
  value: unknown,
  httpStatus?: number,
): ArchiveRpcError {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  const error = record?.error;
  const errorRecord =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  const rpcCode = typeof errorRecord?.code === 'number' ? errorRecord.code : undefined;
  const message =
    typeof errorRecord?.message === 'string'
      ? errorRecord.message
      : `JSON-RPC request failed for ${method}`;
  const lowerMessage = message.toLowerCase();
  const blockNotFound =
    /unknown block|block[^\n]*(not found|unavailable|missing)|cannot find[^\n]*block/i.test(
      lowerMessage,
    );
  const historicalCode = historicalUnavailableCode(method, message);
  const code: ArchiveErrorCode =
    rpcCode === -32601
      ? 'METHOD_NOT_FOUND'
      : httpStatus === 401 || httpStatus === 403
        ? 'AUTH_REQUIRED'
        : httpStatus === 429
          ? 'RATE_LIMITED'
          : blockNotFound
            ? 'BLOCK_NOT_FOUND'
            : (historicalCode ?? 'JSON_RPC_ERROR');
  return new ArchiveRpcError(code, message, method, {
    transient: httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(rpcCode === undefined ? {} : { rpcCode }),
  });
}

class HttpArchiveRpcClient implements ArchiveProbeRpcClient {
  private nextId = 1;

  constructor(
    private readonly rpc: string,
    private readonly timeoutMs: number,
  ) {}

  async request(method: string, params: readonly unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params: [...params] }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ArchiveRpcError('TIMEOUT', `Request timed out for ${method}.`, method, {
          transient: true,
        });
      }
      throw new ArchiveRpcError('TRANSPORT_UNREACHABLE', errorDetail(error), method, {
        transient: true,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = bodyPreview(await response.text());
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new ArchiveRpcError(
        'HTTP_ERROR',
        `HTTP ${response.status} returned invalid JSON: ${errorDetail(error)}; body=${text}`,
        method,
        {
          transient: response.status === 429 || response.status >= 500,
          httpStatus: response.status,
        },
      );
    }
    if (!response.ok) throw rpcErrorFromResponse(method, parsed, response.status);
    if (typeof parsed !== 'object' || parsed === null || !('result' in parsed)) {
      throw rpcErrorFromResponse(method, parsed);
    }
    if ('error' in parsed) throw rpcErrorFromResponse(method, parsed);
    return (parsed as { result: unknown }).result;
  }

  async close(): Promise<void> {}
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, method: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(
        new ArchiveRpcError('TIMEOUT', `Request timed out for ${method}.`, method, {
          transient: true,
        }),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

class WsArchiveRpcClient implements ArchiveProbeRpcClient {
  private connected = false;

  constructor(
    private readonly provider: WsProvider,
    private readonly timeoutMs: number,
  ) {}

  async connect(): Promise<void> {
    try {
      const connecting = this.provider.connect();
      const ready = this.provider.isReady;
      await promiseWithTimeout(
        Promise.all([connecting, ready]).then(([, provider]) => provider),
        this.timeoutMs,
        'ws_connect',
      );
      this.connected = true;
    } catch (error) {
      const normalized = normalizeError(error, 'ws_connect');
      if (normalized.code === 'TIMEOUT') throw normalized;
      throw new ArchiveRpcError('WS_ERROR', normalized.message, 'ws_connect', {
        transient: normalized.transient,
      });
    }
  }

  async request(method: string, params: readonly unknown[]): Promise<unknown> {
    if (!this.connected) {
      throw new ArchiveRpcError('WS_ERROR', 'WebSocket provider is not connected.', method, {
        transient: true,
      });
    }
    return promiseWithTimeout(
      this.provider.send(method, [...params], false),
      this.timeoutMs,
      method,
    );
  }

  async close(): Promise<void> {
    await this.provider.disconnect();
    this.connected = false;
  }
}

export async function createSubstrateArchiveRpcClient(
  rpc: string,
  timeoutMs: number,
): Promise<ArchiveProbeRpcClient> {
  const sanitized = sanitizeRpcUrl(rpc);
  if (sanitized.scheme === 'http' || sanitized.scheme === 'https') {
    return new HttpArchiveRpcClient(rpc, timeoutMs);
  }
  const provider = new WsProvider(rpc, false, {}, timeoutMs);
  const client = new WsArchiveRpcClient(provider, timeoutMs);
  try {
    await client.connect();
    return client;
  } catch (error) {
    await provider.disconnect().catch(() => undefined);
    throw error;
  }
}

export async function retryArchiveRpc<T>(
  operation: () => Promise<T>,
  options: ArchiveProbeRetryOptions = {},
): Promise<{ value: T; attempts: number }> {
  const retries = options.retries ?? 3;
  if (!Number.isInteger(retries) || retries < 1 || retries > 10) {
    throw inputError('Archive probe retries must be an integer from 1 to 10.', { retries });
  }
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  let lastError: ArchiveRpcError | undefined;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return { value: await operation(), attempts: attempt };
    } catch (error) {
      const normalized = normalizeError(error, 'archive_probe');
      normalized.attempts = attempt;
      lastError = normalized;
      if (!normalized.transient || attempt === retries) throw normalized;
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
  throw lastError ?? new ArchiveRpcError('UNKNOWN_PROVIDER_ERROR', 'RPC failed.', 'archive_probe');
}

interface CallSuccess<T> {
  ok: true;
  value: T;
  attempts: number;
}

interface CallFailure {
  ok: false;
  error: ArchiveRpcError;
  attempts: number;
}

type CallOutcome<T> = CallSuccess<T> | CallFailure;

async function callRpc(
  client: ArchiveProbeRpcClient,
  method: string,
  params: readonly unknown[],
  retries: number,
): Promise<CallOutcome<unknown>> {
  try {
    const result = await retryArchiveRpc(() => client.request(method, params), { retries });
    return { ok: true, value: result.value, attempts: result.attempts };
  } catch (error) {
    const normalized = normalizeError(error, method);
    return { ok: false, error: normalized, attempts: normalized.attempts ?? retries };
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArchiveRpcError('JSON_RPC_ERROR', `${label} is not an object.`, label);
  }
  return value as Record<string, unknown>;
}

function asHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new ArchiveRpcError('JSON_RPC_ERROR', `${label} is not valid even-length hex.`, label);
  }
  return value.toLowerCase();
}

function asHash(value: unknown, label: string): string {
  const hex = asHex(value, label);
  if (hex.length !== 66) {
    throw new ArchiveRpcError('JSON_RPC_ERROR', `${label} is not a 32-byte hash.`, label);
  }
  return hex;
}

function asNumber(value: unknown, label: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);
  throw new ArchiveRpcError('JSON_RPC_ERROR', `${label} is not an unsigned integer.`, label);
}

function numberText(value: unknown, label: string): string {
  return asNumber(value, label).toString(10);
}

function statusPass(attempts: number): { status: 'PASS'; attempts: number } {
  return { status: 'PASS', attempts };
}

function statusFail(
  failure: CallFailure | ArchiveRpcError,
  fallbackCode?: ArchiveErrorCode,
): {
  status: 'FAIL';
  attempts: number;
  errorCode: ArchiveErrorCode;
  errorDetail: string;
} {
  if ('ok' in failure) {
    return {
      status: 'FAIL',
      attempts: failure.attempts,
      errorCode: failure.error.code,
      errorDetail: errorDetail(failure.error),
    };
  }
  return {
    status: 'FAIL',
    attempts: failure.attempts ?? 1,
    errorCode: fallbackCode ?? failure.code,
    errorDetail: errorDetail(failure),
  };
}

export interface ArchiveProbeMethodResult {
  status: ArchiveProbeStatus;
  attempts?: number;
  errorCode?: ArchiveErrorCode;
  errorDetail?: string;
}

export interface ArchiveProbeReport {
  schemaVersion: 1;
  provider: string;
  rpc: SanitizedRpcUrl;
  block: {
    hash: string;
    number: string;
    expectedStateRoot: string;
    observedStateRoot?: string;
  };
  transport: ArchiveProbeMethodResult & { rpcMethod: 'system_chain'; chain?: string };
  header: ArchiveProbeMethodResult & {
    number?: string;
    parentHash?: string;
    stateRoot?: string;
    extrinsicsRoot?: string;
  };
  runtime: ArchiveProbeMethodResult & {
    specName?: string;
    implName?: string;
    authoringVersion?: string;
    specVersion?: string;
    implVersion?: string;
    transactionVersion?: string;
    stateVersion?: string;
  };
  metadata: ArchiveProbeMethodResult & {
    bytes?: number;
    sha256?: string;
    prefix?: string;
    version?: number;
    decode?: 'NOT_RUN' | 'PASS' | 'FAIL';
    containsEvmHint?: boolean;
    containsAccountStoragesHint?: boolean;
  };
  storage: ArchiveProbeMethodResult & {
    key: string;
    valueBytes?: number;
    valueSha256?: string;
  };
  readProof: ArchiveProbeMethodResult & {
    key: string;
    at?: string;
    nodeCount?: number;
    bytes?: number;
    sha256?: string;
  };
  offlineProof: {
    status: 'PASS' | 'FAIL' | 'UNAVAILABLE' | 'NOT_RUN';
    detail?: string;
    stdout?: string;
    stderr?: string;
  };
  classification: ArchiveProbeClassification;
  errorCode?: ArchiveErrorCode;
  errorDetail?: string;
}

export interface ArchiveOfflineProofInput {
  schemaVersion: 1;
  blockHash: string;
  stateRoot: string;
  stateVersion: number;
  key: string;
  value: string;
  proof: string[];
}

export interface ArchiveOfflineProofResult {
  status: 'PASS' | 'FAIL' | 'UNAVAILABLE';
  detail?: string;
  stdout?: string;
  stderr?: string;
}

export type ArchiveOfflineVerifier = (
  input: ArchiveOfflineProofInput,
) => Promise<ArchiveOfflineProofResult>;

export interface SubstrateArchiveProbeOptions {
  rpc: string;
  providerName?: string;
  blockHash: string;
  timeoutMs?: number;
  retries?: number;
  out?: string;
  offlineVerifier?: ArchiveOfflineVerifier;
  verifierBinary?: string;
  projectRoot?: string;
}

interface ProbeArtifacts {
  transport: unknown;
  header: unknown;
  runtime: unknown;
  metadata: unknown;
  storage: unknown;
  readProof: unknown;
  offlineProof: unknown;
}

function initialReport(providerName: string, rpc: SanitizedRpcUrl): ArchiveProbeReport {
  return {
    schemaVersion: 1,
    provider: providerName,
    rpc,
    block: {
      hash: ARCHIVE_PROBE_BLOCK_HASH,
      number: ARCHIVE_PROBE_BLOCK_NUMBER,
      expectedStateRoot: ARCHIVE_PROBE_STATE_ROOT,
    },
    transport: { rpcMethod: 'system_chain', status: 'NOT_RUN' },
    header: { status: 'NOT_RUN' },
    runtime: { status: 'NOT_RUN' },
    metadata: { status: 'NOT_RUN', decode: 'NOT_RUN' },
    storage: { status: 'NOT_RUN', key: ARCHIVE_PROBE_STORAGE_KEY },
    readProof: { status: 'NOT_RUN', key: ARCHIVE_PROBE_STORAGE_KEY },
    offlineProof: { status: 'NOT_RUN' },
    classification: 'UNREACHABLE',
  };
}

function setGlobalFailure(
  report: ArchiveProbeReport,
  code: ArchiveErrorCode,
  detail: string,
): void {
  if (report.errorCode === undefined) {
    report.errorCode = code;
    report.errorDetail = detail;
  }
}

function metadataInfo(metadata: string): {
  bytes: number;
  sha256: string;
  prefix: string;
  version?: number;
  containsEvmHint: boolean;
  containsAccountStoragesHint: boolean;
} {
  const bytes = Buffer.from(metadata.slice(2), 'hex');
  const text = bytes.toString('utf8');
  return {
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    prefix: metadata.slice(0, 10),
    ...(bytes.length >= 5 ? { version: bytes[4] } : {}),
    containsEvmHint: text.includes('Evm') || text.includes('EVM'),
    containsAccountStoragesHint: text.includes('AccountStorages'),
  };
}

function reportText(report: ArchiveProbeReport): string {
  const value = (item: { status: ArchiveProbeStatus; attempts?: number }): string =>
    item.status === 'NOT_RUN' ? 'NOT_RUN' : item.status;
  const line = (key: string, item: string | number | boolean | undefined): string =>
    `${key}=${item === undefined ? 'NOT_RECORDED' : item}`;
  return [
    line('PROVIDER', report.provider),
    line('RPC_SCHEME', report.rpc.scheme),
    line('RPC_HOST', report.rpc.host),
    line('CREDENTIAL_PRESENCE', report.rpc.credentialPresent),
    line('CREDENTIALS_REDACTED', report.rpc.credentialsRedacted),
    '',
    line('BLOCK_HASH', report.block.hash),
    line('BLOCK_NUMBER', report.block.number),
    line('EXPECTED_STATE_ROOT', report.block.expectedStateRoot),
    line('OBSERVED_STATE_ROOT', report.block.observedStateRoot),
    '',
    line('TRANSPORT_RPC', value(report.transport)),
    line('CHAIN', report.transport.chain),
    line('CHAIN_GET_HEADER', value(report.header)),
    line('HEADER_NUMBER', report.header.number),
    line('STATE_GET_RUNTIME_VERSION', value(report.runtime)),
    line('SPEC_VERSION', report.runtime.specVersion),
    line('STATE_VERSION', report.runtime.stateVersion),
    line('STATE_GET_METADATA', value(report.metadata)),
    line('METADATA_BYTES', report.metadata.bytes),
    line('METADATA_SHA256', report.metadata.sha256),
    line('METADATA_DECODE', report.metadata.decode),
    line('STATE_GET_STORAGE', value(report.storage)),
    line('STORAGE_KEY', report.storage.key),
    line('STORAGE_VALUE_BYTES', report.storage.valueBytes),
    line('STORAGE_VALUE_SHA256', report.storage.valueSha256),
    line('STATE_GET_READ_PROOF', value(report.readProof)),
    line('READ_PROOF_AT', report.readProof.at),
    line('READ_PROOF_NODE_COUNT', report.readProof.nodeCount),
    line('READ_PROOF_BYTES', report.readProof.bytes),
    line('READ_PROOF_SHA256', report.readProof.sha256),
    line('READ_PROOF_OFFLINE_VERIFY', report.offlineProof.status),
    '',
    line('CLASSIFICATION', report.classification),
    line('ERROR_CODE', report.errorCode),
    `ERROR_DETAIL=${JSON.stringify(report.errorDetail ?? '')}`,
    '',
  ].join('\n');
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, contents, 'utf8');
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
  report: ArchiveProbeReport,
  artifacts: ProbeArtifacts,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeJson(join(outputDirectory, 'report.json'), report),
    writeJson(join(outputDirectory, 'transport.json'), artifacts.transport),
    writeJson(join(outputDirectory, 'header.json'), artifacts.header),
    writeJson(join(outputDirectory, 'runtime-version.json'), artifacts.runtime),
    writeJson(join(outputDirectory, 'metadata.json'), artifacts.metadata),
    writeJson(join(outputDirectory, 'storage.json'), artifacts.storage),
    writeJson(join(outputDirectory, 'read-proof.json'), artifacts.readProof),
    writeJson(join(outputDirectory, 'offline-proof.json'), artifacts.offlineProof),
    writeAtomic(join(outputDirectory, 'report.txt'), reportText(report)),
  ]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultOfflineVerifier(
  input: ArchiveOfflineProofInput,
  options: SubstrateArchiveProbeOptions,
): Promise<ArchiveOfflineProofResult> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'xcdot-archive-proof-'));
  try {
    await writeFile(
      join(temporaryDirectory, 'archive-probe.json'),
      JSON.stringify(input, null, 2) + '\n',
      'utf8',
    );
    const projectRoot = resolve(options.projectRoot ?? process.cwd());
    const configuredBinary = options.verifierBinary ?? process.env.EVIDENCE_VERIFIER_BIN;
    const localBinary = join(projectRoot, 'target/debug/evidence-verifier');
    let command: string;
    let args: string[];
    let cwd: string | undefined;
    if (configuredBinary !== undefined) {
      command = configuredBinary;
      args = [temporaryDirectory, '--archive-probe'];
    } else if (await pathExists(localBinary)) {
      command = localBinary;
      args = [temporaryDirectory, '--archive-probe'];
    } else {
      command = 'cargo';
      args = [
        'run',
        '--quiet',
        '--manifest-path',
        join(projectRoot, 'crates/evidence-verifier/Cargo.toml'),
        '--',
        temporaryDirectory,
        '--archive-probe',
      ];
      cwd = projectRoot;
    }
    try {
      const result = await execFileAsync(command, args, {
        ...(cwd === undefined ? {} : { cwd }),
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return {
        status: 'PASS',
        ...(result.stdout ? { stdout: result.stdout.trim() } : {}),
        ...(result.stderr ? { stderr: result.stderr.trim() } : {}),
      };
    } catch (error) {
      const child = error as { stdout?: string; stderr?: string };
      return {
        status: 'FAIL',
        detail: errorDetail(error),
        ...(child.stdout ? { stdout: child.stdout.trim() } : {}),
        ...(child.stderr ? { stderr: child.stderr.trim() } : {}),
      };
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export interface SubstrateArchiveProbeResult {
  outputDirectory: string;
  report: ArchiveProbeReport;
  reportText: string;
}

export async function probeSubstrateArchive(
  options: SubstrateArchiveProbeOptions,
  suppliedClient?: ArchiveProbeRpcClient,
): Promise<SubstrateArchiveProbeResult> {
  const sanitized = sanitizeRpcUrl(options.rpc);
  if (options.blockHash.toLowerCase() !== ARCHIVE_PROBE_BLOCK_HASH) {
    throw inputError('Archive probe only accepts the pinned Moonbeam block hash.', {
      expectedBlockHash: ARCHIVE_PROBE_BLOCK_HASH,
      actualBlockHash: options.blockHash,
    });
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 3;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw inputError('Archive probe timeout must be an integer from 1 to 120000 ms.', {
      timeoutMs,
    });
  }
  if (!Number.isInteger(retries) || retries < 1 || retries > 10) {
    throw inputError('Archive probe retries must be an integer from 1 to 10.', { retries });
  }
  const providerName = options.providerName ?? sanitized.host;
  const outputDirectory = resolve(
    options.out ??
      join(
        'diagnostics/substrate-archive-probe',
        providerName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      ),
  );
  const report = initialReport(providerName, sanitized);
  const artifacts: ProbeArtifacts = {
    transport: { status: 'NOT_RUN', method: 'system_chain' },
    header: { status: 'NOT_RUN', method: 'chain_getHeader', blockHash: ARCHIVE_PROBE_BLOCK_HASH },
    runtime: {
      status: 'NOT_RUN',
      method: 'state_getRuntimeVersion',
      blockHash: ARCHIVE_PROBE_BLOCK_HASH,
    },
    metadata: {
      status: 'NOT_RUN',
      method: 'state_getMetadata',
      blockHash: ARCHIVE_PROBE_BLOCK_HASH,
    },
    storage: {
      status: 'NOT_RUN',
      method: 'state_getStorage',
      key: ARCHIVE_PROBE_STORAGE_KEY,
      blockHash: ARCHIVE_PROBE_BLOCK_HASH,
    },
    readProof: {
      status: 'NOT_RUN',
      method: 'state_getReadProof',
      keys: [ARCHIVE_PROBE_STORAGE_KEY],
      blockHash: ARCHIVE_PROBE_BLOCK_HASH,
    },
    offlineProof: { status: 'NOT_RUN' },
  };
  let client = suppliedClient;
  let ownsClient = false;
  if (client === undefined) {
    try {
      client = (
        await retryArchiveRpc(() => createSubstrateArchiveRpcClient(options.rpc, timeoutMs), {
          retries,
        })
      ).value;
      ownsClient = true;
    } catch (error) {
      const normalized = normalizeError(error, 'system_chain');
      report.transport = { rpcMethod: 'system_chain', ...statusFail(normalized) };
      setGlobalFailure(report, normalized.code, normalized.message);
      report.classification = 'UNREACHABLE';
      artifacts.transport = { status: 'FAIL', method: 'system_chain', error: normalized.message };
      await persistProbe(outputDirectory, report, artifacts);
      return { outputDirectory, report, reportText: reportText(report) };
    }
  }

  try {
    const transport = await callRpc(client, 'system_chain', [], retries);
    if (!transport.ok) {
      report.transport = { rpcMethod: 'system_chain', ...statusFail(transport) };
      setGlobalFailure(report, transport.error.code, errorDetail(transport.error));
      report.classification = 'UNREACHABLE';
    } else {
      const chain = typeof transport.value === 'string' ? transport.value : String(transport.value);
      report.transport = { rpcMethod: 'system_chain', ...statusPass(transport.attempts), chain };
      artifacts.transport = { status: 'PASS', method: 'system_chain', result: transport.value };
      if (!/moonbeam/i.test(chain)) {
        const wrongChain = new ArchiveRpcError(
          'WRONG_CHAIN',
          `system_chain returned ${chain}, not Moonbeam.`,
          'system_chain',
        );
        report.transport = { rpcMethod: 'system_chain', ...statusFail(wrongChain), chain };
        setGlobalFailure(report, wrongChain.code, wrongChain.message);
        report.classification = 'UNREACHABLE';
      } else {
        const header = await callRpc(
          client,
          'chain_getHeader',
          [ARCHIVE_PROBE_BLOCK_HASH],
          retries,
        );
        if (!header.ok) {
          report.header = { ...statusFail(header) };
          artifacts.header = {
            status: 'FAIL',
            method: 'chain_getHeader',
            blockHash: ARCHIVE_PROBE_BLOCK_HASH,
            error: errorDetail(header.error),
          };
          setGlobalFailure(report, header.error.code, errorDetail(header.error));
          report.classification = 'UNREACHABLE';
        } else {
          artifacts.header = {
            status: 'PASS',
            method: 'chain_getHeader',
            blockHash: ARCHIVE_PROBE_BLOCK_HASH,
            result: header.value,
          };
          try {
            if (header.value === null) {
              throw new ArchiveRpcError(
                'BLOCK_NOT_FOUND',
                'chain_getHeader returned null for the pinned block.',
                'chain_getHeader',
              );
            }
            const headerRecord = asRecord(header.value, 'chain_getHeader result');
            const number = numberText(headerRecord.number, 'header.number');
            const parentHash = asHash(headerRecord.parentHash, 'header.parentHash');
            const stateRoot = asHash(headerRecord.stateRoot, 'header.stateRoot');
            const extrinsicsRoot = asHash(headerRecord.extrinsicsRoot, 'header.extrinsicsRoot');
            report.header = {
              status: 'PASS',
              attempts: header.attempts,
              number,
              parentHash,
              stateRoot,
              extrinsicsRoot,
            };
            report.block.observedStateRoot = stateRoot;
            if (number !== ARCHIVE_PROBE_BLOCK_NUMBER || stateRoot !== ARCHIVE_PROBE_STATE_ROOT) {
              const mismatch = new ArchiveRpcError(
                'PINNED_HEADER_MISMATCH',
                `Pinned header mismatch: number=${number} stateRoot=${stateRoot}.`,
                'chain_getHeader',
              );
              report.header = {
                status: 'FAIL',
                attempts: header.attempts,
                number,
                parentHash,
                stateRoot,
                extrinsicsRoot,
                errorCode: mismatch.code,
                errorDetail: mismatch.message,
              };
              setGlobalFailure(report, mismatch.code, mismatch.message);
              report.classification = 'HEADER_ONLY';
            } else {
              const runtime = await callRpc(
                client,
                'state_getRuntimeVersion',
                [ARCHIVE_PROBE_BLOCK_HASH],
                retries,
              );
              if (!runtime.ok) {
                report.runtime = { ...statusFail(runtime) };
                artifacts.runtime = {
                  status: 'FAIL',
                  method: 'state_getRuntimeVersion',
                  blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                  error: errorDetail(runtime.error),
                };
                setGlobalFailure(report, runtime.error.code, errorDetail(runtime.error));
                report.classification = 'HEADER_ONLY';
              } else {
                artifacts.runtime = {
                  status: 'PASS',
                  method: 'state_getRuntimeVersion',
                  blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                  result: runtime.value,
                };
                try {
                  const runtimeRecord = asRecord(runtime.value, 'state_getRuntimeVersion result');
                  const specVersion = numberText(runtimeRecord.specVersion, 'runtime.specVersion');
                  const stateVersion = numberText(
                    runtimeRecord.stateVersion,
                    'runtime.stateVersion',
                  );
                  const runtimeValues = {
                    status: 'PASS' as const,
                    attempts: runtime.attempts,
                    ...(typeof runtimeRecord.specName === 'string'
                      ? { specName: runtimeRecord.specName }
                      : {}),
                    ...(typeof runtimeRecord.implName === 'string'
                      ? { implName: runtimeRecord.implName }
                      : {}),
                    ...(runtimeRecord.authoringVersion === undefined
                      ? {}
                      : {
                          authoringVersion: numberText(
                            runtimeRecord.authoringVersion,
                            'runtime.authoringVersion',
                          ),
                        }),
                    specVersion,
                    ...(runtimeRecord.implVersion === undefined
                      ? {}
                      : {
                          implVersion: numberText(runtimeRecord.implVersion, 'runtime.implVersion'),
                        }),
                    ...(runtimeRecord.transactionVersion === undefined
                      ? {}
                      : {
                          transactionVersion: numberText(
                            runtimeRecord.transactionVersion,
                            'runtime.transactionVersion',
                          ),
                        }),
                    stateVersion,
                  };
                  report.runtime = runtimeValues;
                  if (
                    specVersion !== String(ARCHIVE_PROBE_SPEC_VERSION) ||
                    stateVersion !== String(ARCHIVE_PROBE_STATE_VERSION)
                  ) {
                    const mismatch = new ArchiveRpcError(
                      'RUNTIME_VERSION_MISMATCH',
                      `Runtime mismatch: specVersion=${specVersion} stateVersion=${stateVersion}.`,
                      'state_getRuntimeVersion',
                    );
                    report.runtime = {
                      ...runtimeValues,
                      status: 'FAIL',
                      errorCode: mismatch.code,
                      errorDetail: mismatch.message,
                    };
                    setGlobalFailure(report, mismatch.code, mismatch.message);
                    report.classification = 'HEADER_ONLY';
                  } else {
                    const metadata = await callRpc(
                      client,
                      'state_getMetadata',
                      [ARCHIVE_PROBE_BLOCK_HASH],
                      retries,
                    );
                    if (!metadata.ok) {
                      report.metadata = { decode: 'NOT_RUN', ...statusFail(metadata) };
                      artifacts.metadata = {
                        status: 'FAIL',
                        method: 'state_getMetadata',
                        blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                        error: errorDetail(metadata.error),
                      };
                      setGlobalFailure(report, metadata.error.code, errorDetail(metadata.error));
                      report.classification = 'HEADER_ONLY';
                    } else {
                      artifacts.metadata = {
                        status: 'PASS',
                        method: 'state_getMetadata',
                        blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                        result: metadata.value,
                      };
                      try {
                        const metadataHex = asHex(metadata.value, 'metadata');
                        if (metadataHex === '0x') throw new Error('metadata is empty');
                        const info = metadataInfo(metadataHex);
                        report.metadata = {
                          status: 'PASS',
                          attempts: metadata.attempts,
                          ...info,
                          decode: 'NOT_RUN',
                        };
                        const storage = await callRpc(
                          client,
                          'state_getStorage',
                          [ARCHIVE_PROBE_STORAGE_KEY, ARCHIVE_PROBE_BLOCK_HASH],
                          retries,
                        );
                        if (!storage.ok) {
                          report.storage = {
                            key: ARCHIVE_PROBE_STORAGE_KEY,
                            ...statusFail(storage),
                          };
                          artifacts.storage = {
                            status: 'FAIL',
                            method: 'state_getStorage',
                            key: ARCHIVE_PROBE_STORAGE_KEY,
                            blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                            error: errorDetail(storage.error),
                          };
                          setGlobalFailure(report, storage.error.code, errorDetail(storage.error));
                          report.classification = 'HISTORICAL_METADATA';
                        } else {
                          try {
                            if (storage.value === null)
                              throw new Error('state_getStorage returned null');
                            const storageHex = asHex(storage.value, 'storage value');
                            if (storageHex === '0x')
                              throw new Error('state_getStorage returned empty value');
                            const storageBytes = (storageHex.length - 2) / 2;
                            const storageSha256 = sha256Hex(
                              Buffer.from(storageHex.slice(2), 'hex'),
                            );
                            report.storage = {
                              status: 'PASS',
                              attempts: storage.attempts,
                              key: ARCHIVE_PROBE_STORAGE_KEY,
                              valueBytes: storageBytes,
                              valueSha256: storageSha256,
                            };
                            artifacts.storage = {
                              status: 'PASS',
                              method: 'state_getStorage',
                              key: ARCHIVE_PROBE_STORAGE_KEY,
                              blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                              value: storageHex,
                              valueBytes: storageBytes,
                              valueSha256: storageSha256,
                            };
                            const proof = await callRpc(
                              client,
                              'state_getReadProof',
                              [[ARCHIVE_PROBE_STORAGE_KEY], ARCHIVE_PROBE_BLOCK_HASH],
                              retries,
                            );
                            if (!proof.ok) {
                              report.readProof = {
                                key: ARCHIVE_PROBE_STORAGE_KEY,
                                ...statusFail(proof),
                              };
                              artifacts.readProof = {
                                status: 'FAIL',
                                method: 'state_getReadProof',
                                keys: [ARCHIVE_PROBE_STORAGE_KEY],
                                blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                                error: errorDetail(proof.error),
                              };
                              setGlobalFailure(report, proof.error.code, errorDetail(proof.error));
                              report.classification = 'HISTORICAL_STORAGE';
                            } else {
                              try {
                                const proofRecord = asRecord(
                                  proof.value,
                                  'state_getReadProof result',
                                );
                                const at = asHash(proofRecord.at, 'read proof at');
                                const proofValue = proofRecord.proof;
                                if (!Array.isArray(proofValue) || proofValue.length === 0) {
                                  throw new ArchiveRpcError(
                                    'READ_PROOF_INVALID',
                                    'state_getReadProof returned no proof nodes.',
                                    'state_getReadProof',
                                  );
                                }
                                const nodes = proofValue.map((node, index) =>
                                  asHex(node, `proof node ${index}`),
                                );
                                const proofBytes = nodes.reduce(
                                  (sum, node) => sum + (node.length - 2) / 2,
                                  0,
                                );
                                const proofSha256 = sha256Hex(JSON.stringify(nodes) + '\n');
                                report.readProof = {
                                  status: 'PASS',
                                  attempts: proof.attempts,
                                  key: ARCHIVE_PROBE_STORAGE_KEY,
                                  at,
                                  nodeCount: nodes.length,
                                  bytes: proofBytes,
                                  sha256: proofSha256,
                                };
                                artifacts.readProof = {
                                  status: 'PASS',
                                  method: 'state_getReadProof',
                                  keys: [ARCHIVE_PROBE_STORAGE_KEY],
                                  blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                                  at,
                                  proof: nodes,
                                  nodeCount: nodes.length,
                                  bytes: proofBytes,
                                  sha256: proofSha256,
                                };
                                if (at !== ARCHIVE_PROBE_BLOCK_HASH) {
                                  const wrongBlock = new ArchiveRpcError(
                                    'READ_PROOF_INVALID',
                                    `state_getReadProof returned at=${at}, expected ${ARCHIVE_PROBE_BLOCK_HASH}.`,
                                    'state_getReadProof',
                                  );
                                  report.readProof = {
                                    ...report.readProof,
                                    status: 'FAIL',
                                    errorCode: wrongBlock.code,
                                    errorDetail: wrongBlock.message,
                                  };
                                  setGlobalFailure(report, wrongBlock.code, wrongBlock.message);
                                  report.classification = 'HISTORICAL_STORAGE';
                                } else {
                                  const offlineInput: ArchiveOfflineProofInput = {
                                    schemaVersion: 1,
                                    blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                                    stateRoot: ARCHIVE_PROBE_STATE_ROOT,
                                    stateVersion: ARCHIVE_PROBE_STATE_VERSION,
                                    key: ARCHIVE_PROBE_STORAGE_KEY,
                                    value: storageHex,
                                    proof: nodes,
                                  };
                                  let offline: ArchiveOfflineProofResult;
                                  try {
                                    offline = await (
                                      options.offlineVerifier ??
                                      ((input) => defaultOfflineVerifier(input, options))
                                    )(offlineInput);
                                  } catch (error) {
                                    offline = {
                                      status: 'UNAVAILABLE',
                                      detail: errorDetail(error),
                                    };
                                  }
                                  report.offlineProof = offline;
                                  artifacts.offlineProof = offline;
                                  if (offline.status === 'PASS') {
                                    report.classification = 'HISTORICAL_PROOF';
                                  } else {
                                    report.classification = 'HISTORICAL_STORAGE';
                                    setGlobalFailure(
                                      report,
                                      offline.status === 'UNAVAILABLE'
                                        ? 'READ_PROOF_UNAVAILABLE'
                                        : 'READ_PROOF_INVALID',
                                      offline.detail ?? 'Offline proof verification did not pass.',
                                    );
                                  }
                                }
                              } catch (error) {
                                const normalized = normalizeError(error, 'state_getReadProof');
                                const proofErrorCode: ArchiveErrorCode =
                                  normalized.code === 'JSON_RPC_ERROR'
                                    ? 'READ_PROOF_INVALID'
                                    : normalized.code;
                                report.readProof = {
                                  key: ARCHIVE_PROBE_STORAGE_KEY,
                                  ...statusFail(normalized, proofErrorCode),
                                };
                                artifacts.readProof = {
                                  status: 'FAIL',
                                  method: 'state_getReadProof',
                                  keys: [ARCHIVE_PROBE_STORAGE_KEY],
                                  blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                                  error: normalized.message,
                                };
                                setGlobalFailure(report, proofErrorCode, normalized.message);
                                report.classification = 'HISTORICAL_STORAGE';
                              }
                            }
                          } catch (error) {
                            const normalized = normalizeError(error, 'state_getStorage');
                            report.storage = {
                              key: ARCHIVE_PROBE_STORAGE_KEY,
                              ...statusFail(normalized, 'HISTORICAL_STORAGE_UNAVAILABLE'),
                            };
                            artifacts.storage = {
                              status: 'FAIL',
                              method: 'state_getStorage',
                              key: ARCHIVE_PROBE_STORAGE_KEY,
                              blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                              error: normalized.message,
                            };
                            setGlobalFailure(
                              report,
                              'HISTORICAL_STORAGE_UNAVAILABLE',
                              normalized.message,
                            );
                            report.classification = 'HISTORICAL_METADATA';
                          }
                        }
                      } catch (error) {
                        const normalized = normalizeError(error, 'state_getMetadata');
                        report.metadata = {
                          decode: 'FAIL',
                          ...statusFail(normalized, 'HISTORICAL_METADATA_UNAVAILABLE'),
                        };
                        artifacts.metadata = {
                          status: 'FAIL',
                          method: 'state_getMetadata',
                          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                          error: normalized.message,
                        };
                        setGlobalFailure(
                          report,
                          'HISTORICAL_METADATA_UNAVAILABLE',
                          normalized.message,
                        );
                        report.classification = 'HEADER_ONLY';
                      }
                    }
                  }
                } catch (error) {
                  const normalized = normalizeError(error, 'state_getRuntimeVersion');
                  report.runtime = { ...statusFail(normalized, 'HISTORICAL_RUNTIME_UNAVAILABLE') };
                  artifacts.runtime = {
                    status: 'FAIL',
                    method: 'state_getRuntimeVersion',
                    blockHash: ARCHIVE_PROBE_BLOCK_HASH,
                    error: normalized.message,
                  };
                  setGlobalFailure(report, 'HISTORICAL_RUNTIME_UNAVAILABLE', normalized.message);
                  report.classification = 'HEADER_ONLY';
                }
              }
            }
          } catch (error) {
            const normalized = normalizeError(error, 'chain_getHeader');
            report.header = { ...statusFail(normalized, 'PINNED_HEADER_MISMATCH') };
            setGlobalFailure(report, normalized.code, normalized.message);
            report.classification =
              normalized.code === 'BLOCK_NOT_FOUND' ? 'UNREACHABLE' : 'HEADER_ONLY';
          }
        }
      }
    }
  } finally {
    if (ownsClient) await client.close().catch(() => undefined);
  }
  await persistProbe(outputDirectory, report, artifacts);
  return { outputDirectory, report, reportText: reportText(report) };
}

export interface MatrixProviderSpec {
  name: string;
  rpc?: string;
  source?: string;
}

export interface ArchiveMatrixProviderResult {
  name: string;
  classification: ArchiveProbeClassification;
  outputDirectory?: string;
  report?: ArchiveProbeReport;
  errorCode?: ArchiveErrorCode;
}

export interface SubstrateArchiveMatrixOptions
  extends Omit<SubstrateArchiveProbeOptions, 'rpc' | 'providerName' | 'out'> {
  providers?: readonly MatrixProviderSpec[];
  out?: string;
  clientFactory?: (
    provider: MatrixProviderSpec,
  ) => Promise<ArchiveProbeRpcClient> | ArchiveProbeRpcClient;
}

export interface SubstrateArchiveMatrixResult {
  outputDirectory: string;
  providers: ArchiveMatrixProviderResult[];
  summary: {
    historicalStorageProviders: number;
    historicalProofProviders: number;
    canReconstructFinalState: boolean;
    canGenerateProofs: boolean;
    archiveCapabilityAvailable: boolean;
  };
}

export function defaultSubstrateProviderSpecs(): MatrixProviderSpec[] {
  const fromEnvironment = (
    name: string,
    environment: string,
    source: string,
  ): MatrixProviderSpec => {
    const rpc = process.env[environment];
    return rpc === undefined ? { name, source } : { name, rpc, source };
  };
  return [
    {
      name: 'onfinality',
      rpc:
        process.env.MOONBEAM_SUBSTRATE_RPC_ONFINALITY ??
        'wss://moonbeam.api.onfinality.io/public-ws',
      source: 'known Moonbeam Substrate WebSocket endpoint',
    },
    {
      name: 'foundation',
      rpc: process.env.MOONBEAM_SUBSTRATE_RPC_FOUNDATION ?? 'wss://wss.api.moonbeam.network',
      source: 'known Moonbeam Foundation Substrate WebSocket endpoint',
    },
    {
      name: 'unitedbloc',
      rpc: process.env.MOONBEAM_SUBSTRATE_RPC_UNITEDBLOC ?? 'wss://moonbeam.unitedbloc.com',
      source: 'known UnitedBloc Moonbeam Substrate endpoint',
    },
    fromEnvironment('1rpc', 'MOONBEAM_SUBSTRATE_RPC_1RPC', 'no EVM URL substitution'),
    fromEnvironment('dwellir', 'MOONBEAM_SUBSTRATE_RPC_DWELLIR', 'requires provider credentials'),
    fromEnvironment('drpc', 'MOONBEAM_SUBSTRATE_RPC_DRPC', 'no EVM URL substitution'),
    fromEnvironment('publicnode', 'MOONBEAM_SUBSTRATE_RPC_PUBLICNODE', 'no EVM URL substitution'),
  ];
}

function noKnownEndpointText(name: string): string {
  return [
    `PROVIDER=${name}`,
    'RPC_SCHEME=NOT_KNOWN',
    'RPC_HOST=NOT_KNOWN',
    'CREDENTIAL_PRESENCE=UNKNOWN',
    'CREDENTIALS_REDACTED=false',
    '',
    `BLOCK_HASH=${ARCHIVE_PROBE_BLOCK_HASH}`,
    `BLOCK_NUMBER=${ARCHIVE_PROBE_BLOCK_NUMBER}`,
    `EXPECTED_STATE_ROOT=${ARCHIVE_PROBE_STATE_ROOT}`,
    'TRANSPORT_RPC=NOT_RUN',
    'CLASSIFICATION=NO_KNOWN_SUBSTRATE_ENDPOINT',
    'ERROR_CODE=NO_KNOWN_SUBSTRATE_ENDPOINT',
    'ERROR_DETAIL="No verified Substrate RPC URL is known for this provider; EVM URLs were not substituted."',
    '',
  ].join('\n');
}

export async function probeSubstrateArchiveMatrix(
  options: SubstrateArchiveMatrixOptions,
): Promise<SubstrateArchiveMatrixResult> {
  const blockHash = options.blockHash;
  const providers =
    options.providers === undefined ? defaultSubstrateProviderSpecs() : [...options.providers];
  const names = new Set<string>();
  for (const provider of providers) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider.name) || names.has(provider.name)) {
      throw inputError('Matrix provider names must be unique simple identifiers.', {
        provider: provider.name,
      });
    }
    names.add(provider.name);
  }
  const outputDirectory = resolve(options.out ?? 'diagnostics/substrate-archive-probe');
  await mkdir(outputDirectory, { recursive: true });
  const results: ArchiveMatrixProviderResult[] = [];
  for (const provider of providers) {
    const slug = provider.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const providerDirectory = join(outputDirectory, slug);
    if (provider.rpc === undefined || provider.rpc === '') {
      await mkdir(providerDirectory, { recursive: true });
      await writeAtomic(join(providerDirectory, 'report.txt'), noKnownEndpointText(provider.name));
      await writeJson(join(providerDirectory, 'report.json'), {
        schemaVersion: 1,
        provider: provider.name,
        classification: 'NO_KNOWN_SUBSTRATE_ENDPOINT',
        errorCode: 'NO_KNOWN_SUBSTRATE_ENDPOINT',
      });
      results.push({
        name: provider.name,
        classification: 'NO_KNOWN_SUBSTRATE_ENDPOINT',
        outputDirectory: providerDirectory,
        errorCode: 'NO_KNOWN_SUBSTRATE_ENDPOINT',
      });
      continue;
    }
    let result: SubstrateProbeResult;
    try {
      const client =
        options.clientFactory === undefined ? undefined : await options.clientFactory(provider);
      result = await probeSubstrateArchive(
        {
          ...options,
          rpc: provider.rpc,
          providerName: provider.name,
          blockHash,
          out: providerDirectory,
        },
        client,
      );
    } catch (error) {
      const normalized = normalizeError(error, 'system_chain');
      const rpc = sanitizeRpcUrl(provider.rpc);
      const report = initialReport(provider.name, rpc);
      report.transport = { rpcMethod: 'system_chain', ...statusFail(normalized) };
      report.classification = 'UNREACHABLE';
      setGlobalFailure(report, normalized.code, normalized.message);
      const artifacts: ProbeArtifacts = {
        transport: { status: 'FAIL', method: 'system_chain', error: normalized.message },
        header: {
          status: 'NOT_RUN',
          method: 'chain_getHeader',
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
        },
        runtime: {
          status: 'NOT_RUN',
          method: 'state_getRuntimeVersion',
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
        },
        metadata: {
          status: 'NOT_RUN',
          method: 'state_getMetadata',
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
        },
        storage: {
          status: 'NOT_RUN',
          method: 'state_getStorage',
          key: ARCHIVE_PROBE_STORAGE_KEY,
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
        },
        readProof: {
          status: 'NOT_RUN',
          method: 'state_getReadProof',
          keys: [ARCHIVE_PROBE_STORAGE_KEY],
          blockHash: ARCHIVE_PROBE_BLOCK_HASH,
        },
        offlineProof: { status: 'NOT_RUN' },
      };
      await persistProbe(providerDirectory, report, artifacts);
      result = { outputDirectory: providerDirectory, report, reportText: reportText(report) };
    }
    results.push({
      name: provider.name,
      classification: result.report.classification,
      outputDirectory: result.outputDirectory,
      report: result.report,
      ...(result.report.errorCode === undefined ? {} : { errorCode: result.report.errorCode }),
    });
  }
  const historicalStorageProviders = results.filter((result) =>
    ['HISTORICAL_STORAGE', 'HISTORICAL_PROOF'].includes(result.classification),
  ).length;
  const historicalProofProviders = results.filter(
    (result) => result.classification === 'HISTORICAL_PROOF',
  ).length;
  const summary = {
    historicalStorageProviders,
    historicalProofProviders,
    canReconstructFinalState: historicalStorageProviders > 0,
    canGenerateProofs: historicalProofProviders > 0,
    archiveCapabilityAvailable: historicalStorageProviders > 0,
  };
  await writeJson(join(outputDirectory, 'matrix-summary.json'), {
    schemaVersion: 1,
    blockHash: ARCHIVE_PROBE_BLOCK_HASH,
    blockNumber: ARCHIVE_PROBE_BLOCK_NUMBER,
    expectedStateRoot: ARCHIVE_PROBE_STATE_ROOT,
    expectedSpecVersion: ARCHIVE_PROBE_SPEC_VERSION,
    expectedStateVersion: ARCHIVE_PROBE_STATE_VERSION,
    providers: results.map((result) => ({
      name: result.name,
      classification: result.classification,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    })),
    summary,
  });
  return { outputDirectory, providers: results, summary };
}

type SubstrateProbeResult = SubstrateArchiveProbeResult;
