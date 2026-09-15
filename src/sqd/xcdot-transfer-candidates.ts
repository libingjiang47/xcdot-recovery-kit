import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  SQD_DATASET,
  SQD_ENDPOINT,
  TRANSFER_TOPIC0,
  XCDOT_CONTRACT,
  SqdRpcError,
  type SqdRangeClient,
  createSqdCurlTransport,
} from './client.js';
import {
  SqdCandidateDiscoveryError,
  type SqdCandidateDiscoveryErrorCode,
} from '../utils/errors.js';
import { compareCanonicalStrings } from '../utils/order.js';

export { SQD_DATASET, SQD_ENDPOINT, TRANSFER_TOPIC0, XCDOT_CONTRACT } from './client.js';

export const SQD_DEFAULT_FROM_BLOCK = 0 as const;
export const SQD_DEFAULT_TO_BLOCK = 16_796_696 as const;
export const SQD_DEFAULT_WINDOW_BLOCKS = 50_000 as const;
export const SQD_DEFAULT_TIMEOUT_MS = 120_000 as const;
export const SQD_DEFAULT_RETRIES = 5 as const;
export const SQD_DEFAULT_OUTPUT = 'snapshots/sqd/xcdot-transfer-addresses.ndjson' as const;
export const SQD_DEFAULT_WORK = 'diagnostics/sqd-xcdot-transfer-discovery' as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export interface ParsedSqdStream {
  lastReturnedBlock: number;
  transferLogCount: number;
  zeroAddressOccurrenceCount: number;
  addresses: Set<string>;
}

export interface SqdDiscoveryContext {
  schemaVersion: 1;
  dataset: typeof SQD_DATASET;
  endpoint: string;
  contract: typeof XCDOT_CONTRACT;
  transferTopic0: typeof TRANSFER_TOPIC0;
  fromBlock: number;
  toBlock: number;
}

export interface SqdDiscoveryCheckpoint {
  schemaVersion: 1;
  lastCompletedBlock: number;
  nextBlock: number;
  requestCount: number;
  transferLogCount: number;
  addressCount: number;
  zeroAddressOccurrenceCount: number;
}

export type SqdDiscoveryStatus = 'IN_PROGRESS' | 'COMPLETE' | 'FAILED';

export interface SqdDiscoverySummary {
  schemaVersion: 1;
  status: SqdDiscoveryStatus;
  dataset: typeof SQD_DATASET;
  endpoint: string;
  contract: typeof XCDOT_CONTRACT;
  transferTopic0: typeof TRANSFER_TOPIC0;
  fromBlock: number;
  toBlock: number;
  lastCompletedBlock: number | null;
  nextBlock: number;
  requestCount: number;
  transferLogCount: number;
  uniqueNonZeroAddressCount: number;
  zeroAddressOccurrenceCount: number;
  candidateSha256: string;
  errorCode?: SqdCandidateDiscoveryErrorCode;
  errorMessage?: string;
}

export interface SqdCandidateDiscoveryOptions {
  endpoint?: string;
  fromBlock?: number;
  toBlock?: number;
  windowBlocks?: number;
  timeoutMs?: number;
  retries?: number;
  out?: string;
  work?: string;
  resume?: boolean;
  force?: boolean;
  client?: SqdRangeClient;
  progress?: (message: string) => void;
}

export interface SqdCandidateDiscoveryResult {
  outputFile: string;
  sha256File: string;
  workDirectory: string;
  summaryFile: string;
  summary: SqdDiscoverySummary;
}

function discoveryError(
  code: SqdCandidateDiscoveryErrorCode,
  message: string,
  details: Record<string, string | number | boolean> = {},
): SqdCandidateDiscoveryError {
  return new SqdCandidateDiscoveryError(code, message, details);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractIndexedAddress(topic: string): string {
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) {
    throw discoveryError(
      'SQD_STREAM_INVALID_TRANSFER_LOG',
      'Indexed ERC-20 address topic has invalid ABI padding or length.',
      { topic: topic.slice(0, 160) },
    );
  }
  return `0x${topic.slice(-40).toLowerCase()}`;
}

function parseHeaderNumber(value: unknown, line: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw discoveryError('SQD_STREAM_INVALID_HEADER', 'SQD header.number is not a safe integer.', {
      line,
      value: String(value),
    });
  }
  return value as number;
}

function parseTransferLog(value: unknown, line: number): [string, string] {
  if (!isObject(value) || !Array.isArray(value.topics) || value.topics.length < 3) {
    throw discoveryError(
      'SQD_STREAM_INVALID_TRANSFER_LOG',
      'SQD Transfer log must contain at least three topics.',
      { line },
    );
  }
  const topic0 = value.topics[0];
  if (typeof topic0 !== 'string' || topic0.toLowerCase() !== TRANSFER_TOPIC0) {
    throw discoveryError('SQD_STREAM_INVALID_TRANSFER_LOG', 'SQD log topic0 is not Transfer.', {
      line,
      topic0: typeof topic0 === 'string' ? topic0 : String(topic0),
    });
  }
  const fromTopic = value.topics[1];
  const toTopic = value.topics[2];
  if (typeof fromTopic !== 'string' || typeof toTopic !== 'string') {
    throw discoveryError('SQD_STREAM_INVALID_TRANSFER_LOG', 'SQD indexed topics must be strings.', {
      line,
    });
  }
  return [extractIndexedAddress(fromTopic), extractIndexedAddress(toTopic)];
}

export function parseSqdJsonl(text: string): ParsedSqdStream {
  const addresses = new Set<string>();
  let previousBlock: number | undefined;
  let lastReturnedBlock: number | undefined;
  let transferLogCount = 0;
  let zeroAddressOccurrenceCount = 0;
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw discoveryError('SQD_STREAM_INVALID_JSON', 'SQD response contains invalid JSONL.', {
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!isObject(parsed)) {
      throw discoveryError('SQD_STREAM_INVALID_HEADER', 'SQD JSONL line must be an object.', {
        line: index + 1,
      });
    }
    const header = parsed.header;
    if (!isObject(header)) {
      throw discoveryError('SQD_STREAM_INVALID_HEADER', 'SQD JSONL object has no header.', {
        line: index + 1,
      });
    }
    const block = parseHeaderNumber(header.number, index + 1);
    if (previousBlock !== undefined && block < previousBlock) {
      throw discoveryError(
        'SQD_STREAM_NON_MONOTONIC_BLOCK',
        'SQD response header numbers are not monotonic.',
        { line: index + 1, previousBlock, block },
      );
    }
    previousBlock = block;
    lastReturnedBlock = block;
    if (parsed.logs === undefined) continue;
    if (!Array.isArray(parsed.logs)) {
      throw discoveryError('SQD_STREAM_INVALID_TRANSFER_LOG', 'SQD logs field must be an array.', {
        line: index + 1,
      });
    }
    for (const log of parsed.logs) {
      const [from, to] = parseTransferLog(log, index + 1);
      transferLogCount += 1;
      for (const address of [from, to]) {
        if (address === ZERO_ADDRESS) {
          zeroAddressOccurrenceCount += 1;
        } else {
          addresses.add(address);
        }
      }
    }
  }
  if (lastReturnedBlock === undefined) {
    throw discoveryError('SQD_STREAM_NO_PROGRESS', 'SQD response contained no valid header.');
  }
  return {
    lastReturnedBlock,
    transferLogCount,
    zeroAddressOccurrenceCount,
    addresses,
  };
}

export function serializeSqdCandidateAddresses(addresses: readonly string[]): string {
  const sorted = [...new Set(addresses.map((address) => address.toLowerCase()))].sort(
    compareCanonicalStrings,
  );
  return sorted.length === 0
    ? ''
    : sorted.map((address) => JSON.stringify({ address })).join('\n') + '\n';
}

export function sqdCandidateAddressesSha256(addresses: readonly string[]): string {
  return createHash('sha256').update(serializeSqdCandidateAddresses(addresses)).digest('hex');
}

function sha256Path(outputFile: string): string {
  return outputFile.endsWith('.ndjson')
    ? `${outputFile.slice(0, -'.ndjson'.length)}.sha256`
    : `${outputFile}.sha256`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
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

function validateNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw discoveryError('SQD_INPUT_ERROR', `${label} must be a non-negative safe integer.`, {
      [label]: value,
    });
  }
}

function validateOptions(
  options: Required<
    Pick<
      SqdCandidateDiscoveryOptions,
      'fromBlock' | 'toBlock' | 'windowBlocks' | 'timeoutMs' | 'retries'
    >
  >,
): void {
  validateNumber(options.fromBlock, 'fromBlock');
  validateNumber(options.toBlock, 'toBlock');
  validateNumber(options.windowBlocks, 'windowBlocks');
  if (options.fromBlock > options.toBlock) {
    throw discoveryError('SQD_INPUT_ERROR', 'fromBlock must not exceed toBlock.', {
      fromBlock: options.fromBlock,
      toBlock: options.toBlock,
    });
  }
  if (options.windowBlocks < 1) {
    throw discoveryError('SQD_INPUT_ERROR', 'windowBlocks must be positive.', {
      windowBlocks: options.windowBlocks,
    });
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw discoveryError('SQD_INPUT_ERROR', 'timeoutMs must be a positive safe integer.', {
      timeoutMs: options.timeoutMs,
    });
  }
  if (!Number.isSafeInteger(options.retries) || options.retries < 1 || options.retries > 10) {
    throw discoveryError('SQD_INPUT_ERROR', 'retries must be an integer from 1 to 10.', {
      retries: options.retries,
    });
  }
}

function contextMatches(actual: unknown, expected: SqdDiscoveryContext): boolean {
  if (!isObject(actual)) return false;
  return (
    actual.schemaVersion === expected.schemaVersion &&
    actual.dataset === expected.dataset &&
    actual.endpoint === expected.endpoint &&
    actual.contract === expected.contract &&
    actual.transferTopic0 === expected.transferTopic0 &&
    actual.fromBlock === expected.fromBlock &&
    actual.toBlock === expected.toBlock
  );
}

function parseCheckpoint(value: unknown, path: string): SqdDiscoveryCheckpoint {
  if (!isObject(value) || value.schemaVersion !== 1) {
    throw discoveryError('SQD_CONTEXT_MISMATCH', 'SQD checkpoint has an unsupported schema.', {
      path,
    });
  }
  const fields = [
    'lastCompletedBlock',
    'nextBlock',
    'requestCount',
    'transferLogCount',
    'addressCount',
    'zeroAddressOccurrenceCount',
  ] as const;
  for (const field of fields) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw discoveryError('SQD_CONTEXT_MISMATCH', 'SQD checkpoint contains an invalid counter.', {
        path,
        field,
      });
    }
  }
  return {
    schemaVersion: 1,
    lastCompletedBlock: value.lastCompletedBlock as number,
    nextBlock: value.nextBlock as number,
    requestCount: value.requestCount as number,
    transferLogCount: value.transferLogCount as number,
    addressCount: value.addressCount as number,
    zeroAddressOccurrenceCount: value.zeroAddressOccurrenceCount as number,
  };
}

async function loadAddresses(path: string): Promise<Set<string>> {
  if (!(await pathExists(path))) return new Set<string>();
  const addresses = new Set<string>();
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw discoveryError(
        'SQD_CONTEXT_MISMATCH',
        'SQD address checkpoint contains invalid JSON.',
        {
          path,
          line: index + 1,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (!isObject(parsed) || typeof parsed.address !== 'string') {
      throw discoveryError('SQD_CONTEXT_MISMATCH', 'SQD address checkpoint line is invalid.', {
        path,
        line: index + 1,
      });
    }
    const address = parsed.address.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address) || address === ZERO_ADDRESS) {
      throw discoveryError(
        'SQD_CONTEXT_MISMATCH',
        'SQD address checkpoint contains invalid H160.',
        {
          path,
          line: index + 1,
        },
      );
    }
    addresses.add(address);
  }
  return addresses;
}

async function persistAddresses(path: string, addresses: Set<string>): Promise<void> {
  await writeAtomic(path, serializeSqdCandidateAddresses([...addresses]));
}

function buildSummary(
  context: SqdDiscoveryContext,
  checkpoint: SqdDiscoveryCheckpoint | undefined,
  addresses: Set<string>,
  status: SqdDiscoveryStatus,
  extra: Partial<Pick<SqdDiscoverySummary, 'errorCode' | 'errorMessage'>> = {},
): SqdDiscoverySummary {
  return {
    schemaVersion: 1,
    status,
    dataset: context.dataset,
    endpoint: context.endpoint,
    contract: context.contract,
    transferTopic0: context.transferTopic0,
    fromBlock: context.fromBlock,
    toBlock: context.toBlock,
    lastCompletedBlock: checkpoint?.lastCompletedBlock ?? null,
    nextBlock: checkpoint?.nextBlock ?? context.fromBlock,
    requestCount: checkpoint?.requestCount ?? 0,
    transferLogCount: checkpoint?.transferLogCount ?? 0,
    uniqueNonZeroAddressCount: addresses.size,
    zeroAddressOccurrenceCount: checkpoint?.zeroAddressOccurrenceCount ?? 0,
    candidateSha256: sqdCandidateAddressesSha256([...addresses]),
    ...extra,
  };
}

function errorCode(error: unknown): SqdCandidateDiscoveryErrorCode {
  return error instanceof SqdCandidateDiscoveryError
    ? (error.code as SqdCandidateDiscoveryErrorCode)
    : 'SQD_RPC_ERROR';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSqdCandidateDiscovery(
  options: SqdCandidateDiscoveryOptions = {},
): Promise<SqdCandidateDiscoveryResult> {
  const fromBlock = options.fromBlock ?? SQD_DEFAULT_FROM_BLOCK;
  const toBlock = options.toBlock ?? SQD_DEFAULT_TO_BLOCK;
  const windowBlocks = options.windowBlocks ?? SQD_DEFAULT_WINDOW_BLOCKS;
  const timeoutMs = options.timeoutMs ?? SQD_DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? SQD_DEFAULT_RETRIES;
  validateOptions({ fromBlock, toBlock, windowBlocks, timeoutMs, retries });
  const endpoint = options.endpoint ?? SQD_ENDPOINT;
  const outputFile = resolve(options.out ?? SQD_DEFAULT_OUTPUT);
  const outputSha256File = sha256Path(outputFile);
  const workDirectory = resolve(options.work ?? SQD_DEFAULT_WORK);
  const summaryFile = join(workDirectory, 'summary.json');
  const contextFile = join(workDirectory, 'context.json');
  const checkpointFile = join(workDirectory, 'checkpoint.json');
  const addressesFile = join(workDirectory, 'addresses.ndjson');
  const resume = options.resume ?? true;
  const progress = options.progress ?? (() => undefined);

  if (options.force || !resume) {
    await rm(workDirectory, { recursive: true, force: true });
    await rm(outputFile, { force: true });
    await rm(outputSha256File, { force: true });
  }
  await mkdir(workDirectory, { recursive: true });

  const context: SqdDiscoveryContext = {
    schemaVersion: 1,
    dataset: SQD_DATASET,
    endpoint,
    contract: XCDOT_CONTRACT,
    transferTopic0: TRANSFER_TOPIC0,
    fromBlock,
    toBlock,
  };
  if (resume && (await pathExists(contextFile))) {
    let previous: unknown;
    try {
      previous = JSON.parse(await readFile(contextFile, 'utf8')) as unknown;
    } catch (error) {
      throw discoveryError('SQD_CONTEXT_MISMATCH', 'SQD context file is invalid JSON.', {
        path: contextFile,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!contextMatches(previous, context) && !options.force) {
      throw discoveryError('SQD_CONTEXT_MISMATCH', 'SQD resume context does not match.', {
        path: contextFile,
      });
    }
  }
  await writeJson(contextFile, context);

  let checkpoint: SqdDiscoveryCheckpoint | undefined;
  if (resume && (await pathExists(checkpointFile))) {
    try {
      checkpoint = parseCheckpoint(
        JSON.parse(await readFile(checkpointFile, 'utf8')) as unknown,
        checkpointFile,
      );
    } catch (error) {
      if (error instanceof SqdCandidateDiscoveryError) throw error;
      throw discoveryError('SQD_CONTEXT_MISMATCH', 'SQD checkpoint cannot be read.', {
        path: checkpointFile,
        error: errorMessage(error),
      });
    }
    if (checkpoint.nextBlock > toBlock + 1) {
      throw discoveryError(
        'SQD_CONTEXT_MISMATCH',
        'SQD checkpoint is beyond the configured range.',
        {
          path: checkpointFile,
          nextBlock: checkpoint.nextBlock,
          toBlock,
        },
      );
    }
  }
  const addresses = await loadAddresses(addressesFile);
  const client = options.client ?? createSqdCurlTransport({ endpoint, timeoutMs, retries });
  let cursor = checkpoint?.nextBlock ?? fromBlock;
  const currentSummary = () => buildSummary(context, checkpoint, addresses, 'IN_PROGRESS');
  await writeJson(summaryFile, currentSummary());

  try {
    while (cursor <= toBlock) {
      const requestedEnd = Math.min(cursor + windowBlocks - 1, toBlock);
      let response: string;
      try {
        response = await client.fetchRange(cursor, requestedEnd);
      } catch (error) {
        if (error instanceof SqdCandidateDiscoveryError) throw error;
        const code =
          error instanceof SqdRpcError && error.httpStatus !== undefined
            ? 'SQD_HTTP_ERROR'
            : 'SQD_RPC_ERROR';
        throw discoveryError(code, errorMessage(error), {
          ...(error instanceof SqdRpcError && error.httpStatus !== undefined
            ? { httpStatus: error.httpStatus }
            : {}),
        });
      }
      const parsed = parseSqdJsonl(response);
      if (parsed.lastReturnedBlock < cursor) {
        throw discoveryError('SQD_STREAM_NO_PROGRESS', 'SQD response did not advance the scan.', {
          requestedStart: cursor,
          lastReturnedBlock: parsed.lastReturnedBlock,
        });
      }
      if (parsed.lastReturnedBlock > requestedEnd) {
        throw discoveryError(
          'SQD_STREAM_BLOCK_OUT_OF_RANGE',
          'SQD response advanced beyond the requested range.',
          { requestedEnd, lastReturnedBlock: parsed.lastReturnedBlock },
        );
      }
      for (const address of parsed.addresses) addresses.add(address);
      checkpoint = {
        schemaVersion: 1,
        lastCompletedBlock: parsed.lastReturnedBlock,
        nextBlock: parsed.lastReturnedBlock + 1,
        requestCount: (checkpoint?.requestCount ?? 0) + 1,
        transferLogCount: (checkpoint?.transferLogCount ?? 0) + parsed.transferLogCount,
        addressCount: addresses.size,
        zeroAddressOccurrenceCount:
          (checkpoint?.zeroAddressOccurrenceCount ?? 0) + parsed.zeroAddressOccurrenceCount,
      };
      await persistAddresses(addressesFile, addresses);
      await writeJson(checkpointFile, checkpoint);
      await writeJson(summaryFile, currentSummary());
      progress(`SQD_RANGE=${cursor}-${requestedEnd}`);
      progress(`SQD_LAST_RETURNED_BLOCK=${parsed.lastReturnedBlock}`);
      progress(`SQD_LOGS_TOTAL=${checkpoint.transferLogCount}`);
      progress(`SQD_UNIQUE_ADDRESSES=${addresses.size}`);
      cursor = checkpoint.nextBlock;
    }

    const outputText = serializeSqdCandidateAddresses([...addresses]);
    const digest = sqdCandidateAddressesSha256([...addresses]);
    await writeAtomic(outputFile, outputText);
    await writeAtomic(outputSha256File, `${digest}\n`);
    const summary = buildSummary(context, checkpoint, addresses, 'COMPLETE');
    await writeJson(summaryFile, summary);
    progress('SQD_SCAN=COMPLETE');
    progress(`FROM_BLOCK=${fromBlock}`);
    progress(`TO_BLOCK=${toBlock}`);
    progress(`TRANSFER_LOG_COUNT=${summary.transferLogCount}`);
    progress(`UNIQUE_ADDRESS_COUNT=${summary.uniqueNonZeroAddressCount}`);
    progress(`SHA256=${summary.candidateSha256}`);
    progress(`OUT=${outputFile}`);
    return {
      outputFile,
      sha256File: outputSha256File,
      workDirectory,
      summaryFile,
      summary,
    };
  } catch (error) {
    const failed = buildSummary(context, checkpoint, addresses, 'FAILED', {
      errorCode: errorCode(error),
      errorMessage: errorMessage(error),
    });
    await writeJson(summaryFile, failed).catch(() => undefined);
    throw error;
  }
}
