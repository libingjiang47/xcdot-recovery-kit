import {
  assertExpectedXcDotIdentity,
  deriveXc20Address,
  XC_DOT_ASSET_ID,
} from '../asset/constants.js';
import { AssetNotFoundError, AssetIdentityMismatchError } from '../utils/errors.js';
import type { AssetIdentity } from '../types.js';
import type { ApiPromise } from '@polkadot/api';

function codecToBigInt(value: unknown, label: string): bigint {
  const codec = value as { toBigInt?: () => bigint; toString?: () => string } | null;
  try {
    if (typeof codec?.toBigInt === 'function') return codec.toBigInt();
    if (typeof value === 'bigint') return value;
    return BigInt(codec?.toString?.() ?? 'invalid');
  } catch {
    throw new AssetIdentityMismatchError(`Runtime returned an invalid ${label}.`);
  }
}

function codecToNumber(value: unknown, label: string): number {
  const codec = value as { toNumber?: () => number; toString?: () => string } | null;
  const result =
    typeof codec?.toNumber === 'function' ? codec.toNumber() : Number(codec?.toString?.());
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AssetIdentityMismatchError(`Runtime returned an invalid ${label}.`);
  }
  return result;
}

function codecToText(value: unknown): string {
  const codec = value as { toUtf8?: () => string; toString?: () => string } | null;
  if (typeof codec?.toUtf8 === 'function') return codec.toUtf8();
  return codec?.toString?.() ?? '';
}

function codecToBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const codec = value as { isTrue?: boolean; toString?: () => string } | null;
  if (typeof codec?.isTrue === 'boolean') return codec.isTrue;
  return codec?.toString?.().toLowerCase() === 'true';
}

function unwrapOption(value: unknown, label: string): unknown {
  const option = value as { isNone?: boolean; unwrap?: () => unknown } | null;
  if (option?.isNone) throw new AssetNotFoundError(`${label} does not exist at the pinned block.`);
  if (typeof option?.unwrap === 'function') return option.unwrap();
  if (value == null) throw new AssetNotFoundError(`${label} does not exist at the pinned block.`);
  return value;
}

export async function inspectXcDotAsset(
  api: ApiPromise,
  blockHash: string,
): Promise<AssetIdentity> {
  const apiAt = await api.at(blockHash);
  const assets = (apiAt.query as any).assets as
    | {
        asset?: (assetId: bigint) => Promise<unknown>;
        metadata?: (assetId: bigint) => Promise<unknown>;
      }
    | undefined;
  if (!assets?.asset || !assets.metadata) {
    throw new AssetNotFoundError('The Assets pallet or required storage queries are unavailable.');
  }
  const details = unwrapOption(
    await assets.asset(XC_DOT_ASSET_ID),
    'xcDOT asset details',
  ) as Record<string, unknown>;
  const metadata = unwrapOption(
    await assets.metadata(XC_DOT_ASSET_ID),
    'xcDOT asset metadata',
  ) as Record<string, unknown>;
  const symbol = codecToText(metadata.symbol);
  const decimals = codecToNumber(metadata.decimals, 'asset decimals');
  assertExpectedXcDotIdentity(
    symbol,
    decimals,
    XC_DOT_ASSET_ID,
    deriveXc20Address(XC_DOT_ASSET_ID),
  );

  const totalSupplyPlanck = codecToBigInt(details.supply, 'asset supply').toString(10);
  const accountCount = codecToBigInt(details.accounts, 'asset account count').toString(10);
  const minimumBalancePlanck = codecToBigInt(details.minBalance, 'asset minimum balance').toString(
    10,
  );
  const isFrozen = details.isFrozen === undefined ? undefined : codecToBoolean(details.isFrozen);
  return {
    symbol,
    assetId: XC_DOT_ASSET_ID.toString(10),
    xc20Address: deriveXc20Address(XC_DOT_ASSET_ID),
    decimals,
    totalSupplyPlanck,
    accountCount,
    minimumBalancePlanck,
    ...(isFrozen === undefined ? {} : { isFrozen }),
  };
}
