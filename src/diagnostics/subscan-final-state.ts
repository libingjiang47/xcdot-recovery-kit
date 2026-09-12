import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { URL } from 'node:url';
import {
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
  MOONBEAM_FINAL_BLOCK_NUMBER,
} from '../final-state/constants.js';
import { SubscanFinalStateProbeError } from '../utils/errors.js';

export const SUBSCAN_FINAL_STATE_PROBE_BLOCK_NUMBER = MOONBEAM_FINAL_BLOCK_NUMBER;
export const SUBSCAN_FINAL_STATE_PROBE_STATE_ROOT = MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT;
export const SUBSCAN_FINAL_STATE_PROBE_CONTRACT =
  '0xffffffff1fcacbd218edc0eba20fc2308c778080' as const;
export const SUBSCAN_FINAL_STATE_PROBE_TOTAL_SUPPLY = '2334516727484230' as const;
export const SUBSCAN_FINAL_STATE_PROBE_DECIMALS = 10 as const;
export const SUBSCAN_FINAL_STATE_PROBE_API_ORIGIN = 'https://api.pubfi.ai' as const;
export const SUBSCAN_FINAL_STATE_PROBE_DIRECT_API_ORIGIN =
  'https://moonbeam.api.subscan.io' as const;
export const SUBSCAN_FINAL_STATE_PROBE_HEADER_MATCHER =
  '/v1/gateway/subscan/{network}/api/scan/header' as const;
export const SUBSCAN_FINAL_STATE_PROBE_ETHERSCAN_MATCHER =
  '/v1/gateway/subscan/{network}/api/scan/evm/etherscan' as const;

const DIRECT_HEADER_PATH = '/api/scan/header';
const DIRECT_ETHERSCAN_PATH = '/api/scan/evm/etherscan';
const EXACT_HEADER_MATCHER = '/v1/gateway/subscan/api/scan/header';
const EXACT_ETHERSCAN_MATCHER = '/v1/gateway/subscan/api/scan/evm/etherscan';
const SAMPLE_COUNT = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_DELAY_MS = 550;
const RETRY_DELAYS_MS = [1_000, 3_000, 5_000] as const;

export type SubscanProbeFieldStatus = 'PASS' | 'FAIL' | 'NOT_RUN';
export type SubscanProbeCapability = 'true' | 'false' | 'UNKNOWN';
export type SubscanProbeAccess = 'pubfi' | 'direct-subscan';

export interface SubscanProbeRoute {
  ready: boolean;
  matcherPath?: string;
  concretePath?: string;
  method?: 'GET' | 'POST';
  freeVariant?: boolean;
  freeSuffix?: string;
  capabilityId?: string;
  registryReadiness?: string;
  openapiReadiness?: string;
  billingMode?: string;
}

export interface SubscanProbeRoutes {
  header: SubscanProbeRoute;
  etherscan: SubscanProbeRoute;
  registryGeneration?: string;
  registryPages: number;
  openapiGeneration?: string;
}

export interface SubscanProbeFailure {
  stage: string;
  httpStatus?: number;
  apiMessage?: string;
  detail: string;
}

export interface SubscanFinalStateProbeReport {
  schemaVersion: 1;
  access: SubscanProbeAccess;
  blockNumber: string;
  xcdot: string;
  pubfiKeyPresent: boolean;
  subscanApiKeyPresent: boolean;
  pubfiHeaderRouteReady?: boolean;
  pubfiEtherscanRouteReady?: boolean;
  headerQuery: SubscanProbeFieldStatus;
  observedStateRoot?: string;
  expectedStateRoot: string;
  headerStateRootMatch?: SubscanProbeFieldStatus;
  totalSupplyQuery: SubscanProbeFieldStatus;
  observedTotalSupplyPlanck?: string;
  expectedTotalSupplyPlanck: string;
  totalSupplyMatch?: SubscanProbeFieldStatus;
  sampleAddressCount: number;
  sampleBalanceSuccessCount: number;
  historicalBalanceQuery: SubscanProbeFieldStatus;
  canUseSubscanForFinalBalances: SubscanProbeCapability;
  status: string;
  error?: SubscanProbeFailure;
  routes?: SubscanProbeRoutes;
}

export interface SubscanFinalStateProbeResult {
  outputDirectory: string;
  report: SubscanFinalStateProbeReport;
  reportText: string;
}

export interface SubscanFinalStateProbeOptions {
  dataset: string;
  out?: string;
  access?: SubscanProbeAccess;
  pubfiKey?: string;
  subscanApiKey?: string;
  apiOrigin?: string;
  directApiOrigin?: string;
  timeoutMs?: number;
  retries?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface PubFiResponse {
  status: number;
  headers: Headers;
  json: unknown;
  text: string;
}

class SubscanHttpError extends Error {
  readonly httpStatus: number | undefined;
  readonly apiMessage: string | undefined;
  readonly transient: boolean;

  constructor(
    message: string,
    options: {
      httpStatus?: number;
      apiMessage?: string;
      transient?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'SubscanHttpError';
    this.httpStatus = options.httpStatus;
    this.apiMessage = options.apiMessage;
    this.transient = options.transient ?? false;
  }
}

interface PubFiRequestOptions {
  query?: readonly [string, string][];
  body?: unknown;
  authenticated?: boolean;
}

function probeInputError(message: string, details: Record<string, string | number | boolean> = {}) {
  return new SubscanFinalStateProbeError(message, details);
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

function safeText(value: unknown): string {
  return redactUrls(value instanceof Error ? `${value.name}: ${value.message}` : String(value));
}

function bodyPreview(text: string): string {
  return text.length > 4096 ? `${text.slice(0, 4096)}…` : text;
}

function apiMessage(value: unknown, fallback: string): string | undefined {
  if (typeof value !== 'object' || value === null) return fallback;
  const record = value as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return redactUrls(message);
  }
  for (const key of ['message', 'error', 'detail']) {
    if (typeof record[key] === 'string') return redactUrls(record[key] as string);
  }
  return fallback;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof SubscanHttpError) return error.transient;
  return /timeout|timed out|abort|fetch failed|network|econn|socket|connection|temporar/i.test(
    safeText(error),
  );
}

async function retryPubFi<T>(
  operation: () => Promise<T>,
  retries: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isTransientError(error)) throw error;
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!);
    }
  }
  throw lastError ?? new Error('Subscan request failed.');
}

class PubFiClient {
  constructor(
    private readonly origin: string,
    private readonly key: string | undefined,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch,
    private readonly credentialHeader: 'authorization' | 'x-api-key',
  ) {}

  async request(
    method: 'GET' | 'POST',
    path: string,
    options: PubFiRequestOptions = {},
  ): Promise<PubFiResponse> {
    const url = new URL(path, this.origin);
    for (const [name, value] of options.query ?? []) url.searchParams.append(name, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers();
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (options.authenticated !== false && this.key !== undefined) {
      headers.set(
        this.credentialHeader,
        this.credentialHeader === 'authorization' ? `Bearer ${this.key}` : this.key,
      );
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SubscanHttpError(`Subscan request timed out for ${method} ${path}.`, {
          transient: true,
        });
      }
      throw new SubscanHttpError(
        `Subscan request failed for ${method} ${path}: ${safeText(error)}.`,
        {
          transient: true,
        },
      );
    } finally {
      clearTimeout(timer);
    }
    const rawText = await response.text();
    const text = bodyPreview(rawText);
    const json = parseJson(rawText);
    if (!response.ok) {
      const message = apiMessage(json, text);
      throw new SubscanHttpError(
        `Subscan HTTP ${response.status} for ${method} ${path}: ${message ?? 'no API message'}.`,
        {
          httpStatus: response.status,
          ...(message === undefined ? {} : { apiMessage: message }),
          transient: isTransientStatus(response.status),
        },
      );
    }
    if (json === undefined) {
      throw new SubscanHttpError(`Subscan returned invalid JSON for ${method} ${path}.`, {
        httpStatus: response.status,
        apiMessage: text,
      });
    }
    return { status: response.status, headers: response.headers, json, text };
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, keys: readonly string[]): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === 'string') return record[key] as string;
  return undefined;
}

function integerText(value: unknown, label: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  throw new Error(`${label} is not a decimal unsigned integer.`);
}

export function parseSubscanHistoricalInteger(value: unknown, label: string): string {
  const text = integerText(value, label);
  return BigInt(text).toString(10);
}

function apiResponseSucceeded(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.status !== undefined) {
    const status = String(record.status).toLowerCase();
    if (!['1', 'success', 'ok'].includes(status)) return false;
  }
  if (record.code !== undefined) {
    const code = String(record.code).toLowerCase();
    if (!['0', 'success', 'ok'].includes(code)) return false;
  }
  if (record.status === undefined && record.code === undefined) return false;
  return true;
}

function responsePayload(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.data !== undefined) return record.data;
  return record.result;
}

function sensitiveField(key: string): boolean {
  return /^(api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|payment[-_]?signature)$/i.test(
    key,
  );
}

function redactSensitive(value: unknown, key = ''): unknown {
  if (sensitiveField(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactUrls(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
      childKey,
      redactSensitive(childValue, childKey),
    ]),
  );
}

function sanitizeJson(value: unknown): unknown {
  return redactSensitive(value);
}

function appendFreeSuffix(path: string, suffix: string | undefined): string {
  if (suffix === undefined || path.endsWith(suffix)) return path;
  return `${path}${suffix}`;
}

function concretePath(matcherPath: string): string {
  return matcherPath.replaceAll('{network}', 'moonbeam');
}

function operationFor(
  capability: Record<string, unknown>,
  method: 'GET' | 'POST',
): Record<string, unknown> | undefined {
  const operations = capability.operations;
  if (!Array.isArray(operations)) return undefined;
  return operations.find((operation) => {
    if (typeof operation !== 'object' || operation === null) return false;
    return String((operation as Record<string, unknown>).method).toUpperCase() === method;
  }) as Record<string, unknown> | undefined;
}

function capabilityMatches(
  capabilities: readonly Record<string, unknown>[],
  matcherPath: string,
  method: 'GET' | 'POST',
): Record<string, unknown> | undefined {
  const matches = capabilities.filter((capability) => {
    if (String(capability.provider_key).toLowerCase() !== 'subscan') return false;
    const matcher = capability.matcher;
    if (typeof matcher !== 'object' || matcher === null) return false;
    if (String((matcher as Record<string, unknown>).path) !== matcherPath) return false;
    const methods = capability.methods;
    return (
      Array.isArray(methods) &&
      methods.some((entry) => String(entry).toUpperCase() === method) &&
      operationFor(capability, method) !== undefined
    );
  });
  return (
    matches.find(
      (capability) => stringField(capability.readiness, ['status'])?.toLowerCase() === 'ready',
    ) ?? matches[0]
  );
}

function openapiOperation(
  openapi: Record<string, unknown>,
  matcherPath: string,
  method: 'GET' | 'POST',
): Record<string, unknown> | undefined {
  const paths = openapi.paths;
  if (typeof paths !== 'object' || paths === null) return undefined;
  const path = (paths as Record<string, unknown>)[matcherPath];
  if (typeof path !== 'object' || path === null) return undefined;
  const operation = (path as Record<string, unknown>)[method.toLowerCase()];
  return typeof operation === 'object' && operation !== null
    ? (operation as Record<string, unknown>)
    : undefined;
}

function openapiReadiness(operation: Record<string, unknown> | undefined): string | undefined {
  if (operation === undefined) return undefined;
  const readiness = operation['x-pubfi-registry-readiness'];
  if (typeof readiness !== 'object' || readiness === null) return undefined;
  return typeof (readiness as Record<string, unknown>).status === 'string'
    ? ((readiness as Record<string, unknown>).status as string)
    : undefined;
}

function freeSuffix(
  capability: Record<string, unknown> | undefined,
  operation: Record<string, unknown> | undefined,
): string | undefined {
  const free = operation?.['x-pubfi-free-variant'];
  if (
    typeof free === 'object' &&
    free !== null &&
    typeof (free as Record<string, unknown>).suffix === 'string'
  ) {
    return (free as Record<string, unknown>).suffix as string;
  }
  if (capability?.free_rate_limit !== undefined && capability.free_rate_limit !== null) {
    return ':free';
  }
  return undefined;
}

function billingMode(
  capability: Record<string, unknown> | undefined,
  method: 'GET' | 'POST',
): string | undefined {
  const operation = capability === undefined ? undefined : operationFor(capability, method);
  if (operation === undefined) return undefined;
  const billing = operation.billing;
  if (typeof billing !== 'object' || billing === null) return undefined;
  return typeof (billing as Record<string, unknown>).mode === 'string'
    ? ((billing as Record<string, unknown>).mode as string)
    : undefined;
}

function selectRoute(
  capabilities: readonly Record<string, unknown>[],
  openapi: Record<string, unknown>,
  matcherPaths: readonly string[],
  method: 'GET' | 'POST',
): SubscanProbeRoute {
  let fallback: SubscanProbeRoute | undefined;
  for (const matcherPath of matcherPaths) {
    const capability = capabilityMatches(capabilities, matcherPath, method);
    const operation = openapiOperation(openapi, matcherPath, method);
    const registryStatus =
      capability === undefined ? undefined : stringField(capability.readiness, ['status']);
    const openapiStatus = openapiReadiness(operation);
    const suffix = freeSuffix(capability, operation);
    const ready =
      capability !== undefined &&
      operation !== undefined &&
      registryStatus?.toLowerCase() === 'ready' &&
      openapiStatus?.toLowerCase() === 'ready';
    const operationBilling = billingMode(capability, method);
    const route: SubscanProbeRoute = ready
      ? {
          ready: true,
          matcherPath,
          concretePath: appendFreeSuffix(concretePath(matcherPath), suffix),
          method,
          ...(suffix === undefined
            ? { freeVariant: false }
            : { freeVariant: true, freeSuffix: suffix }),
          ...(capability?.capability_id === undefined
            ? {}
            : { capabilityId: String(capability.capability_id) }),
          ...(registryStatus === undefined ? {} : { registryReadiness: registryStatus }),
          ...(openapiStatus === undefined ? {} : { openapiReadiness: openapiStatus }),
          ...(operationBilling === undefined ? {} : { billingMode: operationBilling }),
        }
      : {
          ready: false,
          matcherPath,
          method,
          ...(suffix === undefined ? {} : { freeSuffix: suffix, freeVariant: true }),
          ...(capability?.capability_id === undefined
            ? {}
            : { capabilityId: String(capability.capability_id) }),
          ...(registryStatus === undefined ? {} : { registryReadiness: registryStatus }),
          ...(openapiStatus === undefined ? {} : { openapiReadiness: openapiStatus }),
          ...(operationBilling === undefined ? {} : { billingMode: operationBilling }),
        };
    fallback ??= route;
    if (route.ready) return route;
  }
  return fallback ?? { ready: false, method };
}

async function discoverCapabilities(
  client: PubFiClient,
  retries: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<{ capabilities: Record<string, unknown>[]; generationId?: string; pages: number }> {
  const capabilities: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  let generationId: string | undefined;
  let pages = 0;
  const seenCursors = new Set<string>();
  do {
    const query: [string, string][] = [
      ['provider_key', 'subscan'],
      ['limit', '1000'],
    ];
    if (cursor !== undefined) query.push(['cursor', cursor]);
    const response = await retryPubFi(
      () => client.request('GET', '/v1/capabilities', { query, authenticated: false }),
      retries,
      sleep,
    );
    const page = asRecord(response.json, 'capability page');
    const pageCapabilities = page.capabilities;
    if (!Array.isArray(pageCapabilities))
      throw new Error('Capability page has no capabilities array.');
    const pageGeneration = stringField(page.generation, ['id']);
    if (
      generationId !== undefined &&
      pageGeneration !== undefined &&
      pageGeneration !== generationId
    ) {
      throw new Error('Capability pagination changed Registry generation.');
    }
    generationId ??= pageGeneration;
    for (const capability of pageCapabilities) {
      if (typeof capability === 'object' && capability !== null) {
        capabilities.push(capability as Record<string, unknown>);
      }
    }
    pages += 1;
    const next =
      typeof page.next_cursor === 'string' && page.next_cursor !== ''
        ? page.next_cursor
        : undefined;
    if (next !== undefined && seenCursors.has(next))
      throw new Error('Capability pagination repeated a cursor.');
    if (next !== undefined) seenCursors.add(next);
    cursor = next;
  } while (cursor !== undefined);
  return { capabilities, ...(generationId === undefined ? {} : { generationId }), pages };
}

export async function discoverSubscanPubFiRoutes(
  options: Pick<
    SubscanFinalStateProbeOptions,
    'apiOrigin' | 'timeoutMs' | 'fetchImpl' | 'pubfiKey'
  > & {
    retries: number;
    sleep: (milliseconds: number) => Promise<void>;
  },
): Promise<SubscanProbeRoutes> {
  const client = new PubFiClient(
    options.apiOrigin ?? SUBSCAN_FINAL_STATE_PROBE_API_ORIGIN,
    options.pubfiKey,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.fetchImpl ?? fetch,
    'authorization',
  );
  const discovered = await discoverCapabilities(client, options.retries, options.sleep);
  const openapiResponse = await retryPubFi(
    () => client.request('GET', '/openapi.json', { authenticated: false }),
    options.retries,
    options.sleep,
  );
  const openapi = asRecord(openapiResponse.json, 'Runtime OpenAPI');
  const header = selectRoute(
    discovered.capabilities,
    openapi,
    [SUBSCAN_FINAL_STATE_PROBE_HEADER_MATCHER, EXACT_HEADER_MATCHER],
    'POST',
  );
  const etherscan = selectRoute(
    discovered.capabilities,
    openapi,
    [SUBSCAN_FINAL_STATE_PROBE_ETHERSCAN_MATCHER, EXACT_ETHERSCAN_MATCHER],
    'GET',
  );
  return {
    header,
    etherscan,
    ...(discovered.generationId === undefined
      ? {}
      : { registryGeneration: discovered.generationId }),
    registryPages: discovered.pages,
    ...(typeof openapi.info === 'object' &&
    openapi.info !== null &&
    typeof (openapi.info as Record<string, unknown>).version === 'string'
      ? { openapiGeneration: (openapi.info as Record<string, unknown>).version as string }
      : {}),
  };
}

function directSubscanRoutes(): SubscanProbeRoutes {
  return {
    header: {
      ready: true,
      matcherPath: DIRECT_HEADER_PATH,
      concretePath: DIRECT_HEADER_PATH,
      method: 'POST',
      freeVariant: false,
    },
    etherscan: {
      ready: true,
      matcherPath: DIRECT_ETHERSCAN_PATH,
      concretePath: DIRECT_ETHERSCAN_PATH,
      method: 'GET',
      freeVariant: false,
    },
    registryPages: 0,
    openapiGeneration: 'direct-subscan',
  };
}

function normalizeFailure(stage: string, error: unknown): SubscanProbeFailure {
  if (error instanceof SubscanHttpError) {
    return {
      stage,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.apiMessage === undefined ? {} : { apiMessage: error.apiMessage }),
      detail: safeText(error),
    };
  }
  return { stage, detail: safeText(error) };
}

function initialReport(
  access: SubscanProbeAccess,
  credentialPresent: boolean,
): SubscanFinalStateProbeReport {
  return {
    schemaVersion: 1,
    access,
    blockNumber: SUBSCAN_FINAL_STATE_PROBE_BLOCK_NUMBER,
    xcdot: SUBSCAN_FINAL_STATE_PROBE_CONTRACT,
    pubfiKeyPresent: access === 'pubfi' && credentialPresent,
    subscanApiKeyPresent: access === 'direct-subscan' && credentialPresent,
    headerQuery: 'NOT_RUN',
    expectedStateRoot: SUBSCAN_FINAL_STATE_PROBE_STATE_ROOT,
    totalSupplyQuery: 'NOT_RUN',
    expectedTotalSupplyPlanck: SUBSCAN_FINAL_STATE_PROBE_TOTAL_SUPPLY,
    sampleAddressCount: SAMPLE_COUNT,
    sampleBalanceSuccessCount: 0,
    historicalBalanceQuery: 'NOT_RUN',
    canUseSubscanForFinalBalances: 'UNKNOWN',
    status: 'NOT_RUN',
  };
}

function reportLine(key: string, value: string | number | boolean | undefined): string {
  return `${key}=${value === undefined ? '' : String(value)}`;
}

function reportText(report: SubscanFinalStateProbeReport): string {
  const lines = [
    reportLine('ACCESS', report.access),
    reportLine('BLOCK_NUMBER', report.blockNumber),
    reportLine('XCDOT', report.xcdot),
    '',
    reportLine('PUBFI_KEY_PRESENT', report.pubfiKeyPresent),
    reportLine('SUBSCAN_API_KEY_PRESENT', report.subscanApiKeyPresent),
    reportLine('PUBFI_HEADER_ROUTE_READY', report.pubfiHeaderRouteReady),
    reportLine('PUBFI_ETHERSCAN_ROUTE_READY', report.pubfiEtherscanRouteReady),
    '',
    reportLine('HEADER_QUERY', report.headerQuery),
    reportLine('OBSERVED_STATE_ROOT', report.observedStateRoot),
    reportLine('EXPECTED_STATE_ROOT', report.expectedStateRoot),
    reportLine('HEADER_STATE_ROOT_MATCH', report.headerStateRootMatch),
    '',
    reportLine('TOTAL_SUPPLY_QUERY', report.totalSupplyQuery),
    reportLine('OBSERVED_TOTAL_SUPPLY_PLANCK', report.observedTotalSupplyPlanck),
    reportLine('EXPECTED_TOTAL_SUPPLY_PLANCK', report.expectedTotalSupplyPlanck),
    reportLine('TOTAL_SUPPLY_MATCH', report.totalSupplyMatch),
    '',
    reportLine('SAMPLE_ADDRESS_COUNT', report.sampleAddressCount),
    reportLine('SAMPLE_BALANCE_SUCCESS_COUNT', report.sampleBalanceSuccessCount),
    reportLine('HISTORICAL_BALANCE_QUERY', report.historicalBalanceQuery),
    '',
    reportLine('CAN_USE_SUBSCAN_FOR_FINAL_BALANCES', report.canUseSubscanForFinalBalances),
    reportLine('STATUS', report.status),
  ];
  if (report.error !== undefined) {
    lines.push(
      '',
      reportLine('ERROR_STAGE', report.error.stage),
      reportLine('HTTP_STATUS', report.error.httpStatus),
      reportLine('API_MESSAGE', report.error.apiMessage),
      `ERROR_DETAIL=${JSON.stringify(report.error.detail)}`,
    );
  }
  return `${lines.join('\n')}\n`;
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
  await writeAtomic(path, `${JSON.stringify(sanitizeJson(value), null, 2)}\n`);
}

function routeDescription(route: SubscanProbeRoute): string {
  if (!route.ready) {
    return `ready=false matcher=${route.matcherPath ?? 'unknown'} registry=${route.registryReadiness ?? 'unknown'} openapi=${route.openapiReadiness ?? 'unknown'}`;
  }
  return `ready=true method=${route.method} path=${route.concretePath} free=${route.freeVariant === true} billing=${route.billingMode ?? 'unknown'}`;
}

function readRouteError(routes: SubscanProbeRoutes): SubscanProbeFailure {
  const missing: string[] = [];
  if (!routes.header.ready) missing.push('header');
  if (!routes.etherscan.ready) missing.push('etherscan');
  return {
    stage: 'route-discovery',
    detail: `Required live PubFi route is not ready: ${missing.join(', ')}.`,
  };
}

async function writeArtifacts(
  outputDirectory: string,
  report: SubscanFinalStateProbeReport,
  routes: SubscanProbeRoutes | undefined,
  headerArtifact: unknown,
  totalSupplyArtifact: unknown,
  sampleLines: readonly string[],
): Promise<string> {
  if (routes !== undefined) report.routes = routes;
  const text = reportText(report);
  const routeSection =
    report.access === 'direct-subscan'
      ? `Direct Subscan host: ${SUBSCAN_FINAL_STATE_PROBE_DIRECT_API_ORIGIN}\nPubFi route discovery: bypassed.\n`
      : routes === undefined
        ? 'Route discovery did not complete.\n'
        : [
            `Registry generation: ${routes.registryGeneration ?? 'not recorded'}`,
            `Registry pages: ${routes.registryPages}`,
            `Header route: ${routeDescription(routes.header)}`,
            `Etherscan-like route: ${routeDescription(routes.etherscan)}`,
            `Runtime OpenAPI version: ${routes.openapiGeneration ?? 'not recorded'}`,
          ].join('\n') + '\n';
  const readme = [
    '# Subscan/PubFi final-state minimal probe',
    '',
    'Diagnostic-only evidence for Moonbeam block 16,796,696. This run never queries all candidates, replays Transfer logs, modifies source CSV/candidate artifacts, or creates a canonical snapshot.',
    '',
    `Generated at: ${new Date().toISOString()}`,
    `PUBFI_KEY_PRESENT=${report.pubfiKeyPresent}`,
    '',
    routeSection.trimEnd(),
    '',
    report.access === 'direct-subscan'
      ? 'The direct Subscan API key is loaded only from the process environment and is never written to these artifacts.'
      : 'The PubFi API key is loaded only from the process environment and is never written to these artifacts.',
    '',
    text.trimEnd(),
    '',
  ].join('\n');
  await Promise.all([
    writeAtomic(join(outputDirectory, 'README.md'), readme),
    writeJson(join(outputDirectory, 'header.json'), headerArtifact),
    writeJson(join(outputDirectory, 'total-supply.json'), totalSupplyArtifact),
    writeAtomic(
      join(outputDirectory, 'sample-balances.ndjson'),
      sampleLines.length === 0 ? '' : `${sampleLines.join('\n')}\n`,
    ),
    writeAtomic(join(outputDirectory, 'report.txt'), text),
  ]);
  return text;
}

function parseH160(value: unknown, lineNumber: number): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Candidate line ${lineNumber} is not a valid H160.`);
  }
  return value.toLowerCase();
}

async function readSampleAddresses(dataset: string): Promise<string[]> {
  const candidatePath = join(resolve(dataset), 'candidate-addresses.ndjson');
  const text = await readFile(candidatePath, 'utf8');
  const addresses: string[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line === '') continue;
    const value = JSON.parse(line) as unknown;
    const record = asRecord(value, `candidate line ${index + 1}`);
    addresses.push(parseH160(record.address, index + 1));
  }
  if (addresses.length < SAMPLE_COUNT) {
    throw new Error(`Candidate set has ${addresses.length} addresses; five are required.`);
  }
  return addresses.slice(0, SAMPLE_COUNT);
}

function headerDetails(value: unknown): {
  blockNumber: string;
  stateRoot: string;
  parentHash?: string;
  extrinsicsRoot?: string;
} {
  if (!apiResponseSucceeded(value)) throw new Error('Header API response did not report success.');
  const payload = responsePayload(value);
  const record = asRecord(payload, 'header data');
  const blockNumber = integerText(
    record.block_number ?? record.block_num ?? record.number,
    'header block number',
  );
  const stateRoot = stringField(record, ['state_root', 'stateRoot']);
  if (stateRoot === undefined) throw new Error('Header response has no state_root.');
  const parentHash = stringField(record, ['parent_hash', 'parentHash']);
  const extrinsicsRoot = stringField(record, ['extrinsics_root', 'extrinsicsRoot']);
  return {
    blockNumber,
    stateRoot,
    ...(parentHash === undefined ? {} : { parentHash }),
    ...(extrinsicsRoot === undefined ? {} : { extrinsicsRoot }),
  };
}

function historicalResult(value: unknown, label: string): string {
  if (!apiResponseSucceeded(value))
    throw new Error(`${label} API response did not report success.`);
  if (typeof value !== 'object' || value === null)
    throw new Error(`${label} response is not an object.`);
  const result = (value as Record<string, unknown>).result;
  return parseSubscanHistoricalInteger(result, `${label} result`);
}

function pathWithQuery(
  route: SubscanProbeRoute,
  query: readonly [string, string][],
): { path: string; query: readonly [string, string][] } {
  if (!route.ready || route.concretePath === undefined)
    throw new Error('PubFi route is not ready.');
  return { path: route.concretePath, query };
}

function sampleLine(address: string, response: PubFiResponse, balancePlanck: string): string {
  return JSON.stringify({
    address,
    balancePlanck,
    httpStatus: response.status,
    response: sanitizeJson(response.json),
  });
}

function sampleErrorLine(address: string, failure: SubscanProbeFailure): string {
  return JSON.stringify({
    address,
    errorStage: failure.stage,
    ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    ...(failure.apiMessage === undefined ? {} : { apiMessage: failure.apiMessage }),
    error: failure.detail,
  });
}

export async function runSubscanFinalStateProbe(
  options: SubscanFinalStateProbeOptions,
): Promise<SubscanFinalStateProbeResult> {
  const access = options.access ?? 'pubfi';
  if (access !== 'pubfi' && access !== 'direct-subscan') {
    throw probeInputError('Probe access must be pubfi or direct-subscan.', { access });
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw probeInputError('Probe timeout must be an integer from 1 to 120000 ms.', { timeoutMs });
  }
  if (!Number.isInteger(retries) || retries < 1 || retries > 3) {
    throw probeInputError('Probe retries must be an integer from 1 to 3.', { retries });
  }
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5_000) {
    throw probeInputError('Probe delay must be an integer from 0 to 5000 ms.', { delayMs });
  }
  const outputDirectory = resolve(options.out ?? 'diagnostics/subscan-final-state-probe');
  await mkdir(outputDirectory, { recursive: true });
  const credential =
    access === 'pubfi'
      ? (options.pubfiKey ?? process.env.PUBFI_KEY)
      : (options.subscanApiKey ?? process.env.SUBSCAN_API_KEY);
  const keyPresent = typeof credential === 'string' && credential.length > 0;
  const report = initialReport(access, keyPresent);
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  let routes: SubscanProbeRoutes | undefined;
  let headerArtifact: unknown = { status: 'NOT_RUN' };
  let totalSupplyArtifact: unknown = { status: 'NOT_RUN' };
  const sampleLines: string[] = [];
  const client = new PubFiClient(
    access === 'pubfi'
      ? (options.apiOrigin ?? SUBSCAN_FINAL_STATE_PROBE_API_ORIGIN)
      : (options.directApiOrigin ?? SUBSCAN_FINAL_STATE_PROBE_DIRECT_API_ORIGIN),
    credential,
    timeoutMs,
    options.fetchImpl ?? fetch,
    access === 'pubfi' ? 'authorization' : 'x-api-key',
  );
  if (access === 'pubfi') {
    try {
      routes = await discoverSubscanPubFiRoutes({
        ...(options.apiOrigin === undefined ? {} : { apiOrigin: options.apiOrigin }),
        timeoutMs,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(credential === undefined ? {} : { pubfiKey: credential }),
        retries,
        sleep,
      });
      report.pubfiHeaderRouteReady = routes.header.ready;
      report.pubfiEtherscanRouteReady = routes.etherscan.ready;
      if (!routes.header.ready || !routes.etherscan.ready) {
        report.status = 'PUBFI_ROUTE_UNAVAILABLE';
        report.error = readRouteError(routes);
        const reportTextValue = await writeArtifacts(
          outputDirectory,
          report,
          routes,
          headerArtifact,
          totalSupplyArtifact,
          sampleLines,
        );
        return { outputDirectory, report, reportText: reportTextValue };
      }
    } catch (error) {
      report.status = 'PUBFI_ROUTE_UNAVAILABLE';
      report.error = normalizeFailure('route-discovery', error);
      const reportTextValue = await writeArtifacts(
        outputDirectory,
        report,
        routes,
        headerArtifact,
        totalSupplyArtifact,
        sampleLines,
      );
      return { outputDirectory, report, reportText: reportTextValue };
    }
  } else {
    routes = directSubscanRoutes();
  }
  if (!keyPresent) {
    report.status = access === 'pubfi' ? 'PUBFI_KEY_MISSING' : 'SUBSCAN_API_KEY_MISSING';
    report.error = {
      stage: 'credentials',
      detail:
        access === 'pubfi'
          ? 'PUBFI_KEY is not present in the process environment.'
          : 'SUBSCAN_API_KEY is not present in the process environment.',
    };
    const reportTextValue = await writeArtifacts(
      outputDirectory,
      report,
      routes,
      headerArtifact,
      totalSupplyArtifact,
      sampleLines,
    );
    return { outputDirectory, report, reportText: reportTextValue };
  }
  let sampleAddresses: string[];
  try {
    sampleAddresses = await readSampleAddresses(options.dataset);
  } catch (error) {
    report.status = 'CANDIDATE_DATASET_UNAVAILABLE';
    report.error = normalizeFailure('candidate-dataset', error);
    const reportTextValue = await writeArtifacts(
      outputDirectory,
      report,
      routes,
      headerArtifact,
      totalSupplyArtifact,
      sampleLines,
    );
    return { outputDirectory, report, reportText: reportTextValue };
  }
  report.sampleAddressCount = sampleAddresses.length;
  const request = (operation: () => Promise<PubFiResponse>): Promise<PubFiResponse> =>
    retryPubFi(operation, retries, sleep);
  const waitBetweenCalls = async (): Promise<void> => {
    if (delayMs > 0) await sleep(delayMs);
  };
  let firstSampleFailure: SubscanProbeFailure | undefined;
  try {
    const headerRoute = routes.header;
    const headerResponse = await request(() =>
      client.request('POST', headerRoute.concretePath!, {
        body: { block_num: Number(SUBSCAN_FINAL_STATE_PROBE_BLOCK_NUMBER) },
      }),
    );
    headerArtifact = headerResponse.json;
    const details = headerDetails(headerResponse.json);
    report.headerQuery = 'PASS';
    report.observedStateRoot = details.stateRoot;
    report.headerStateRootMatch =
      details.blockNumber === SUBSCAN_FINAL_STATE_PROBE_BLOCK_NUMBER &&
      details.stateRoot.toLowerCase() === SUBSCAN_FINAL_STATE_PROBE_STATE_ROOT
        ? 'PASS'
        : 'FAIL';
    if (report.headerStateRootMatch !== 'PASS') {
      report.canUseSubscanForFinalBalances = 'false';
      report.status = 'SUBSCAN_BLOCK_MISMATCH';
      const reportTextValue = await writeArtifacts(
        outputDirectory,
        report,
        routes,
        headerArtifact,
        totalSupplyArtifact,
        sampleLines,
      );
      return { outputDirectory, report, reportText: reportTextValue };
    }
  } catch (error) {
    headerArtifact = { status: 'FAIL', error: normalizeFailure('header', error) };
    report.headerQuery = 'FAIL';
    report.canUseSubscanForFinalBalances = 'false';
    report.status = 'SUBSCAN_HEADER_QUERY_UNAVAILABLE';
    report.error = normalizeFailure('header', error);
    const reportTextValue = await writeArtifacts(
      outputDirectory,
      report,
      routes,
      headerArtifact,
      totalSupplyArtifact,
      sampleLines,
    );
    return { outputDirectory, report, reportText: reportTextValue };
  }
  await waitBetweenCalls();
  try {
    const query: [string, string][] = [
      ['module', 'stats'],
      ['action', 'tokensupplyhistory'],
      ['contractaddress', SUBSCAN_FINAL_STATE_PROBE_CONTRACT],
      ['blockno', SUBSCAN_FINAL_STATE_PROBE_BLOCK_NUMBER],
    ];
    const supplyResponse = await request(() =>
      client.request('GET', pathWithQuery(routes!.etherscan, query).path, {
        query,
      }),
    );
    totalSupplyArtifact = supplyResponse.json;
    const observed = historicalResult(supplyResponse.json, 'totalSupply');
    report.totalSupplyQuery = 'PASS';
    report.observedTotalSupplyPlanck = observed;
    report.totalSupplyMatch = observed === SUBSCAN_FINAL_STATE_PROBE_TOTAL_SUPPLY ? 'PASS' : 'FAIL';
    if (report.totalSupplyMatch !== 'PASS') {
      report.canUseSubscanForFinalBalances = 'false';
      report.status = 'SUBSCAN_HISTORICAL_STATE_MISMATCH';
      const reportTextValue = await writeArtifacts(
        outputDirectory,
        report,
        routes,
        headerArtifact,
        totalSupplyArtifact,
        sampleLines,
      );
      return { outputDirectory, report, reportText: reportTextValue };
    }
  } catch (error) {
    totalSupplyArtifact = { status: 'FAIL', error: normalizeFailure('total-supply', error) };
    report.totalSupplyQuery = 'FAIL';
    report.canUseSubscanForFinalBalances = 'false';
    report.status = 'SUBSCAN_TOTAL_SUPPLY_UNAVAILABLE';
    report.error = normalizeFailure('total-supply', error);
    const reportTextValue = await writeArtifacts(
      outputDirectory,
      report,
      routes,
      headerArtifact,
      totalSupplyArtifact,
      sampleLines,
    );
    return { outputDirectory, report, reportText: reportTextValue };
  }
  for (const [index, address] of sampleAddresses.entries()) {
    if (index > 0) await waitBetweenCalls();
    const query: [string, string][] = [
      ['module', 'account'],
      ['action', 'tokenbalancehistory'],
      ['contractaddress', SUBSCAN_FINAL_STATE_PROBE_CONTRACT],
      ['address', address],
      ['blockno', SUBSCAN_FINAL_STATE_PROBE_BLOCK_NUMBER],
    ];
    try {
      const response = await request(() =>
        client.request('GET', pathWithQuery(routes!.etherscan, query).path, { query }),
      );
      const balance = historicalResult(response.json, `balanceOf(${address})`);
      sampleLines.push(sampleLine(address, response, balance));
      report.sampleBalanceSuccessCount += 1;
    } catch (error) {
      const failure = normalizeFailure('sample-balance', error);
      firstSampleFailure ??= failure;
      sampleLines.push(sampleErrorLine(address, failure));
    }
  }
  report.historicalBalanceQuery =
    report.sampleBalanceSuccessCount === SAMPLE_COUNT ? 'PASS' : 'FAIL';
  if (report.historicalBalanceQuery === 'PASS') {
    report.canUseSubscanForFinalBalances = 'true';
    report.status = 'SUBSCAN_FINAL_STATE_CAPABLE';
  } else {
    report.canUseSubscanForFinalBalances = 'false';
    report.status = 'SUBSCAN_BALANCE_HISTORY_UNAVAILABLE';
    const failedCount = SAMPLE_COUNT - report.sampleBalanceSuccessCount;
    report.error = {
      ...(firstSampleFailure ?? {
        stage: 'sample-balance',
        detail: 'Historical balance query failed.',
      }),
      detail:
        `${failedCount} of ${SAMPLE_COUNT} historical balance queries failed. ${firstSampleFailure?.detail ?? ''}`.trim(),
    };
  }
  const reportTextValue = await writeArtifacts(
    outputDirectory,
    report,
    routes,
    headerArtifact,
    totalSupplyArtifact,
    sampleLines,
  );
  return { outputDirectory, report, reportText: reportTextValue };
}
