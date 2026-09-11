import { describe, expect, it } from 'vitest';
import { decodeStorageEntry } from '../../src/asset/decode.js';
import fixture from '../fixtures/storage-accounts.json';

const assetId = 42259045809535163221576417993425387648n;
const codec = (hex: string) => ({ toHex: () => hex });
const numberCodec = (value: string) => ({ toBigInt: () => BigInt(value) });

describe('Assets.Account decoding fixture', () => {
  it('decodes mixed-case H160, large u128, and zero-balance records', () => {
    const record = fixture[0]!;
    const key = {
      args: [numberCodec(assetId.toString()), codec(record.address)],
      toHex: () => '0x01',
    };
    const decoded = decodeStorageEntry(
      key,
      { balance: numberCodec(record.balancePlanck) },
      assetId,
    );
    expect(decoded).toEqual({
      address: '0xaa00000000000000000000000000000000000001',
      balancePlanck: '340282366920938463463374607431768211455',
    });
  });

  it('fails closed on a wrong asset key', () => {
    const key = {
      args: [numberCodec('1'), codec(fixture[1]!.address)],
      toHex: () => '0x02',
    };
    expect(() => decodeStorageEntry(key, { balance: numberCodec('1') }, assetId)).toThrow(
      /unexpected asset/i,
    );
  });
});
