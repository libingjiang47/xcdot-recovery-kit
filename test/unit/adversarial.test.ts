import { describe, expect, it } from 'vitest';
import {
  assertExpectedXcDotIdentity,
  deriveXc20Address,
  XC_DOT_XC20_ADDRESS,
} from '../../src/asset/constants.js';
import { canonicalizeHolders } from '../../src/snapshot/canonicalize.js';
import { verifyEvmSnapshot } from '../../src/verification/evm.js';
import type { PublicClient } from 'viem';
import type { SnapshotManifest } from '../../src/types.js';

describe('adversarial validation', () => {
  it('rejects non-integer balances, invalid addresses, and u128 overflow', () => {
    expect(() =>
      canonicalizeHolders([
        { address: '0xaa00000000000000000000000000000000000001', balancePlanck: '1.5' },
      ]),
    ).toThrow();
    expect(() =>
      canonicalizeHolders([{ address: '0xnot-an-address', balancePlanck: '1' }]),
    ).toThrow();
    expect(() => deriveXc20Address(2n ** 128n)).toThrow();
  });

  it('fails closed on any xcDOT identity mismatch', () => {
    expect(() =>
      assertExpectedXcDotIdentity(
        'DOT',
        10,
        '42259045809535163221576417993425387648',
        XC_DOT_XC20_ADDRESS,
      ),
    ).toThrow();
    expect(() =>
      assertExpectedXcDotIdentity(
        'xcDOT',
        9,
        '42259045809535163221576417993425387648',
        XC_DOT_XC20_ADDRESS,
      ),
    ).toThrow();
    expect(() =>
      assertExpectedXcDotIdentity(
        'xcDOT',
        10,
        '42259045809535163221576417993425387648',
        '0x0000000000000000000000000000000000000000',
      ),
    ).toThrow();
  });

  it('reports EVM holder mismatches without coercing balances', async () => {
    const hash = ('0x' + '11'.repeat(32)) as `0x${string}`;
    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      tool: 'xcdot-recovery-kit',
      chain: { name: 'Moonbeam', paraId: 2004, genesisHash: '0x' + '00'.repeat(32) },
      snapshot: {
        blockNumber: '42',
        blockHash: hash,
        parentHash: '0x' + '22'.repeat(32),
        stateRoot: '0x' + '33'.repeat(32),
        specName: 'moonbeam',
        specVersion: 1,
      },
      asset: {
        symbol: 'xcDOT',
        assetId: '42259045809535163221576417993425387648',
        xc20Address: XC_DOT_XC20_ADDRESS,
        decimals: 10,
        totalSupplyPlanck: '100',
        accountCount: '1',
        minimumBalancePlanck: '1',
      },
      holders: { count: 1, totalBalancePlanck: '100', sha256: '00'.repeat(32) },
      snapshotDigest: '00'.repeat(32),
    };
    const client = {
      getBlock: async () => ({ hash }),
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'symbol') return 'xcDOT';
        if (functionName === 'decimals') return 10;
        if (functionName === 'totalSupply') return 100n;
        return 99n;
      },
      getCode: async () => '0x',
    } as unknown as PublicClient;
    const output = await verifyEvmSnapshot(
      client,
      manifest,
      [{ address: '0xaa00000000000000000000000000000000000001', balancePlanck: '100' }],
      1,
    );
    expect(output.verification.status).toBe('FAIL');
    expect(output.verification.holderBalanceMismatches).toEqual([
      {
        address: '0xaa00000000000000000000000000000000000001',
        expected: '100',
        actual: '99',
      },
    ]);
    expect(output.classifications[0]?.codeStatus).toBe('no_code');
  });
});
