import { z } from 'zod';

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const unsigned = z.string().regex(/^(0|[1-9][0-9]*)$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);

export const HolderSchema = z
  .object({
    address,
    balancePlanck: unsigned,
  })
  .strict();

export const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    tool: z.literal('xcdot-recovery-kit'),
    chain: z
      .object({
        name: z.literal('Moonbeam'),
        paraId: z.literal(2004),
        genesisHash: hash,
      })
      .strict(),
    snapshot: z
      .object({
        blockNumber: unsigned,
        blockHash: hash,
        parentHash: hash,
        stateRoot: hash,
        specName: z.string().min(1),
        specVersion: z.number().int().nonnegative(),
      })
      .strict(),
    asset: z
      .object({
        symbol: z.literal('xcDOT'),
        assetId: unsigned,
        xc20Address: address,
        decimals: z.literal(10),
        totalSupplyPlanck: unsigned,
        accountCount: unsigned,
        minimumBalancePlanck: unsigned,
        isFrozen: z.boolean().optional(),
      })
      .strict(),
    holders: z
      .object({
        count: z.number().int().nonnegative(),
        totalBalancePlanck: unsigned,
        sha256: digest,
      })
      .strict(),
    snapshotDigest: digest,
  })
  .strict();

export const VerificationSchema = z
  .object({
    substrateSupplyMatchesHolderSum: z.boolean(),
    evmSupplyMatchesSubstrateSupply: z.boolean(),
    holderBalancesChecked: z.number().int().nonnegative(),
    holderBalanceMismatches: z.array(
      z
        .object({
          address,
          expected: unsigned,
          actual: unsigned,
        })
        .strict(),
    ),
    errors: z.array(z.string()).optional(),
    status: z.enum(['PASS', 'FAIL', 'NOT_RUN']),
  })
  .strict();

export type ManifestInput = z.infer<typeof ManifestSchema>;
