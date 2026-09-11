import { mkdtemp, mkdir, readFile, rename, rm, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  HolderSchema,
  ManifestSchema,
  VerificationSchema,
  ClassificationSchema,
} from '../schemas/index.js';
import { CanonicalSerializationError } from '../utils/errors.js';
import type { HolderRecord, SnapshotManifest, VerificationResult } from '../types.js';
import { sha256Hex } from './digest.js';
import { compareCanonicalStrings } from '../utils/order.js';

const execFileAsync = promisify(execFile);

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function readManifest(snapshotDir: string): Promise<SnapshotManifest> {
  const parsed = ManifestSchema.parse(await readJsonFile(join(snapshotDir, 'manifest.json')));
  return parsed;
}

export async function readHolders(
  snapshotDir: string,
): Promise<{ holders: HolderRecord[]; raw: string }> {
  const raw = await readFile(join(snapshotDir, 'holders.ndjson'), 'utf8');
  const holders: HolderRecord[] = [];
  const lines = raw === '' ? [] : raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (line === '') throw new CanonicalSerializationError('holders.ndjson contains a blank line.');
    const holder = HolderSchema.parse(JSON.parse(line) as unknown);
    holders.push(holder);
  }
  return { holders, raw };
}

export async function writeText(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: 'utf8', flag: 'wx' });
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2) + '\n');
}

export async function overwriteJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function makeSnapshotTempDir(outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  return mkdtemp(join(resolve(outDir), '.tmp-snapshot-'));
}

export async function publishSnapshot(
  tempDir: string,
  targetDir: string,
  force: boolean,
): Promise<void> {
  if (await pathExists(targetDir)) {
    if (!force)
      throw new CanonicalSerializationError(`Snapshot directory already exists: ${targetDir}`);
    console.error(`[canonical] WARNING: --force will replace ${targetDir}`);
    await rm(targetDir, { recursive: true, force: true });
  }
  await rename(tempDir, targetDir);
}

export async function cleanupSnapshotTemp(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}

export async function refreshSnapshotSums(snapshotDir: string): Promise<void> {
  const names = [
    'account-classification.json',
    'holders.csv',
    'holders.json',
    'holders.ndjson',
    'manifest.json',
    'provenance.json',
    'verification.json',
  ];
  const files: Record<string, string> = {};
  for (const name of names) files[name] = await readFile(join(snapshotDir, name), 'utf8');
  const hashes =
    Object.entries(files)
      .sort(([a], [b]) => compareCanonicalStrings(a, b))
      .map(([name, content]) => `${sha256Hex(content)}  ${name}`)
      .join('\n') + '\n';
  await writeFile(join(snapshotDir, 'SHA256SUMS'), hashes, { encoding: 'utf8' });
}

export async function readGitCommit(): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['rev-parse', 'HEAD']);
    const commit = result.stdout.trim();
    return commit || undefined;
  } catch {
    return undefined;
  }
}

export function validateVerification(value: unknown): VerificationResult {
  return VerificationSchema.parse(value);
}

export function validateClassifications(value: unknown): unknown {
  return ClassificationSchema.parse(value);
}
