import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { URL } from 'node:url';
import { SqdCandidateDiscoveryError } from '../utils/errors.js';

const execFileAsync = promisify(execFile);
const CURL_STATUS_MARKER = '__XCDOT_SQD_HTTP_STATUS__:';
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;

export const SQD_DATASET = 'moonbeam-mainnet' as const;
export const SQD_ENDPOINT = 'https://portal.sqd.dev/datasets/moonbeam-mainnet/stream' as const;
export const XCDOT_CONTRACT = '0xffffffff1fcacbd218edc0eba20fc2308c778080' as const;
export const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

export interface SqdHttpResponse {
  httpStatus: number;
  body: string;
}

export type SqdHttpExecutor = (
  endpoint: string,
  body: string,
  timeoutMs: number,
) => Promise<SqdHttpResponse>;

export interface SqdRangeClient {
  fetchRange(fromBlock: number, toBlock: number): Promise<string>;
}

export class SqdRpcError extends Error {
  readonly transient: boolean;
  readonly httpStatus: number | undefined;

  constructor(message: string, options: { transient?: boolean; httpStatus?: number } = {}) {
    super(message);
    this.name = 'SqdRpcError';
    this.transient = options.transient ?? false;
    this.httpStatus = options.httpStatus;
  }
}

function inputError(message: string, details: Record<string, string | number | boolean> = {}) {
  return new SqdCandidateDiscoveryError('SQD_INPUT_ERROR', message, details);
}

function validateEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch (error) {
    throw inputError('SQD endpoint URL is invalid.', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host === '') {
    throw inputError('SQD endpoint must use http(s) with a host.', {
      endpoint: `${parsed.protocol}//${parsed.host}`,
    });
  }
  return parsed.toString();
}

function bodyPreview(value: string): string {
  return value.length > 4096 ? `${value.slice(0, 4096)}…` : value;
}

function retryableHttpStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function errorText(error: unknown): string {
  if (error instanceof SqdRpcError) {
    return [
      error.message,
      error.httpStatus === undefined ? undefined : `httpStatus=${error.httpStatus}`,
    ]
      .filter((item): item is string => item !== undefined)
      .join('; ');
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function normalizeRpcError(error: unknown): SqdRpcError {
  if (error instanceof SqdRpcError) return error;
  return new SqdRpcError(errorText(error), { transient: true });
}

export async function retrySqdRequest<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<{ value: T; attempts: number }> {
  const attempts = options.attempts ?? 5;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw inputError('SQD retry attempts must be an integer from 1 to 10.', { attempts });
  }
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: SqdRpcError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { value: await operation(), attempts: attempt };
    } catch (error) {
      const normalized = normalizeRpcError(error);
      lastError = normalized;
      if (!normalized.transient || attempt === attempts) throw normalized;
      await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? 16_000);
    }
  }
  throw lastError ?? new SqdRpcError('SQD request failed.');
}

export function buildSqdCurlArguments(options: {
  endpoint: string;
  body: string;
  timeoutMs: number;
}): string[] {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw inputError('SQD timeout must be a positive safe integer.', {
      timeoutMs: options.timeoutMs,
    });
  }
  return [
    '--silent',
    '--show-error',
    '--compressed',
    '--connect-timeout',
    '30',
    '--max-time',
    String(Math.ceil(options.timeoutMs / 1000)),
    '--request',
    'POST',
    '--header',
    'Content-Type: application/json',
    '--data-raw',
    options.body,
    '--write-out',
    `\n${CURL_STATUS_MARKER}%{http_code}\n`,
    options.endpoint,
  ];
}

async function defaultHttpExecutor(
  endpoint: string,
  body: string,
  timeoutMs: number,
): Promise<SqdHttpResponse> {
  try {
    const result = await execFileAsync(
      'curl',
      buildSqdCurlArguments({ endpoint, body, timeoutMs }),
      { maxBuffer: 256 * 1024 * 1024 },
    );
    const marker = `\n${CURL_STATUS_MARKER}`;
    const markerIndex = result.stdout.lastIndexOf(marker);
    if (markerIndex < 0)
      throw new SqdRpcError('SQD curl response lacks HTTP status marker.', { transient: true });
    const httpStatus = Number(result.stdout.slice(markerIndex + marker.length).trim());
    if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
      throw new SqdRpcError('SQD curl returned an invalid HTTP status.', { transient: true });
    }
    return { httpStatus, body: result.stdout.slice(0, markerIndex) };
  } catch (error) {
    if (error instanceof SqdRpcError) throw error;
    const child = error as { message?: string; stderr?: string };
    throw new SqdRpcError(
      [child.message, child.stderr].filter((item): item is string => Boolean(item)).join('\n'),
      { transient: true },
    );
  }
}

function requestBody(fromBlock: number, toBlock: number): string {
  return JSON.stringify({
    type: 'evm',
    fromBlock,
    toBlock,
    fields: {
      block: { number: true },
      log: { topics: true },
    },
    logs: [{ address: [XCDOT_CONTRACT], topic0: [TRANSFER_TOPIC0] }],
  });
}

export function createSqdCurlTransport(
  options: {
    endpoint?: string;
    timeoutMs?: number;
    retries?: number;
    httpExecutor?: SqdHttpExecutor;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): SqdRangeClient {
  const endpoint = validateEndpoint(options.endpoint ?? SQD_ENDPOINT);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const retries = options.retries ?? 5;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw inputError('SQD timeout must be a positive safe integer.', { timeoutMs });
  }
  if (!Number.isSafeInteger(retries) || retries < 1 || retries > 10) {
    throw inputError('SQD retries must be an integer from 1 to 10.', { retries });
  }
  const httpExecutor = options.httpExecutor ?? defaultHttpExecutor;
  return {
    async fetchRange(fromBlock, toBlock): Promise<string> {
      const body = requestBody(fromBlock, toBlock);
      const response = await retrySqdRequest(
        async () => {
          const raw = await httpExecutor(endpoint, body, timeoutMs);
          if (raw.httpStatus < 200 || raw.httpStatus >= 300) {
            throw new SqdRpcError(`SQD HTTP ${raw.httpStatus}: ${bodyPreview(raw.body)}`, {
              transient: retryableHttpStatus(raw.httpStatus),
              httpStatus: raw.httpStatus,
            });
          }
          return raw.body;
        },
        { attempts: retries, ...(options.sleep === undefined ? {} : { sleep: options.sleep }) },
      );
      return response.value;
    },
  };
}
