import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiPromise } from '@polkadot/api';
import { batchFileName, partition, validateBatchSize } from './batching.js';
import type { EvidenceProofBatch } from './types.js';
import { EvidenceCaptureError } from '../utils/errors.js';
import { sha256Hex } from '../snapshot/digest.js';
import { writeJson, pathExists } from '../snapshot/io.js';
import { compareCanonicalStrings } from '../utils/order.js';

function hex(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value : (value as { toHex?: () => string })?.toHex?.();
  if (!text || !/^0x[0-9a-fA-F]*$/.test(text) || text.length % 2 !== 0) {
    throw new EvidenceCaptureError(`RPC returned malformed ${label}.`);
  }
  return text.toLowerCase();
}

function responseProof(response: unknown): string[] {
  const proof = (response as { proof?: unknown } | null)?.proof;
  if (!Array.isArray(proof))
    throw new EvidenceCaptureError('state_getReadProof returned no proof array.');
  return proof.map((node, index) => hex(node, `proof node ${index}`));
}

function responseAt(response: unknown): string {
  return hex((response as { at?: unknown } | null)?.at, 'proof state hash');
}

async function proofRetry<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      if (attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw new EvidenceCaptureError(`Proof RPC failed after five attempts: ${String(last)}`);
}

async function readExistingBatch(
  path: string,
  expected: EvidenceProofBatch,
  indexPath: string,
): Promise<boolean> {
  if (!(await pathExists(path))) return false;
  try {
    const raw = await readFile(path, 'utf8');
    const actual = JSON.parse(raw) as Partial<EvidenceProofBatch>;
    const index = await readFile(indexPath, 'utf8');
    const indexLine = index
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { file?: string; sha256?: string })
      .find((entry) => entry.file === path.split('/').at(-1));
    return (
      indexLine?.sha256 === sha256Hex(raw) &&
      actual.schemaVersion === expected.schemaVersion &&
      actual.blockHash === expected.blockHash &&
      actual.stateRoot === expected.stateRoot &&
      actual.batchIndex === expected.batchIndex &&
      JSON.stringify(actual.keys) === JSON.stringify(expected.keys) &&
      Array.isArray(actual.proof) &&
      actual.proof.every((node) => typeof node === 'string' && /^0x[0-9a-f]+$/.test(node)) &&
      actual.proof.length > 0
    );
  } catch {
    return false;
  }
}

export async function captureProofBatches(
  api: ApiPromise,
  keys: readonly string[],
  blockHash: string,
  stateRoot: string,
  batchSize: number,
  proofsDir: string,
  resume: boolean,
): Promise<{ batches: EvidenceProofBatch[]; index: string }> {
  validateBatchSize(batchSize);
  const sortedKeys = [...keys].sort(compareCanonicalStrings);
  const batches = partition(sortedKeys, batchSize);
  const output: EvidenceProofBatch[] = [];
  for (const [batchIndex, batchKeys] of batches.entries()) {
    const path = join(proofsDir, batchFileName(batchIndex));
    const prefix: EvidenceProofBatch = {
      schemaVersion: 1,
      blockHash: blockHash.toLowerCase(),
      stateRoot: stateRoot.toLowerCase(),
      batchIndex,
      keys: batchKeys,
      proof: [],
    };
    let batch: EvidenceProofBatch;
    if (resume && (await pathExists(path))) {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as EvidenceProofBatch;
      if (!(await readExistingBatch(path, prefix, join(proofsDir, 'index.ndjson')))) {
        throw new EvidenceCaptureError(
          `Cannot resume invalid proof batch ${batchFileName(batchIndex)}.`,
        );
      }
      if (
        parsed.blockHash !== prefix.blockHash ||
        parsed.stateRoot !== prefix.stateRoot ||
        JSON.stringify(parsed.keys) !== JSON.stringify(prefix.keys)
      ) {
        throw new EvidenceCaptureError(
          `Cannot resume proof batch for a different pinned state: ${path}`,
        );
      }
      batch = parsed;
    } else {
      const response = await proofRetry(() => api.rpc.state.getReadProof(batchKeys, blockHash));
      if (responseAt(response) !== blockHash.toLowerCase()) {
        throw new EvidenceCaptureError(
          'RPC returned a proof for a state other than the pinned block.',
          {
            expected: blockHash,
            actual: responseAt(response),
          },
        );
      }
      batch = { ...prefix, proof: responseProof(response) };
      await writeJson(path, batch);
    }
    output.push(batch);
  }
  const index =
    output
      .map((batch) => {
        const firstKey = batch.keys[0] ?? '';
        const lastKey = batch.keys.at(-1) ?? '';
        const file = batchFileName(batch.batchIndex);
        return JSON.stringify({
          batch: batch.batchIndex,
          file,
          firstKey,
          lastKey,
          keyCount: batch.keys.length,
          sha256: sha256Hex(JSON.stringify(batch, null, 2) + '\n'),
        });
      })
      .join('\n') + (output.length ? '\n' : '');
  return { batches: output, index };
}
