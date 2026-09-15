import { describe, expect, it } from 'vitest';
import { formatPercent, formatUnits } from '../../src/release/format.js';
import {
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
  EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
} from '../../src/final-state/constants.js';

describe('frozen terminal release arithmetic', () => {
  it('formats planck values without floating point conversion', () => {
    expect(formatUnits(2_334_516_727_484_230n, 10)).toBe('233451.672748423');
    expect(formatUnits(2_334_506_800_114_108n, 10)).toBe('233450.6800114108');
    expect(formatUnits(9_927_370_122n, 10)).toBe('0.9927370122');
  });

  it('formats deterministic integer percentages', () => {
    expect(formatPercent(2_334_506_800_114_108n, 2_334_516_727_484_230n)).toBe('99.9995747');
  });

  it('locks the release state and supply constants', () => {
    expect(MOONBEAM_FINAL_BLOCK_NUMBER).toBe('16796696');
    expect(MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH).toBe(
      '0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f',
    );
    expect(MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT).toBe(
      '0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb',
    );
    expect(EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK).toBe('2334516727484230');
  });
});
