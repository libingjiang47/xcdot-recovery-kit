import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertExpectedMoonbeamGenesis,
  assertMoonbeam,
  closeSubstrate,
  connectSubstrate,
  resolveBlock,
} from '../chain/substrate.js';
import { XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import {
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
} from '../final-state/constants.js';
import { FinalStateStorageBackendUnsupportedError } from '../utils/errors.js';
import {
  deriveMappingStorageSlot,
  parseVerifiedStorageLayout,
  type VerifiedStorageLayout,
} from './solidity.js';
import {
  accountStoragesMetadataSummary,
  deriveAccountStoragesKey,
  deriveTotalSupplyAccountStoragesKey,
} from './substrate-evm.js';

export interface EvmStorageLayoutInspection {
  schemaVersion: 1;
  status: 'LAYOUT_VERIFIED' | 'LAYOUT_REQUIRED';
  block: {
    number: string;
    hash: string;
    stateRoot: string;
    specName: string;
    specVersion: number;
    stateVersion: number;
  };
  accountStorages: ReturnType<typeof accountStoragesMetadataSummary>;
  contract: string;
  layout?: {
    compiler: VerifiedStorageLayout['compiler'];
    sources: Record<string, string>;
    balancesSlot: string;
    totalSupplySlot: string;
    zeroBalanceStorageSlot: string;
    totalSupplyStorageKey: string;
    zeroBalanceStorageKey: string;
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

export interface InspectEvmStorageLayoutOptions {
  substrateRpc: string;
  blockHash: string;
  layout?: string;
  out?: string;
}

export async function inspectEvmStorageLayout(
  options: InspectEvmStorageLayoutOptions,
): Promise<EvmStorageLayoutInspection> {
  const api = await connectSubstrate(options.substrateRpc);
  try {
    await assertMoonbeam(api);
    const block = await resolveBlock(api, options.blockHash);
    assertExpectedMoonbeamGenesis(block.genesisHash);
    const apiAt = await api.at(block.blockHash);
    const accountStorages = accountStoragesMetadataSummary(apiAt);
    let verifiedLayout: VerifiedStorageLayout | undefined;
    if (options.layout !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(resolve(options.layout), 'utf8')) as unknown;
      } catch (error) {
        throw new FinalStateStorageBackendUnsupportedError(
          'Could not read the supplied storage layout artifact.',
          {
            layout: resolve(options.layout),
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      verifiedLayout = parseVerifiedStorageLayout(raw);
    }
    const base: EvmStorageLayoutInspection = {
      schemaVersion: 1,
      status: verifiedLayout === undefined ? 'LAYOUT_REQUIRED' : 'LAYOUT_VERIFIED',
      block: {
        number: block.blockNumber,
        hash: block.blockHash,
        stateRoot: block.stateRoot,
        specName: block.specName,
        specVersion: block.specVersion,
        stateVersion: block.stateVersion,
      },
      accountStorages,
      contract: XC_DOT_XC20_ADDRESS,
    };
    const report =
      verifiedLayout === undefined
        ? base
        : {
            ...base,
            layout: {
              compiler: verifiedLayout.compiler,
              sources: verifiedLayout.sources,
              balancesSlot: verifiedLayout.balancesSlot.toString(10),
              totalSupplySlot: verifiedLayout.totalSupplySlot.toString(10),
              zeroBalanceStorageSlot: deriveMappingStorageSlot(
                '0x0000000000000000000000000000000000000000',
                verifiedLayout.balancesSlot,
              ),
              totalSupplyStorageKey: deriveTotalSupplyAccountStoragesKey(
                apiAt,
                XC_DOT_XC20_ADDRESS,
                verifiedLayout.totalSupplySlot,
              ).substrateStorageKey,
              zeroBalanceStorageKey: deriveAccountStoragesKey(
                apiAt,
                XC_DOT_XC20_ADDRESS,
                deriveMappingStorageSlot(
                  '0x0000000000000000000000000000000000000000',
                  verifiedLayout.balancesSlot,
                ),
              ),
            },
          };
    if (options.out !== undefined) {
      const out = resolve(options.out);
      await mkdir(out, { recursive: true });
      await writeFile(join(out, 'inspection.json'), json(report), 'utf8');
      if (options.layout !== undefined) {
        await writeFile(
          join(out, 'layout.json'),
          await readFile(resolve(options.layout), 'utf8'),
          'utf8',
        );
      }
    }
    if (verifiedLayout === undefined) {
      throw new FinalStateStorageBackendUnsupportedError(
        'AccountStorages metadata is available, but no provenance-bearing Solidity storage layout was supplied. Refusing to guess _balances or _totalSupply slots.',
        { blockHash: block.blockHash, expectedBlock: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH },
      );
    }
    return report;
  } finally {
    await closeSubstrate(api);
  }
}

export const FINAL_LAYOUT_INSPECTION_CONTEXT = {
  blockNumber: MOONBEAM_FINAL_BLOCK_NUMBER,
};
