import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlockIdentity, HolderRecord, AssetIdentity } from '../types.js';
import { sha256Hex } from '../snapshot/digest.js';
import { compareCanonicalStrings } from '../utils/order.js';
import type { EvidenceCore, EvidenceManifest } from './types.js';

export function makeEvidenceCore(
  block: BlockIdentity,
  asset: AssetIdentity,
  assetDetails: unknown,
  metadata: unknown,
  holders: HolderRecord[],
  storageRecordCount: number,
): EvidenceCore {
  return { schemaVersion: 1, block, asset, assetDetails, metadata, holders, storageRecordCount };
}

export function evidenceManifestWithoutDigest(
  input: Omit<EvidenceManifest, 'evidenceDigest'>,
): string {
  return JSON.stringify(input, null, 2) + '\n';
}

export function computeEvidenceDigest(canonicalFilesText: string): string {
  return sha256Hex(canonicalFilesText);
}

export async function writeProofIndex(workDir: string, index: string): Promise<string> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(workDir, 'proofs/index.ndjson'), index, { encoding: 'utf8' });
  return sha256Hex(index);
}

export async function readCanonicalSums(workDir: string): Promise<string> {
  return readFile(join(workDir, 'canonical-files.sha256'), 'utf8');
}

export function canonicalHashLines(files: Record<string, string>): string {
  return (
    Object.entries(files)
      .sort(([a], [b]) => compareCanonicalStrings(a, b))
      .map(([file, content]) => `${sha256Hex(content)}  ${file}`)
      .join('\n') + '\n'
  );
}
