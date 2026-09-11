import { describe, expect, it } from 'vitest';
import { HolderSchema, ManifestSchema } from '../../src/schemas/index.js';

describe('schemas', () => {
  it('accepts canonical holders and rejects decimal balances', () => {
    expect(
      HolderSchema.parse({
        address: '0xaa00000000000000000000000000000000000001',
        balancePlanck: '1',
      }),
    ).toEqual({ address: '0xaa00000000000000000000000000000000000001', balancePlanck: '1' });
    expect(() =>
      HolderSchema.parse({
        address: '0xaa00000000000000000000000000000000000001',
        balancePlanck: '1.5',
      }),
    ).toThrow();
  });

  it('rejects an invalid manifest identity', () => {
    expect(() => ManifestSchema.parse({ schemaVersion: 1 })).toThrow();
  });
});
