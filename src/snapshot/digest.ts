import { createHash } from 'node:crypto';
import type { SnapshotManifest } from '../types.js';
import { compareCanonicalStrings } from '../utils/order.js';

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function snapshotDigestPayload(manifest: Omit<SnapshotManifest, 'snapshotDigest'>): string {
  return (
    [
      'xcdot-recovery-kit/snapshot/v1',
      manifest.chain.genesisHash.toLowerCase(),
      manifest.snapshot.blockNumber,
      manifest.snapshot.blockHash.toLowerCase(),
      manifest.snapshot.stateRoot.toLowerCase(),
      manifest.asset.assetId,
      String(manifest.asset.decimals),
      manifest.asset.totalSupplyPlanck,
      String(manifest.holders.count),
      manifest.holders.sha256.toLowerCase(),
    ].join('\n') + '\n'
  );
}

export function computeSnapshotDigest(manifest: Omit<SnapshotManifest, 'snapshotDigest'>): string {
  return sha256Hex(snapshotDigestPayload(manifest));
}

export function fileSha256s(
  files: Readonly<Record<string, string | Uint8Array>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files)
      .sort(([a], [b]) => compareCanonicalStrings(a, b))
      .map(([name, contents]) => [name, sha256Hex(contents)]),
  );
}
