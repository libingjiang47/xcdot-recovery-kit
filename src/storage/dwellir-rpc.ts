import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { FinalStateStorageBackendUnsupportedError } from '../utils/errors.js';

const execFileAsync = promisify(execFile);
const ENDPOINT_BASE = 'https://api-moonbeam.n.dwellir.com/';
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 120_000;
const DEFAULT_BODY_TIMEOUT_MS = 600_000;
const DEFAULT_RETRIES = 5;
const STATUS_MARKER = '__XCDOT_HTTP_STATUS__:';

export interface DwellirRpcTransport {
  call(method: string, params: readonly unknown[]): Promise<unknown>;
  batch(calls: readonly { method: string; params: readonly unknown[] }[]): Promise<unknown[]>;
  rawCall?(method: string, params: readonly unknown[]): Promise<unknown>;
}

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: readonly unknown[];
};

function parseKeyFile(text: string): string | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(?:export\s+)?DWELLIR_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    const value = (match[1] ?? '').trim().replace(/^("|')(.*)\1$/, '$2');
    if (value) return value;
  }
  return undefined;
}

export async function resolveDwellirKey(explicit?: string, keyFile?: string): Promise<string> {
  const direct = explicit?.trim() || process.env.DWELLIR_KEY?.trim();
  if (direct) return direct;
  const files = keyFile
    ? [resolve(keyFile)]
    : [resolve('.key'), resolve(homedir(), 'xcdot-recovery-kit.key')];
  for (const file of files) {
    try {
      const key = parseKeyFile(await readFile(file, 'utf8'));
      if (key) return key;
    } catch {
      // Try the next local credential file without exposing secret material.
    }
  }
  throw new FinalStateStorageBackendUnsupportedError(
    'DWELLIR_KEY is not set and no local key file could be read.',
    { checkedKeyFiles: files.join(',') },
  );
}

function validateTimeouts(
  timeoutMs: number,
  connectTimeoutMs: number,
  bodyTimeoutMs: number,
): void {
  if (![timeoutMs, connectTimeoutMs, bodyTimeoutMs].every(Number.isInteger) || timeoutMs < 1) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Dwellir timeouts must be positive integers.',
    );
  }
  if (connectTimeoutMs > timeoutMs || bodyTimeoutMs > timeoutMs) {
    throw new FinalStateStorageBackendUnsupportedError(
      'Dwellir connect/body timeout must not exceed the overall timeout.',
    );
  }
}

function envelopeResult(value: unknown, method: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${method} returned a malformed JSON-RPC envelope`);
  const envelope = value as { result?: unknown; error?: unknown };
  if (envelope.error !== undefined)
    throw new Error(`${method} RPC error: ${JSON.stringify(envelope.error)}`);
  if (!('result' in envelope)) throw new Error(`${method} response has no result`);
  return envelope.result;
}

async function curlJson(
  endpoint: string,
  body: JsonRpcRequest | JsonRpcRequest[],
  timeoutMs: number,
  connectTimeoutMs: number,
  bodyTimeoutMs: number,
  retries: number,
  key: string,
): Promise<unknown> {
  validateTimeouts(timeoutMs, connectTimeoutMs, bodyTimeoutMs);
  const args = [
    '--silent',
    '--show-error',
    '--connect-timeout',
    String(Math.ceil(connectTimeoutMs / 1000)),
    '--max-time',
    String(Math.ceil(timeoutMs / 1000)),
    '--speed-limit',
    '1',
    '--speed-time',
    String(Math.ceil(bodyTimeoutMs / 1000)),
    '--retry',
    String(Math.max(0, retries - 1)),
    '--retry-connrefused',
    '--retry-delay',
    '2',
    '--request',
    'POST',
    '--header',
    'Content-Type: application/json',
    '--data-raw',
    JSON.stringify(body),
    '--write-out',
    `\n${STATUS_MARKER}%{http_code}\n`,
    endpoint,
  ];
  try {
    const result = await execFileAsync('curl', args, { maxBuffer: 256 * 1024 * 1024 });
    const marker = `\n${STATUS_MARKER}`;
    const index = result.stdout.lastIndexOf(marker);
    if (index < 0) throw new Error('curl response lacks HTTP status marker');
    const status = Number(result.stdout.slice(index + marker.length).trim());
    const response = result.stdout.slice(0, index);
    if (!Number.isInteger(status) || status < 200 || status >= 300)
      throw new Error(`HTTP ${status}: ${response.slice(0, 1024)}`);
    return JSON.parse(response) as unknown;
  } catch (error) {
    const detail = [(error as { message?: string }).message, (error as { stderr?: string }).stderr]
      .filter((part): part is string => Boolean(part))
      .join('\n')
      .replaceAll(key, '<redacted-key>')
      .replaceAll(encodeURIComponent(key), '<redacted-key>');
    throw new FinalStateStorageBackendUnsupportedError('Dwellir curl request failed.', {
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  validateTimeouts(timeoutMs, connectTimeoutMs, bodyTimeoutMs);
  const key = options.key.trim();
  const endpoint = `${options.endpointBase ?? ENDPOINT_BASE}${encodeURIComponent(key)}`;
  let nextId = 1;
  const rawCall = (method: string, params: readonly unknown[]) =>
    curlJson(
      endpoint,
      { jsonrpc: '2.0', id: nextId++, method, params },
      timeoutMs,
      connectTimeoutMs,
      bodyTimeoutMs,
      retries,
      key,
    );
  return {
    rawCall,
    async call(method, params) {
      return envelopeResult(await rawCall(method, params), method);
    },
    async batch(calls) {
      const response = await curlJson(
        endpoint,
        calls.map((call) => ({ jsonrpc: '2.0' as const, id: nextId++, ...call })),
        timeoutMs,
        connectTimeoutMs,
        bodyTimeoutMs,
        retries,
        key,
      );
      if (!Array.isArray(response)) throw new Error('batch response is not an array');
      return response
        .sort((a, b) => Number((a as { id?: number }).id) - Number((b as { id?: number }).id))
        .map((item) => envelopeResult(item, 'batch'));
    },
  };
}
