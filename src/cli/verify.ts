import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertMoonbeam,
  closeSubstrate,
  connectSubstrate,
  extractXcDotSnapshot,
} from '../chain/substrate.js';
import { inspectXcDotAsset } from '../chain/metadata.js';
import { ManifestSchema } from '../schemas/index.js';
import { computeSnapshotDigest, sha256Hex } from '../snapshot/digest.js';
import { assertSupplyInvariant } from '../snapshot/invariants.js';
import {
  readHolders,
  readJsonFile,
  validateClassifications,
  validateVerification,
} from '../snapshot/io.js';
import { serializeHoldersNdjson } from '../snapshot/serialize.js';
import {
  BlockHashMismatchError,
  StateRootMismatchError,
  CanonicalSerializationError,
} from '../utils/errors.js';
import { rpcFromOptions, registerRpcOption } from './shared.js';
import type { SnapshotManifest } from '../types.js';

async function verifyFileHashes(snapshotDir: string): Promise<void> {
  const sums = await readFile(join(snapshotDir, 'SHA256SUMS'), 'utf8');
  for (const line of sums.split('\n')) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new CanonicalSerializationError(`Malformed SHA256SUMS line: ${line}`);
    const [, expected, file] = match;
    if (!file || !expected) throw new CanonicalSerializationError('Malformed SHA256SUMS entry.');
    const actual = sha256Hex(await readFile(join(snapshotDir, file)));
    if (actual !== expected) {
      throw new CanonicalSerializationError('Snapshot file hash mismatch.', {
        file,
        expected,
        actual,
      });
    }
  }
}

function assertManifestDigest(manifest: SnapshotManifest): void {
  const { snapshotDigest, ...withoutDigest } = manifest;
  void snapshotDigest;
  const actual = computeSnapshotDigest(withoutDigest);
  if (actual !== manifest.snapshotDigest) {
    throw new CanonicalSerializationError('Snapshot digest mismatch.', {
      expected: manifest.snapshotDigest,
      actual,
    });
  }
}

function assertSame(label: string, expected: string | number, actual: string | number): void {
  if (expected !== actual) {
    if (label === 'blockHash')
      throw new BlockHashMismatchError('Pinned block hash mismatch.', { expected, actual });
    if (label === 'stateRoot')
      throw new StateRootMismatchError('Pinned state root mismatch.', { expected, actual });
    throw new CanonicalSerializationError(`${label} mismatch.`, { expected, actual });
  }
}

export function verifyCommand(): Command {
  const command = new Command('verify').description(
    'Re-extract and independently verify a snapshot',
  );
  registerRpcOption(command);
  command.requiredOption('--snapshot <directory>', 'Snapshot directory');
  command.option('--page-size <size>', 'Storage enumeration page size', '500');
  command.action(async (options: { rpc?: string; snapshot: string; pageSize: string }) => {
    const snapshotDir = resolve(options.snapshot);
    const manifest = ManifestSchema.parse(await readJsonFile(join(snapshotDir, 'manifest.json')));
    await verifyFileHashes(snapshotDir);
    assertManifestDigest(manifest);
    validateVerification(await readJsonFile(join(snapshotDir, 'verification.json')));
    validateClassifications(await readJsonFile(join(snapshotDir, 'account-classification.json')));
    const { holders, raw } = await readHolders(snapshotDir);
    const canonicalRaw = serializeHoldersNdjson(holders);
    if (raw !== canonicalRaw) {
      throw new CanonicalSerializationError('holders.ndjson is not in canonical byte format.');
    }
    if (sha256Hex(raw) !== manifest.holders.sha256) {
      throw new CanonicalSerializationError('holders.ndjson SHA-256 mismatch.', {
        expected: manifest.holders.sha256,
        actual: sha256Hex(raw),
      });
    }
    if (holders.length !== manifest.holders.count) {
      throw new CanonicalSerializationError('Holder count mismatch.', {
        expected: manifest.holders.count,
        actual: holders.length,
      });
    }
    assertSupplyInvariant(holders, manifest.asset.totalSupplyPlanck);

    const api = await connectSubstrate(rpcFromOptions(options));
    try {
      await assertMoonbeam(api);
      const extraction = await extractXcDotSnapshot(
        api,
        manifest.snapshot.blockHash,
        Number(options.pageSize),
      );
      assertSame('genesisHash', manifest.chain.genesisHash, extraction.block.genesisHash);
      assertSame('blockNumber', manifest.snapshot.blockNumber, extraction.block.blockNumber);
      assertSame('blockHash', manifest.snapshot.blockHash, extraction.block.blockHash);
      assertSame('parentHash', manifest.snapshot.parentHash, extraction.block.parentHash);
      assertSame('stateRoot', manifest.snapshot.stateRoot, extraction.block.stateRoot);
      assertSame('specName', manifest.snapshot.specName, extraction.block.specName);
      assertSame('specVersion', manifest.snapshot.specVersion, extraction.block.specVersion);
      const expectedAsset = JSON.stringify(manifest.asset);
      const actualAsset = JSON.stringify(extraction.asset);
      assertSame('asset', expectedAsset, actualAsset);
      const actualRaw = serializeHoldersNdjson(extraction.holders);
      if (actualRaw !== raw) {
        throw new CanonicalSerializationError('Re-extracted holders.ndjson differs byte-for-byte.');
      }
      const asset = await inspectXcDotAsset(api, manifest.snapshot.blockHash);
      assertSame('assetSupply', manifest.asset.totalSupplyPlanck, asset.totalSupplyPlanck);
      console.log('SNAPSHOT_VERIFIED=PASS');
      console.log(`SNAPSHOT_DIGEST=${manifest.snapshotDigest}`);
    } finally {
      await closeSubstrate(api);
    }
  });
  return command;
}
