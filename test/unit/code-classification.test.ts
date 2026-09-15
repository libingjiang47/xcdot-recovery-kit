import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_MOONBEAM_PRECOMPILES } from '../../src/final-state/constants.js';
import { classifyHolderAccounts } from '../../src/verification/code.js';
import type { HolderRecord } from '../../src/types.js';

const blockNumber = 16796696n;
const precompile = '0x0000000000000000000000000000000000000800';
const codeAddress = '0xaa00000000000000000000000000000000000001';
const emptyAddress = '0xaa00000000000000000000000000000000000002';
const failingAddress = '0xaa00000000000000000000000000000000000003';

function holder(address: string): HolderRecord {
  return { address, balancePlanck: '1' };
}

describe('terminal account classification', () => {
  it('classifies active precompiles as system without an RPC code lookup', async () => {
    expect(TERMINAL_MOONBEAM_PRECOMPILES.has(precompile)).toBe(true);
    const getCode = vi.fn();
    const [result] = await classifyHolderAccounts(
      { getCode },
      [holder(precompile)],
      blockNumber,
      1,
      { retries: 1 },
    );

    expect(result).toMatchObject({
      address: precompile,
      codeStatus: 'system_precompile',
      classification: 'system-precompile',
    });
    expect(getCode).not.toHaveBeenCalled();
  });

  it('classifies non-empty code as a contract', async () => {
    const [result] = await classifyHolderAccounts(
      { getCode: vi.fn().mockResolvedValue('0x600160') },
      [holder(codeAddress)],
      blockNumber,
      1,
      { retries: 1 },
    );

    expect(result).toMatchObject({
      address: codeAddress,
      codeStatus: 'has_code',
      classification: 'code-present',
      codeSize: 3,
    });
    expect(result?.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('classifies empty code as an EOA', async () => {
    const [result] = await classifyHolderAccounts(
      { getCode: vi.fn().mockResolvedValue('0x') },
      [holder(emptyAddress)],
      blockNumber,
      1,
      { retries: 1 },
    );

    expect(result).toMatchObject({
      address: emptyAddress,
      codeStatus: 'no_code',
      classification: 'no-code',
      codeSize: 0,
    });
  });

  it('records a final RPC failure as unknown', async () => {
    const errors: Array<{
      address: string;
      attempt: number;
      errorType: string;
      message: string;
    }> = [];
    const [result] = await classifyHolderAccounts(
      { getCode: vi.fn().mockRejectedValue(new Error('historical RPC unavailable')) },
      [holder(failingAddress)],
      blockNumber,
      1,
      {
        retries: 1,
        onError: (error) => errors.push(error),
      },
    );

    expect(result).toMatchObject({
      address: failingAddress,
      codeStatus: 'unknown',
      classification: 'unknown',
    });
    expect(errors).toEqual([
      {
        address: failingAddress,
        attempt: 1,
        errorType: 'Error',
        message: 'historical RPC unavailable',
      },
    ]);
  });
});
