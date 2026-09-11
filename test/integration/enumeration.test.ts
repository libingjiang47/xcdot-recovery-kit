import { describe, expect, it } from 'vitest';
import { enumerateXcDotAccounts } from '../../src/chain/substrate.js';
import { XC_DOT_ASSET_ID } from '../../src/asset/constants.js';
import type { ApiPromise } from '@polkadot/api';

function key(address: string, marker: string) {
  return {
    args: [{ toBigInt: () => XC_DOT_ASSET_ID }, { toHex: () => address }],
    toHex: () => marker,
  };
}

function value(balance: string) {
  return { balance: { toBigInt: () => BigInt(balance) } };
}

function mockApi(pages: Array<Array<[ReturnType<typeof key>, ReturnType<typeof value>]>>) {
  let calls = 0;
  return {
    at: async () => ({
      query: {
        assets: {
          account: {
            entriesPaged: async () => pages[calls++] ?? [],
          },
        },
      },
    }),
  } as unknown as ApiPromise;
}

describe('paged Assets.Account traversal', () => {
  it('accepts multiple deterministic pages and preserves decoded input', async () => {
    const api = mockApi([
      [[key('0x0000000000000000000000000000000000000001', '0x01'), value('10')]],
      [[key('0x0000000000000000000000000000000000000002', '0x02'), value('20')]],
      [],
    ]);
    await expect(enumerateXcDotAccounts(api, '0x' + '11'.repeat(32), 1)).resolves.toEqual([
      {
        address: '0x0000000000000000000000000000000000000001',
        balancePlanck: '10',
      },
      {
        address: '0x0000000000000000000000000000000000000002',
        balancePlanck: '20',
      },
    ]);
  });

  it('fails on a repeated storage page', async () => {
    const repeated = key('0x0000000000000000000000000000000000000001', '0x01');
    const api = mockApi([[[repeated, value('10')]], [[repeated, value('10')]]]);
    await expect(enumerateXcDotAccounts(api, '0x' + '11'.repeat(32), 1)).rejects.toThrow(
      /repeated/i,
    );
  });
});
