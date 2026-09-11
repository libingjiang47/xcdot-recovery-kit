import { Command } from 'commander';
import { join, resolve } from 'node:path';
import { closeSubstrate, connectSubstrate, extractXcDotSnapshot } from '../chain/substrate.js';
import { createEvmClient, verifyEvmSnapshot } from '../verification/evm.js';
import { computeSnapshotDigest, fileSha256s, sha256Hex } from '../snapshot/digest.js';
import {
  serializeHoldersCsv,
  serializeHoldersJson,
  serializeHoldersNdjson,
} from '../snapshot/serialize.js';
import {
  cleanupSnapshotTemp,
  makeSnapshotTempDir,
  publishSnapshot,
  readGitCommit,
  writeJson,
  writeText,
} from '../snapshot/io.js';
import { rpcFromOptions, registerRpcOption } from './shared.js';
import type { AccountClassification, SnapshotManifest, VerificationResult } from '../types.js';
import { XC_DOT_DECIMALS, XC_DOT_SYMBOL } from '../asset/constants.js';
import { compareCanonicalStrings } from '../utils/order.js';

function createManifest(
  extraction: Awaited<ReturnType<typeof extractXcDotSnapshot>>,
  holdersSha256: string,
): SnapshotManifest {
  const base = {
    schemaVersion: 1 as const,
    tool: 'xcdot-recovery-kit' as const,
    chain: {
      name: 'Moonbeam' as const,
      paraId: 2004 as const,
      genesisHash: extraction.block.genesisHash,
    },
    snapshot: {
      blockNumber: extraction.block.blockNumber,
      blockHash: extraction.block.blockHash,
      parentHash: extraction.block.parentHash,
      stateRoot: extraction.block.stateRoot,
      specName: extraction.block.specName,
      specVersion: extraction.block.specVersion,
    },
    asset: extraction.asset,
    holders: {
      count: extraction.holders.length,
      totalBalancePlanck: extraction.asset.totalSupplyPlanck,
      sha256: holdersSha256,
    },
  } satisfies Omit<SnapshotManifest, 'snapshotDigest'>;
  return { ...base, snapshotDigest: computeSnapshotDigest(base) };
}

function notRunVerification(): VerificationResult {
  return {
    substrateSupplyMatchesHolderSum: true,
    evmSupplyMatchesSubstrateSupply: false,
    holderBalancesChecked: 0,
    holderBalanceMismatches: [],
    errors: ['EVM verification not run; use xcdot-recovery evm-check.'],
    status: 'NOT_RUN',
  };
}

function initialClassifications(addresses: string[]): {
  schemaVersion: 1;
  status: 'NOT_RUN' | 'PARTIAL' | 'PASS';
  accounts: AccountClassification[];
} {
  return {
    schemaVersion: 1,
    status: 'NOT_RUN',
    accounts: addresses.map((address) => ({ address, codeStatus: 'unknown' as const })),
  };
}

async function writeSums(tempDir: string, contents: Record<string, string>): Promise<void> {
  const files = fileSha256s(contents);
  const sums =
    Object.entries(files)
      .sort(([a], [b]) => compareCanonicalStrings(a, b))
      .map(([name, hash]) => `${hash}  ${name}`)
      .join('\n') + '\n';
  await writeText(join(tempDir, 'SHA256SUMS'), sums);
}

export function snapshotCommand(): Command {
  const command = new Command('snapshot').description(
    'Extract a deterministic xcDOT snapshot at a pinned block',
  );
  registerRpcOption(command);
  command.requiredOption('--block-hash <hash>', 'Explicit pinned Moonbeam block hash');
  command.option('--out <directory>', 'Snapshot output parent directory', 'snapshots');
  command.option('--page-size <size>', 'Storage enumeration page size', '500');
  command.option('--evm-rpc <url>', 'Optional EVM RPC for inline independent verification');
  command.option('--evm-concurrency <size>', 'EVM request concurrency', '8');
  command.option('--force', 'Replace an existing snapshot directory after validation');
  command.action(
    async (options: {
      rpc?: string;
      blockHash: string;
      out: string;
      pageSize: string;
      evmRpc?: string;
      evmConcurrency: string;
      force?: boolean;
    }) => {
      const rpc = rpcFromOptions(options);
      const pageSize = Number(options.pageSize);
      const evmConcurrency = Number(options.evmConcurrency);
      const api = await connectSubstrate(rpc);
      let tempDir: string | undefined;
      try {
        const extraction = await extractXcDotSnapshot(api, options.blockHash, pageSize);
        const holdersNdjson = serializeHoldersNdjson(extraction.holders);
        const holdersJson = serializeHoldersJson(extraction.holders);
        const holdersCsv = serializeHoldersCsv(extraction.holders, XC_DOT_DECIMALS);
        const manifest = createManifest(extraction, sha256Hex(holdersNdjson));
        let verification = notRunVerification();
        let classifications = initialClassifications(
          extraction.holders.map((holder) => holder.address),
        );

        if (options.evmRpc) {
          const evm = await verifyEvmSnapshot(
            createEvmClient(options.evmRpc),
            manifest,
            extraction.holders,
            evmConcurrency,
          );
          verification = evm.verification;
          classifications = {
            schemaVersion: 1,
            status: evm.classifications.some((item) => item.codeStatus === 'unknown')
              ? 'PARTIAL'
              : 'PASS',
            accounts: evm.classifications,
          };
          if (verification.status !== 'PASS') {
            throw new Error(
              'Inline EVM verification failed; canonical snapshot was not published.',
            );
          }
        }

        const provenance = {
          toolCommit: (await readGitCommit()) ?? 'unknown',
          toolVersion: '0.2.0',
          rpc,
          generatedAt: new Date().toISOString(),
          node: process.version,
          platform: process.platform,
          command: process.argv.slice(2).join(' '),
        };
        tempDir = await makeSnapshotTempDir(resolve(options.out));
        await writeJson(join(tempDir, 'manifest.json'), manifest);
        await writeJson(join(tempDir, 'provenance.json'), provenance);
        await writeText(join(tempDir, 'holders.ndjson'), holdersNdjson);
        await writeText(join(tempDir, 'holders.json'), holdersJson);
        await writeText(join(tempDir, 'holders.csv'), holdersCsv);
        await writeJson(join(tempDir, 'verification.json'), verification);
        await writeJson(join(tempDir, 'account-classification.json'), classifications);
        await writeSums(tempDir, {
          'account-classification.json': JSON.stringify(classifications, null, 2) + '\n',
          'holders.csv': holdersCsv,
          'holders.json': holdersJson,
          'holders.ndjson': holdersNdjson,
          'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
          'provenance.json': JSON.stringify(provenance, null, 2) + '\n',
          'verification.json': JSON.stringify(verification, null, 2) + '\n',
        });

        const target = join(
          resolve(options.out),
          `${extraction.block.blockNumber}-${extraction.block.blockHash.slice(2, 10)}`,
        );
        await publishSnapshot(tempDir, target, Boolean(options.force));
        tempDir = undefined;
        console.error(`[asset] ${XC_DOT_SYMBOL} id=${manifest.asset.assetId}`);
        console.error(
          `[scan] entries=${extraction.allAccounts.length} holders=${extraction.holders.length}`,
        );
        console.error(`[verify] holder_sum=${manifest.holders.totalBalancePlanck}`);
        console.error('[verify] supply_match=PASS');
        console.error(`[canonical] holders_sha256=${manifest.holders.sha256}`);
        console.error(`[canonical] snapshot_digest=${manifest.snapshotDigest}`);
        console.log(target);
      } finally {
        if (tempDir) await cleanupSnapshotTemp(tempDir);
        await closeSubstrate(api);
      }
    },
  );
  return command;
}
