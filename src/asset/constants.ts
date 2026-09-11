import { AssetIdentityMismatchError } from '../utils/errors.js';

export const NETWORK_NAME = 'Moonbeam' as const;
export const PARA_ID = 2004 as const;
export const MOONBEAM_GENESIS_HASH =
  '0xfe58ea77779b7abda7da4ec526d14db9b1e9cd40a217c34892af80a9b332b76d' as const;
export const XC_DOT_ASSET_ID = 42259045809535163221576417993425387648n;
export const XC_DOT_ASSET_ID_DECIMAL = XC_DOT_ASSET_ID.toString(10);
export const XC_DOT_ASSET_ID_HEX = XC_DOT_ASSET_ID.toString(16).padStart(32, '0');
export const XC_DOT_SYMBOL = 'xcDOT' as const;
export const XC_DOT_DECIMALS = 10 as const;
export const XC20_PREFIX = '0xffffffff' as const;
export const XC_DOT_XC20_ADDRESS = `${XC20_PREFIX}${XC_DOT_ASSET_ID_HEX}` as const;

export function deriveXc20Address(assetId: bigint | string): string {
  const value = typeof assetId === 'bigint' ? assetId : parseUnsignedBigInt(assetId, 'asset ID');
  if (value < 0n || value > 0xffffffffffffffffffffffffffffffffn) {
    throw new AssetIdentityMismatchError('Asset ID is outside the u128 range.', {
      assetId: String(assetId),
    });
  }
  return `${XC20_PREFIX}${value.toString(16).padStart(32, '0')}`;
}

export function parseUnsignedBigInt(value: string | bigint, label: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new AssetIdentityMismatchError(`${label} must be unsigned.`);
    return value;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new AssetIdentityMismatchError(`${label} must be an unsigned decimal integer.`, {
      value,
    });
  }
  return BigInt(value);
}

export function assertExpectedXcDotIdentity(
  symbol: string,
  decimals: number,
  assetId: bigint | string,
  xc20Address: string,
): void {
  const normalizedAddress = xc20Address.toLowerCase();
  const expectedAddress = deriveXc20Address(assetId);
  if (assetId.toString() !== XC_DOT_ASSET_ID_DECIMAL) {
    throw new AssetIdentityMismatchError('Unexpected xcDOT asset ID.', {
      expected: XC_DOT_ASSET_ID_DECIMAL,
      actual: assetId.toString(),
    });
  }
  if (symbol !== XC_DOT_SYMBOL) {
    throw new AssetIdentityMismatchError('Unexpected xcDOT symbol.', {
      expected: XC_DOT_SYMBOL,
      actual: symbol,
    });
  }
  if (decimals !== XC_DOT_DECIMALS) {
    throw new AssetIdentityMismatchError('Unexpected xcDOT decimals.', {
      expected: XC_DOT_DECIMALS,
      actual: decimals,
    });
  }
  if (normalizedAddress !== expectedAddress) {
    throw new AssetIdentityMismatchError('Unexpected derived xcDOT XC-20 address.', {
      expected: expectedAddress,
      actual: normalizedAddress,
    });
  }
  if (!/^0x[0-9a-f]{40}$/.test(normalizedAddress)) {
    throw new AssetIdentityMismatchError('XC-20 address is not a canonical H160.', {
      actual: xc20Address,
    });
  }
}
