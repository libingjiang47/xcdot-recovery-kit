import { readdir, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { sha256Hex } from '../snapshot/digest.js';
import { writeJson, writeText, pathExists } from '../snapshot/io.js';
import { compareCanonicalStrings } from '../utils/order.js';
import { CanonicalSerializationError } from '../utils/errors.js';
import {
  serializeHoldersCsv,
  serializeHoldersJson,
  serializeHoldersNdjson,
} from '../snapshot/serialize.js';
import type { EvidenceCore, EvidenceManifest, EvidenceStorageRecord } from './types.js';

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result.push(relative(root, path).split('\\').join('/'));
    }
  }
  await visit(root);
  return result.sort(compareCanonicalStrings);
}

function canonicalEvidenceFile(path: string): boolean {
  return (
    path !== 'canonical-files.sha256' &&
    path !== 'evidence-manifest.json' &&
    path !== 'provenance.json' &&
    path !== 'SHA256SUMS' &&
    !path.startsWith('verification/') &&
    !path.startsWith('relay-anchor/')
  );
}

async function canonicalFileList(root: string): Promise<string[]> {
  return (await filesUnder(root)).filter(canonicalEvidenceFile);
}

export async function makeCanonicalSums(root: string): Promise<{ text: string; files: string[] }> {
  const files = await canonicalFileList(root);
  const lines: string[] = [];
  for (const file of files) lines.push(`${sha256Hex(await readFile(join(root, file)))}  ${file}`);
  const text = lines.join('\n') + (lines.length ? '\n' : '');
  return { text, files };
}

export async function makeEvidenceWorkDir(
  outDir: string,
  id: string,
  resume: boolean,
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const work = join(resolve(outDir), `.work-${id}`);
  if (resume) {
    await mkdir(work, { recursive: true });
    return work;
  }
  if (await pathExists(work)) {
    throw new CanonicalSerializationError(
      `Evidence work directory already exists; use --resume or remove it manually: ${work}`,
    );
  }
  return mkdtemp(join(resolve(outDir), '.tmp-evidence-'));
}

export async function prepareEvidenceDirectories(workDir: string): Promise<void> {
  await Promise.all([
    mkdir(join(workDir, 'header'), { recursive: true }),
    mkdir(join(workDir, 'state'), { recursive: true }),
    mkdir(join(workDir, 'proofs'), { recursive: true }),
    mkdir(join(workDir, 'runtime'), { recursive: true }),
  ]);
}

export async function finalizeEvidenceBundle(
  workDir: string,
  targetDir: string,
  manifest: EvidenceManifest,
  force: boolean,
): Promise<void> {
  const sums = await makeCanonicalSums(workDir);
  await writeText(join(workDir, 'canonical-files.sha256'), sums.text);
  const evidenceDigest = sha256Hex(sums.text);
  if (evidenceDigest !== manifest.evidenceDigest) {
    throw new CanonicalSerializationError('Evidence digest changed while finalizing the bundle.', {
      expected: manifest.evidenceDigest,
      actual: evidenceDigest,
    });
  }
  await writeJson(join(workDir, 'evidence-manifest.json'), manifest);
  const allFiles = (await filesUnder(workDir)).filter((file) => file !== 'SHA256SUMS');
  const sumLines: string[] = [];
  for (const file of allFiles) {
    sumLines.push(`${sha256Hex(await readFile(join(workDir, file)))}  ${file}`);
  }
  await writeText(join(workDir, 'SHA256SUMS'), sumLines.join('\n') + (sumLines.length ? '\n' : ''));
  if (await pathExists(targetDir)) {
    if (!force)
      throw new CanonicalSerializationError(`Evidence directory already exists: ${targetDir}`);
    await rm(targetDir, { recursive: true, force: true });
  }
  await rename(workDir, targetDir);
}

export async function cleanupEvidenceWorkDir(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
}

export async function writeEvidenceCanonicalState(
  workDir: string,
  storageText: string,
  holders: Parameters<typeof serializeHoldersNdjson>[0],
  holdersCsvDecimals: number,
  core: EvidenceCore,
): Promise<{ holdersText: string; storageSha256: string; holdersSha256: string }> {
  const holdersText = serializeHoldersNdjson(holders);
  await writeText(join(workDir, 'state/storage.ndjson'), storageText);
  await writeText(join(workDir, 'state/holders.ndjson'), holdersText);
  await writeText(join(workDir, 'state/holders.json'), serializeHoldersJson(holders));
  await writeText(
    join(workDir, 'state/holders.csv'),
    serializeHoldersCsv(holders, holdersCsvDecimals),
  );
  await writeJson(join(workDir, 'evidence-core.json'), core);
  return {
    holdersText,
    storageSha256: sha256Hex(storageText),
    holdersSha256: sha256Hex(holdersText),
  };
}

export function storageRecordsToKeys(records: readonly EvidenceStorageRecord[]): string[] {
  return records.map((record) => record.key).sort(compareCanonicalStrings);
}
