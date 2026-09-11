import { join, resolve } from 'node:path';
import {
  assertExpectedMoonbeamGenesis,
  assertMoonbeam,
  closeSubstrate,
  connectSubstrate,
  resolveBlock,
} from '../chain/substrate.js';
import { inspectXcDotAsset } from '../chain/metadata.js';
import { EvidenceCaptureError, EvidenceBackendUnsupportedError } from '../utils/errors.js';
import { assertAccountCountInvariant, assertSupplyInvariant } from '../snapshot/invariants.js';
import { sha256Hex } from '../snapshot/digest.js';
import { XC_DOT_DECIMALS } from '../asset/constants.js';
import { readGitCommit, writeJson, writeText } from '../snapshot/io.js';
import {
  captureLegacyStorage,
  readRawStorage,
  serializeStorage,
  assertLegacyAssetsBackend,
} from './raw-storage.js';
import {
  cleanupEvidenceWorkDir,
  finalizeEvidenceBundle,
  makeEvidenceWorkDir,
  makeCanonicalSums,
  prepareEvidenceDirectories,
  storageRecordsToKeys,
  writeEvidenceCanonicalState,
} from './bundle.js';
import { captureProofBatches } from './proof.js';
import { computeEvidenceDigest, makeEvidenceCore, writeProofIndex } from './manifest.js';
import type { EvidenceManifest } from './types.js';

function codecHex(value: unknown, label: string): string {
  const text = (value as { toHex?: () => string } | null)?.toHex?.();
  if (!text || !/^0x[0-9a-fA-F]+$/.test(text) || text.length % 2 !== 0) {
    throw new EvidenceCaptureError(`RPC returned invalid ${label} SCALE bytes.`);
  }
  return text.toLowerCase();
}

function codecJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      typeof nested === 'bigint' ? nested.toString(10) : nested,
    ),
  ) as unknown;
}

export interface CaptureEvidenceOptions {
  rpc: string;
  blockHash: string;
  out: string;
  batchSize: number;
  includeRuntimeCode: boolean;
  evmRpc?: string;
  resume: boolean;
  force: boolean;
}

export async function captureEvidence(options: CaptureEvidenceOptions): Promise<string> {
  const api = await connectSubstrate(options.rpc);
  let workDir: string | undefined;
  try {
    await assertMoonbeam(api);
    const block = await resolveBlock(api, options.blockHash);
    assertExpectedMoonbeamGenesis(block.genesisHash);
    const apiAt = await api.at(block.blockHash);
    // This check is deliberately before any final output is created. A current Moonbeam
    // EVM-backed foreign asset cannot be turned into a complete H160 holder proof by
    // enumerating EVM.AccountStorages alone.
    try {
      assertLegacyAssetsBackend(apiAt);
    } catch (error) {
      if (error instanceof EvidenceBackendUnsupportedError) throw error;
      throw new EvidenceBackendUnsupportedError(String(error));
    }
    const asset = await inspectXcDotAsset(api, block.blockHash);
    const legacy = await captureLegacyStorage(api, block.blockHash, 500);
    assertAccountCountInvariant(legacy.accounts.length, asset.accountCount);
    assertSupplyInvariant(legacy.holders, asset.totalSupplyPlanck);

    const metadata = await api.rpc.state.getMetadata(block.blockHash);
    const metadataScaleHex = codecHex(metadata, 'runtime metadata');
    const metadataJson = codecJson(metadata);
    const runtimeCodeHex = options.includeRuntimeCode
      ? await readRawStorage(api, '0x3a636f6465', block.blockHash)
      : undefined;
    const storageText = serializeStorage([legacy.asset, legacy.metadata, ...legacy.accounts]);
    const proofKeys = storageRecordsToKeys([
      legacy.asset,
      legacy.metadata,
      ...legacy.accounts,
      ...(runtimeCodeHex === undefined
        ? []
        : [
            {
              kind: 'account' as const,
              address: '0x0000000000000000000000000000000000000000',
              key: '0x3a636f6465',
              value: runtimeCodeHex,
              balancePlanck: '0',
            },
          ]),
    ]);
    const id = `${block.blockNumber}-${block.blockHash.slice(2, 10)}`;
    workDir = await makeEvidenceWorkDir(resolve(options.out), id, options.resume);
    await prepareEvidenceDirectories(workDir);

    const header = await api.rpc.chain.getHeader(block.blockHash);
    const headerScaleHex = codecHex(header, 'block header');
    await writeJson(join(workDir, 'header/header.json'), {
      schemaVersion: 1,
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      parentHash: block.parentHash,
      stateRoot: block.stateRoot,
      extrinsicsRoot: block.extrinsicsRoot,
      header: codecJson(header),
      scaleSha256: sha256Hex(headerScaleHex),
    });
    await writeText(join(workDir, 'header/header.scale.hex'), headerScaleHex + '\n');
    await writeText(join(workDir, 'runtime/metadata.scale.hex'), metadataScaleHex + '\n');
    await writeJson(join(workDir, 'runtime/metadata.json'), metadataJson);
    if (runtimeCodeHex !== undefined)
      await writeText(join(workDir, 'runtime/code.scale.hex'), runtimeCodeHex + '\n');

    const core = makeEvidenceCore(
      block,
      asset,
      legacy.decodedAsset,
      legacy.decodedMetadata,
      legacy.holders,
      legacy.accounts.length + 2,
    );
    const stateHashes = await writeEvidenceCanonicalState(
      workDir,
      storageText,
      legacy.holders,
      XC_DOT_DECIMALS,
      core,
    );
    const proofResult = await captureProofBatches(
      api,
      proofKeys,
      block.blockHash,
      block.stateRoot,
      options.batchSize,
      join(workDir, 'proofs'),
      options.resume,
    );
    const proofIndexSha256 = await writeProofIndex(workDir, proofResult.index);
    const canonical = await makeCanonicalSums(workDir);
    const manifestWithoutDigest = {
      schemaVersion: 1 as const,
      tool: 'xcdot-recovery-kit' as const,
      evidenceFormat: 'xcdot-evidence-v1' as const,
      chain: {
        name: 'Moonbeam' as const,
        paraId: 2004 as const,
        genesisHash: block.genesisHash,
      },
      snapshot: {
        blockNumber: block.blockNumber,
        blockHash: block.blockHash,
        parentHash: block.parentHash,
        stateRoot: block.stateRoot,
        extrinsicsRoot: block.extrinsicsRoot,
      },
      runtime: {
        specName: block.specName,
        specVersion: block.specVersion,
        transactionVersion: block.transactionVersion,
        stateVersion: block.stateVersion,
        metadataSha256: sha256Hex(metadataScaleHex + '\n'),
        ...(runtimeCodeHex === undefined
          ? {}
          : { runtimeCodeSha256: sha256Hex(runtimeCodeHex + '\n') }),
      },
      asset: {
        assetId: asset.assetId,
        xc20Address: asset.xc20Address,
        symbol: asset.symbol,
        decimals: asset.decimals,
        totalSupplyPlanck: asset.totalSupplyPlanck,
        accountCount: asset.accountCount,
      },
      holders: {
        count: legacy.holders.length,
        sumBalancePlanck: asset.totalSupplyPlanck,
        holdersSha256: stateHashes.holdersSha256,
        storageSha256: stateHashes.storageSha256,
      },
      proofs: {
        batchSize: options.batchSize,
        batchCount: proofResult.batches.length,
        proofIndexSha256,
      },
      relayAnchor: { status: 'NOT_CAPTURED' as const },
    } satisfies Omit<EvidenceManifest, 'evidenceDigest'>;
    const manifest: EvidenceManifest = {
      ...manifestWithoutDigest,
      evidenceDigest: computeEvidenceDigest(canonical.text),
    };
    const provenance = {
      sourceRpc: options.rpc,
      ...(options.evmRpc === undefined ? {} : { sourceEvmRpc: options.evmRpc }),
      capturedAt: new Date().toISOString(),
      toolCommit: (await readGitCommit()) ?? 'unknown',
      toolVersion: '0.2.0',
      nodeVersion: process.version,
      platform: process.platform,
      command: process.argv.slice(2).join(' '),
    };
    await writeJson(join(workDir, 'provenance.json'), provenance);
    const target = join(resolve(options.out), id);
    await finalizeEvidenceBundle(workDir, target, manifest, options.force);
    workDir = undefined;
    return target;
  } finally {
    if (workDir && !options.resume) await cleanupEvidenceWorkDir(workDir);
    await closeSubstrate(api);
  }
}
