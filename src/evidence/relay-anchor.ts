import type { ApiPromise } from '@polkadot/api';
import { EvidenceCaptureError } from '../utils/errors.js';

export interface RelayAnchorOptions {
  api: ApiPromise;
  blockHash: string;
  paraId: number;
}

/**
 * Relay anchoring is intentionally kept out of the Moonbeam evidence digest. The historical
 * Paras.Heads proof needs a dedicated relay-chain block search and proof artifact; callers must
 * not substitute a current relay head or a non-proof RPC response.
 */
export async function captureRelayAnchor(_options: RelayAnchorOptions): Promise<never> {
  throw new EvidenceCaptureError(
    'Historical relay anchor capture is not enabled; no current relay head may be substituted.',
  );
}
