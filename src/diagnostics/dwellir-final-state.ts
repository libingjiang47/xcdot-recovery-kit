import { access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createNownodesRpcClient,
  NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH,
  NOWNODES_FINAL_STATE_PROBE_BLOCK_NUMBER,
  NOWNODES_FINAL_STATE_PROBE_STATE_ROOT,
  NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY,
  runNownodesFinalStateProbe,
  type NownodesFinalStateProbeOptions,
  type NownodesProbeRpcClient,
} from './nownodes-final-state.js';

export const DWELLIR_FINAL_STATE_PROBE_ENDPOINT = 'https://api-moonbeam.n.dwellir.com/' as const;
export const DWELLIR_FINAL_STATE_PROBE_BLOCK_NUMBER = NOWNODES_FINAL_STATE_PROBE_BLOCK_NUMBER;
export const DWELLIR_FINAL_STATE_PROBE_BLOCK_HASH = NOWNODES_FINAL_STATE_PROBE_BLOCK_HASH;
export const DWELLIR_FINAL_STATE_PROBE_STATE_ROOT = NOWNODES_FINAL_STATE_PROBE_STATE_ROOT;
export const DWELLIR_FINAL_STATE_PROBE_STORAGE_KEY = NOWNODES_FINAL_STATE_PROBE_STORAGE_KEY;

export interface DwellirFinalStateProbeOptions
  extends Omit<NownodesFinalStateProbeOptions, 'endpoint' | 'key' | 'includeRuntimeVersion'> {
  endpointBase?: string;
  key?: string;
}

export interface DwellirFinalStateProbeReport {
  [key: string]: unknown;
  provider: 'DWELLIR';
  dwellirKeyPresent: boolean;
  status: string;
}

export interface DwellirFinalStateProbeResult {
  outputDirectory: string;
  report: DwellirFinalStateProbeReport;
  reportText: string;
}

function transformText(value: string): string {
  return value.replaceAll('NOWNODES', 'DWELLIR');
}

function transformValue(value: unknown): unknown {
  if (typeof value === 'string') return transformText(value);
  if (Array.isArray(value)) return value.map(transformValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key === 'nownodesKeyPresent' ? 'dwellirKeyPresent' : key,
      transformValue(item),
    ]),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function transformArtifact(path: string): Promise<void> {
  if (!(await pathExists(path))) return;
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  await writeFile(path, JSON.stringify(transformValue(parsed), null, 2) + '\n', 'utf8');
}

async function transformDiagnostics(outputDirectory: string): Promise<void> {
  await Promise.all(
    ['header.json', 'storage-code.json', 'read-proof.json', 'offline-proof-verification.json'].map(
      (name) => transformArtifact(join(outputDirectory, name)),
    ),
  );
}

export async function runDwellirFinalStateProbe(
  options: DwellirFinalStateProbeOptions = {},
  suppliedClient?: NownodesProbeRpcClient,
): Promise<DwellirFinalStateProbeResult> {
  const endpointBase = options.endpointBase ?? DWELLIR_FINAL_STATE_PROBE_ENDPOINT;
  const key = (options.key ?? process.env.DWELLIR_KEY)?.trim() ?? '';
  const outputDirectory = resolve(options.out ?? 'diagnostics/dwellir-final-state-probe');
  const client =
    suppliedClient ??
    (key === ''
      ? undefined
      : createNownodesRpcClient(endpointBase, key, options.timeoutMs, options.fetchImpl, 'path'));
  const probeOptions: NownodesFinalStateProbeOptions = {
    endpoint: endpointBase,
    key,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    out: outputDirectory,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.offlineVerifier === undefined ? {} : { offlineVerifier: options.offlineVerifier }),
    ...(options.verifierBinary === undefined ? {} : { verifierBinary: options.verifierBinary }),
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    includeRuntimeVersion: false,
  };
  const result = await runNownodesFinalStateProbe(probeOptions, client);
  await transformDiagnostics(outputDirectory);
  const report = transformValue(result.report) as DwellirFinalStateProbeReport;
  const reportText = transformText(result.reportText);
  await writeFile(join(outputDirectory, 'report.txt'), reportText, 'utf8');
  return { outputDirectory, report, reportText };
}
