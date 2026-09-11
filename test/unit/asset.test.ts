import { describe, expect, it } from 'vitest';
import {
  XC_DOT_ASSET_ID,
  XC_DOT_ASSET_ID_HEX,
  XC_DOT_XC20_ADDRESS,
  deriveXc20Address,
} from '../../src/asset/constants.js';
import { isH160, normalizeH160 } from '../../src/asset/xc20.js';
import { formatDot } from '../../src/utils/numbers.js';

describe('xcDOT identity and integer formatting', () => {
  it('derives the configured XC-20 address from the u128 asset ID', () => {
    expect(XC_DOT_ASSET_ID_HEX).toBe('1fcacbd218edc0eba20fc2308c778080');
    expect(deriveXc20Address(XC_DOT_ASSET_ID)).toBe(XC_DOT_XC20_ADDRESS);
    expect(XC_DOT_XC20_ADDRESS).toBe('0xffffffff1fcacbd218edc0eba20fc2308c778080');
  });

  it('normalizes valid H160 values and rejects invalid values', () => {
    expect(normalizeH160('0xAa00000000000000000000000000000000000001')).toBe(
      '0xaa00000000000000000000000000000000000001',
    );
    expect(isH160('0x1234')).toBe(false);
    expect(() => normalizeH160('0x1234')).toThrow();
    expect(() => normalizeH160('aa00000000000000000000000000000000000001')).toThrow();
  });

  it('formats planck without floating point', () => {
    expect(formatDot(10000000000n)).toBe('1.0000000000');
    expect(formatDot(123456789012n)).toBe('12.3456789012');
    expect(formatDot(1n)).toBe('0.0000000001');
  });
});
