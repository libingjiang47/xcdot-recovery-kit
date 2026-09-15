import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  assertExpectedMoonbeamGenesis,
  assertMoonbeam,
  closeSubstrate,
  connectSubstrate,
  resolveBlock,
} from '../chain/substrate.js';
import { XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import {
  EXPECTED_SUBSCAN_CANDIDATE_COUNT,
  EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
} from '../final-state/constants.js';
import { captureProofBatches } from '../evidence/proof.js';
import { sha256Hex } from '../snapshot/digest.js';
import { compareCanonicalStrings } from '../utils/order.js';
import {
  FinalStateIdentityMismatchError,
  FinalStateStorageLayoutError,
  FinalStateStorageBackendUnsupportedError,
} from '../utils/errors.js';
import { discoverCandidateAddresses } from '../subscan/candidates.js';
import {
  accountStoragesMetadataSummary,
  deriveBalanceAccountStoragesKey,
  deriveTotalSupplyAccountStoragesKey,
  readU256AccountStorage,
} from './substrate-evm.js';
import { parseVerifiedStorageLayout, type VerifiedStorageLayout } from './solidity.js';

export interface ExtractFinalStateStorageOptions {
  substrateRpc: string;
  blockHash: string;
  dataset: string;
  layout?: string;
  out?: string;
  proofBatchSize?: number;
  expectedTotalSupplyPlanck?: string;
  expectedCandidateCount?: number;
  expectedStateRoot?: string;
  force?: boolean;
  resume?: boolean;
}

interface StorageRecord {
  address: string;
  evmStorageSlot: string;
  substrateStorageKey: string;
  rawValue: string | null;
  balancePlanck: string;
}

interface TotalSupplyRecord {
  kind: 'totalSupply';
  evmStorageSlot: string;
  substrateStorageKey: string;
  rawValue: string | null;
  totalSupplyPlanck: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function ndjson<T>(records: readonly T[]): string {
  return records.length > 0
    ? records.map((record) => JSON.stringify(record)).join('\n') + '\n'
    : '';
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(root, path).split('\\').join('/'));
    }
  }
  await visit(root);
  return files.sort(compareCanonicalStrings);
}

async function writeSums(root: string): Promise<void> {
  const files = (await listFiles(root)).filter((file) => file !== 'SHA256SUMS');
  const sums: string[] = [];
  for (const file of files) sums.push(`${sha256Hex(await readFile(join(root, file)))}  ${file}`);
  await writeFile(
    join(root, 'SHA256SUMS'),
    sums.join('\n') + (sums.length > 0 ? '\n' : ''),
    'utf8',
  );
}

async function loadLayout(path: string | undefined): Promise<VerifiedStorageLayout> {
  if (path === undefined) {
    throw new FinalStateStorageBackendUnsupportedError(
      'A provenance-bearing Solidity storage layout is required; refusing to guess EVM slots.',
    );
  }
  try {
    return parseVerifiedStorageLayout(JSON.parse(await readFile(resolve(path), 'utf8')) as unknown);
  } catch (error) {
    if (error instanceof FinalStateStorageLayoutError) throw error;
    throw new FinalStateStorageBackendUnsupportedError(
      'Could not read the supplied storage layout artifact.',
      {
        layout: resolve(path),
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function extractFinalStateStorage(
  options: ExtractFinalStateStorageOptions,
): Promise<{ outputDirectory: string; status: 'PROOF_READY'; summary: Record<string, unknown> }> {
  const layout = await loadLayout(options.layout);
  const candidates = await discoverCandidateAddresses(options.dataset);
  const expectedCandidateCount = options.expectedCandidateCount ?? EXPECTED_SUBSCAN_CANDIDATE_COUNT;
  if (candidates.addresses.length !== expectedCandidateCount) {
    throw new FinalStateIdentityMismatchError(
      'Subscan candidate count does not match the expected set.',
      {
        expectedCandidateCount,
        actualCandidateCount: candidates.addresses.length,
      },
    );
  }
  const expectedSupply = options.expectedTotalSupplyPlanck ?? EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK;
  const expectedStateRoot = options.expectedStateRoot ?? MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT;
  const outputDirectory = resolve(
    options.out ?? `snapshots/final-state/moonbeam-${MOONBEAM_FINAL_BLOCK_NUMBER}`,
  );
  if (options.force) await rm(outputDirectory, { recursive: true, force: true });
  else if (!options.resume) {
    try {
      await access(outputDirectory);
      throw new FinalStateIdentityMismatchError(`Output already exists: ${outputDirectory}.`, {
        outputDirectory,
      });
    } catch (error) {
      if (error instanceof FinalStateIdentityMismatchError) throw error;
    }
  }
  await mkdir(outputDirectory, { recursive: true });

  const api = await connectSubstrate(options.substrateRpc);
  try {
    await assertMoonbeam(api);
    const block = await resolveBlock(api, options.blockHash);
    assertExpectedMoonbeamGenesis(block.genesisHash);
    if (block.stateRoot.toLowerCase() !== expectedStateRoot.toLowerCase()) {
      throw new FinalStateIdentityMismatchError(
        'Pinned Substrate state root differs from the expected root.',
        {
          expectedStateRoot,
          actualStateRoot: block.stateRoot,
        },
      );
    }
    const apiAt = await api.at(block.blockHash);
    const accountStorages = accountStoragesMetadataSummary(apiAt);
    const totalKey = deriveTotalSupplyAccountStoragesKey(
      apiAt,
      XC_DOT_XC20_ADDRESS,
      layout.totalSupplySlot,
    );
    const zeroKey = deriveBalanceAccountStoragesKey(
      apiAt,
      XC_DOT_XC20_ADDRESS,
      '0x0000000000000000000000000000000000000000',
      layout.balancesSlot,
    );
    const total = await readU256AccountStorage(api, totalKey.substrateStorageKey, block.blockHash);
    if (total.value.toString(10) !== expectedSupply) {
      throw new FinalStateStorageLayoutError(
        'Raw AccountStorages _totalSupply does not match expected supply.',
        {
          expectedSupply,
          actualSupply: total.value.toString(10),
        },
      );
    }
    const zero = await readU256AccountStorage(api, zeroKey.substrateStorageKey, block.blockHash);
    if (zero.value !== 0n) {
      throw new FinalStateStorageLayoutError(
        'Raw AccountStorages zero-address balance is not zero.',
        {
          actualBalance: zero.value.toString(10),
        },
      );
    }

    const storage: StorageRecord[] = [];
    for (const address of candidates.addresses) {
      const key = deriveBalanceAccountStoragesKey(
        apiAt,
        XC_DOT_XC20_ADDRESS,
        address,
        layout.balancesSlot,
      );
      const value = await readU256AccountStorage(api, key.substrateStorageKey, block.blockHash);
      storage.push({
        address,
        evmStorageSlot: key.evmStorageSlot,
        substrateStorageKey: key.substrateStorageKey,
        rawValue: value.rawValue,
        balancePlanck: value.value.toString(10),
      });
    }
    const storageSum = storage.reduce((sum, item) => sum + BigInt(item.balancePlanck), 0n);
    if (storageSum !== total.value) {
      throw new FinalStateStorageLayoutError(
        'Known AccountStorages balances do not equal _totalSupply.',
        {
          knownFinalSumPlanck: storageSum.toString(10),
          totalSupplyPlanck: total.value.toString(10),
        },
      );
    }

    const sampleAddresses = storage
      .filter((item) => item.balancePlanck !== '0')
      .sort((a, b) => (BigInt(b.balancePlanck) > BigInt(a.balancePlanck) ? 1 : -1))
      .slice(0, 10)
      .map((item) => item.address);
    const storageDirectory = join(outputDirectory, 'substrate-storage');
    const proofsDirectory = join(outputDirectory, 'proofs');
    const layoutDirectory = join(outputDirectory, 'storage-layout');
    const verificationDirectory = join(outputDirectory, 'verification');
    await Promise.all([
      mkdir(storageDirectory, { recursive: true }),
      mkdir(proofsDirectory, { recursive: true }),
      mkdir(layoutDirectory, { recursive: true }),
      mkdir(verificationDirectory, { recursive: true }),
    ]);
    const totalRecord: TotalSupplyRecord = {
      kind: 'totalSupply',
      evmStorageSlot: totalKey.evmStorageSlot,
      substrateStorageKey: totalKey.substrateStorageKey,
      rawValue: total.rawValue,
      totalSupplyPlanck: total.value.toString(10),
    };
    const zeroRecord: StorageRecord = {
      address: '0x0000000000000000000000000000000000000000',
      evmStorageSlot: zeroKey.evmStorageSlot,
      substrateStorageKey: zeroKey.substrateStorageKey,
      rawValue: zero.rawValue,
      balancePlanck: zero.value.toString(10),
    };
    await writeFile(
      join(storageDirectory, 'storage.ndjson'),
      ndjson([totalRecord, zeroRecord, ...storage]),
      'utf8',
    );
    await writeFile(join(storageDirectory, 'balances.ndjson'), ndjson(storage), 'utf8');
    const positives = storage
      .filter((item) => item.balancePlanck !== '0')
      .map((item) => ({ address: item.address, balancePlanck: item.balancePlanck }));
    await writeFile(join(storageDirectory, 'positive-holders.ndjson'), ndjson(positives), 'utf8');
    await writeFile(
      join(layoutDirectory, 'layout.json'),
      json({
        schemaVersion: 1,
        contract: layout.contract,
        compiler: layout.compiler,
        sources: layout.sources,
        balancesSlot: layout.balancesSlot.toString(10),
        totalSupplySlot: layout.totalSupplySlot.toString(10),
      }),
      'utf8',
    );

    const proofKeys = [
      totalKey.substrateStorageKey,
      zeroKey.substrateStorageKey,
      ...storage.map((item) => item.substrateStorageKey),
    ];
    const proofResult = await captureProofBatches(
      api,
      proofKeys,
      block.blockHash,
      block.stateRoot,
      options.proofBatchSize ?? 128,
      proofsDirectory,
      options.resume ?? false,
    );
    await writeFile(join(proofsDirectory, 'index.ndjson'), proofResult.index, 'utf8');

    const summary = {
      schemaVersion: 1,
      status: 'PROOF_READY',
      chain: {
        name: 'Moonbeam',
        paraId: 2004,
        blockNumber: block.blockNumber,
        substrateBlockHash: block.blockHash,
        substrateStateRoot: block.stateRoot,
        specName: block.specName,
        specVersion: block.specVersion,
        stateVersion: block.stateVersion,
      },
      accountStorages,
      asset: {
        symbol: 'xcDOT',
        decimals: 10,
        contract: XC_DOT_XC20_ADDRESS,
        codeHash: layout.codeHash ?? null,
        balancesSlot: layout.balancesSlot.toString(10),
        totalSupplySlot: layout.totalSupplySlot.toString(10),
        totalSupplyPlanck: total.value.toString(10),
      },
      candidateSet: {
        count: candidates.addresses.length,
        candidateAddressesSha256: sha256Hex(
          candidates.addresses.map((address) => JSON.stringify({ address }) + '\n').join(''),
        ),
        source: 'Moonbeam Subscan address discovery',
      },
      storage: {
        queried: storage.length,
        missing: storage.filter((item) => item.rawValue === null).length,
        positive: positives.length,
        zero: storage.length - positives.length,
        knownFinalSumPlanck: storageSum.toString(10),
        completeness: storageSum === total.value ? 'PASS' : 'FAIL',
        zeroAddressBalancePlanck: zero.value.toString(10),
        sampleAddresses,
        rpcStorageSampleMatch: 'NOT_RUN',
        rpcStorageFullMatch: 'NOT_RUN',
      },
      proofs: {
        batchSize: options.proofBatchSize ?? 128,
        batchCount: proofResult.batches.length,
        blockHash: block.blockHash,
        stateRoot: block.stateRoot,
      },
      knownContext: {
        expectedBlockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
        expectedStateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
      },
    };
    await writeFile(join(storageDirectory, 'summary.json'), json(summary), 'utf8');
    await writeFile(
      join(verificationDirectory, 'completeness.json'),
      json({
        status: 'PASS',
        knownFinalSumPlanck: storageSum.toString(10),
        totalSupplyPlanck: total.value.toString(10),
        theorem:
          'All extracted non-negative balances sum to the independently extracted totalSupply.',
        offlineProofVerification: 'PENDING',
      }),
      'utf8',
    );
    await writeFile(
      join(outputDirectory, 'manifest.json'),
      json({
        schemaVersion: 1,
        artifact: 'xcdot-final-state-substrate-storage-v0.26',
        status: 'PROOF_READY',
        blockHash: block.blockHash,
        stateRoot: block.stateRoot,
        contract: XC_DOT_XC20_ADDRESS,
        totalSupplyPlanck: total.value.toString(10),
      }),
      'utf8',
    );
    await writeSums(outputDirectory);
    return { outputDirectory, status: 'PROOF_READY', summary };
  } finally {
    await closeSubstrate(api);
  }
}
