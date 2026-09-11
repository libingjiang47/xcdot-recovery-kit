import { describe, expect, it } from 'vitest';
import { canonicalizeHolders, sumBalances } from '../../src/snapshot/canonicalize.js';
import { serializeHoldersNdjson } from '../../src/snapshot/serialize.js';
import { sha256Hex, computeSnapshotDigest } from '../../src/snapshot/digest.js';
import { assertSupplyInvariant } from '../../src/snapshot/invariants.js';
import type { HolderRecord } from '../../src/types.js';

const input: HolderRecord[] = [
  { address: '0xbb00000000000000000000000000000000000002', balancePlanck: '10000000000' },
  { address: '0xcc00000000000000000000000000000000000003', balancePlanck: '0' },
  { address: '0xAa00000000000000000000000000000000000001', balancePlanck: '25' },
];

describe('canonical holder artifact', () => {
  it('is independent of enumeration ordering and omits zero balances', () => {
    const outputs = [
      input,
      [input[2]!, input[0]!, input[1]!],
      [input[1]!, input[2]!, input[0]!],
    ].map((entries) => serializeHoldersNdjson(canonicalizeHolders(entries)));
    expect(new Set(outputs).size).toBe(1);
    expect(outputs[0]).toBe(
      '{"address":"0xaa00000000000000000000000000000000000001","balancePlanck":"25"}\n' +
        '{"address":"0xbb00000000000000000000000000000000000002","balancePlanck":"10000000000"}\n',
    );
  });

  it('rejects duplicate accounts and supply mismatch', () => {
    expect(() => canonicalizeHolders([input[0]!, input[0]!])).toThrow(/same holder/i);
    expect(() => assertSupplyInvariant(canonicalizeHolders(input), '1')).toThrow(/sum/i);
    expect(sumBalances(canonicalizeHolders(input))).toBe(10000000025n);
  });

  it('calculates the documented snapshot digest test vector', () => {
    const genesisHash = '0x' + '00'.repeat(32);
    const blockHash = '0x' + '11'.repeat(32);
    const stateRoot = '0x' + '22'.repeat(32);
    const holdersSha256 = '33'.repeat(32);
    const base = {
      schemaVersion: 1 as const,
      tool: 'xcdot-recovery-kit' as const,
      chain: { name: 'Moonbeam' as const, paraId: 2004 as const, genesisHash },
      snapshot: {
        blockNumber: '42',
        blockHash,
        parentHash: '0x' + '44'.repeat(32),
        stateRoot,
        specName: 'moonbeam',
        specVersion: 1,
      },
      asset: {
        symbol: 'xcDOT' as const,
        assetId: '42259045809535163221576417993425387648',
        xc20Address: '0xffffffff1fcacbd218edc0eba20fc2308c778080',
        decimals: 10 as const,
        totalSupplyPlanck: '30000000000',
        accountCount: '2',
        minimumBalancePlanck: '1',
      },
      holders: { count: 2, totalBalancePlanck: '30000000000', sha256: holdersSha256 },
    };
    expect(computeSnapshotDigest(base)).toBe(
      '50f8c5ff511c1ad7b309c5b7dab5eb2b89f38e3bda6c05f805f2832753656d03',
    );
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
