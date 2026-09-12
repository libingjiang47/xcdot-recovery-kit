import { ApiPromise } from '@polkadot/api';
import { HttpProvider, WsProvider } from '@polkadot/rpc-provider';
import { decodeStorageEntry, type StorageKeyLike } from '../asset/decode.js';
import {
  BlockNotFoundError,
  BlockHashMismatchError,
  EnumerationUnsupportedError,
  RpcUnavailableError,
  StorageDecodeError,
  WrongChainError,
} from '../utils/errors.js';
import { MOONBEAM_GENESIS_HASH, XC_DOT_ASSET_ID } from '../asset/constants.js';
import type { BlockIdentity, ExtractionResult, HolderRecord } from '../types.js';
import { canonicalizeHolders } from '../snapshot/canonicalize.js';
import { assertAccountCountInvariant, assertSupplyInvariant } from '../snapshot/invariants.js';
import { inspectXcDotAsset } from './metadata.js';
import { retryRpc } from '../verification/providers.js';

export async function connectSubstrate(rpc: string): Promise<ApiPromise> {
  if (!rpc) throw new RpcUnavailableError('An RPC endpoint is required.');
  try {
    const provider = /^wss?:\/\//i.test(rpc) ? new WsProvider(rpc) : new HttpProvider(rpc);
    return await ApiPromise.create({ provider: provider as any, throwOnConnect: true });
  } catch (error) {
    throw new RpcUnavailableError(`Could not connect to Substrate RPC: ${String(error)}`, { rpc });
  }
}

export async function closeSubstrate(api: ApiPromise): Promise<void> {
  try {
    await api.disconnect();
  } catch {
    // Disconnect is best-effort after a command has completed or failed.
  }
}

export async function getChainName(api: ApiPromise): Promise<string> {
  return (await api.rpc.system.chain()).toString();
}

export async function assertMoonbeam(api: ApiPromise): Promise<void> {
  const chain = await getChainName(api);
  const name = (await api.rpc.system.name()).toString();
  if (chain.toLowerCase() !== 'moonbeam' && name.toLowerCase() !== 'moonbeam') {
    throw new WrongChainError('RPC is not identified as Moonbeam.', { chain, systemName: name });
  }
}

function normalizeHash(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value : (value as { toHex?: () => string })?.toHex?.();
  if (!text || !/^0x[0-9a-fA-F]{64}$/.test(text)) {
    throw new BlockNotFoundError(`Invalid ${label} returned by RPC.`, { value: String(value) });
  }
  return text.toLowerCase();
}

function codecNumber(value: unknown, label: string): number {
  const codec = value as { toNumber?: () => number; toString?: () => string } | null;
  const result =
    typeof codec?.toNumber === 'function' ? codec.toNumber() : Number(codec?.toString?.());
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RpcUnavailableError(`Invalid ${label} returned by RPC.`, { value: String(value) });
  }
  return result;
}

function runtimeStateVersion(runtime: unknown): number {
  const value = (runtime as { stateVersion?: unknown } | null)?.stateVersion;
  if (value === undefined || value === null) {
    throw new RpcUnavailableError(
      'The pinned runtime does not expose stateVersion; refusing to guess the trie layout.',
    );
  }
  return codecNumber(value, 'state version');
}

export function assertExpectedMoonbeamGenesis(genesisHash: string): void {
  if (genesisHash.toLowerCase() !== MOONBEAM_GENESIS_HASH) {
    throw new WrongChainError('RPC genesis hash is not the expected Moonbeam genesis hash.', {
      expected: MOONBEAM_GENESIS_HASH,
      actual: genesisHash,
    });
  }
}

export async function resolveBlock(api: ApiPromise, requestedHash: string): Promise<BlockIdentity> {
  const blockHash = normalizeHash(requestedHash, 'block hash');
  try {
    const header = await api.rpc.chain.getHeader(blockHash);
    if (!header) throw new Error('empty header');
    const roundTripHash = normalizeHash(
      await api.rpc.chain.getBlockHash(header.number.toBigInt()),
      'block hash',
    );
    if (roundTripHash !== blockHash) {
      throw new BlockHashMismatchError(
        'RPC returned a different hash for the pinned block number.',
        {
          expected: blockHash,
          actual: roundTripHash,
        },
      );
    }
    const runtime = await api.rpc.state.getRuntimeVersion(blockHash);
    const genesisHash = normalizeHash(api.genesisHash, 'genesis hash');
    const stateVersion = runtimeStateVersion(runtime);
    return {
      blockNumber: header.number.toBigInt().toString(10),
      blockHash,
      parentHash: normalizeHash(header.parentHash, 'parent hash'),
      stateRoot: normalizeHash(header.stateRoot, 'state root'),
      extrinsicsRoot: normalizeHash(header.extrinsicsRoot, 'extrinsics root'),
      genesisHash,
      specName: runtime.specName.toString(),
      specVersion: codecNumber(runtime.specVersion, 'spec version'),
      transactionVersion: codecNumber(runtime.transactionVersion, 'transaction version'),
      stateVersion,
    };
  } catch (error) {
    if (error instanceof BlockNotFoundError || error instanceof BlockHashMismatchError) throw error;
    throw new BlockNotFoundError(`Could not resolve pinned block ${blockHash}: ${String(error)}`, {
      blockHash,
    });
  }
}

export interface ProbeResult {
  reachable: true;
  chain: string;
  systemName: string;
  systemVersion: string;
  finalizedHead: string;
  finalizedNumber: string;
  stateRoot: string;
  specName: string;
  specVersion: number;
  transactionVersion: number;
  stateVersion: number;
  supportsStorageEnumeration: boolean;
}

export async function probeRpc(api: ApiPromise): Promise<ProbeResult> {
  try {
    await assertMoonbeam(api);
    const [chain, systemName, systemVersion, finalizedHeadRaw] = await Promise.all([
      api.rpc.system.chain(),
      api.rpc.system.name(),
      api.rpc.system.version(),
      api.rpc.chain.getFinalizedHead(),
    ]);
    const finalizedHead = normalizeHash(finalizedHeadRaw, 'finalized head');
    const identity = await resolveBlock(api, finalizedHead);
    await api.rpc.state.getMetadata(finalizedHead);
    await api.rpc.state.getStorage('0x00', finalizedHead);
    const keys = await api.rpc.state.getKeysPaged('0x', 1, undefined, finalizedHead);
    if (!Array.isArray(keys)) throw new Error('state_getKeysPaged did not return an array');
    return {
      reachable: true,
      chain: chain.toString(),
      systemName: systemName.toString(),
      systemVersion: systemVersion.toString(),
      finalizedHead,
      finalizedNumber: identity.blockNumber,
      stateRoot: identity.stateRoot,
      specName: identity.specName,
      specVersion: identity.specVersion,
      transactionVersion: identity.transactionVersion,
      stateVersion: identity.stateVersion,
      supportsStorageEnumeration: true,
    };
  } catch (error) {
    if (error instanceof WrongChainError) throw error;
    throw new EnumerationUnsupportedError(
      `RPC probe failed or does not expose the required state methods: ${String(error)}`,
    );
  }
}

function storageKeyHex(key: StorageKeyLike): string {
  const hex = key.toHex();
  if (!/^0x[0-9a-fA-F]+$/.test(hex))
    throw new StorageDecodeError('Malformed storage key returned by RPC.');
  return hex.toLowerCase();
}

export async function enumerateXcDotAccounts(
  api: ApiPromise,
  blockHash: string,
  pageSize = 500,
): Promise<HolderRecord[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10_000) {
    throw new EnumerationUnsupportedError('Page size must be an integer between 1 and 10000.');
  }
  const apiAt = await api.at(blockHash);
  const accountQuery = (apiAt.query as any).assets?.account as
    | {
        entriesPaged?: (
          options: Record<string, unknown>,
        ) => Promise<Array<[StorageKeyLike, unknown]>>;
      }
    | undefined;
  if (!accountQuery || typeof accountQuery.entriesPaged !== 'function') {
    throw new EnumerationUnsupportedError(
      'Assets.Account does not support paged storage enumeration.',
    );
  }

  const entries: HolderRecord[] = [];
  const seenKeys = new Set<string>();
  let startKey: string | undefined;
  let previousLastKey: string | undefined;
  for (;;) {
    const options: Record<string, unknown> = { args: [XC_DOT_ASSET_ID], pageSize };
    if (startKey !== undefined) options.startKey = startKey;
    const page = await retryRpc(() => accountQuery.entriesPaged!(options));
    if (!Array.isArray(page))
      throw new EnumerationUnsupportedError('Paged enumeration returned a non-array page.');
    if (page.length === 0) break;
    if (page.length > pageSize)
      throw new EnumerationUnsupportedError('RPC returned more entries than requested.');

    let pageLastKey: string | undefined;
    for (const entry of page) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new StorageDecodeError('Malformed Assets.Account page entry.');
      }
      const key = entry[0];
      if (!key) throw new StorageDecodeError('Assets.Account page entry has no storage key.');
      const keyHex = storageKeyHex(key);
      if (seenKeys.has(keyHex))
        throw new EnumerationUnsupportedError('RPC repeated a storage key.', { key: keyHex });
      if (previousLastKey !== undefined && keyHex <= previousLastKey) {
        throw new EnumerationUnsupportedError('Storage pagination did not advance monotonically.', {
          previousLastKey,
          key: keyHex,
        });
      }
      if (pageLastKey !== undefined && keyHex <= pageLastKey) {
        throw new EnumerationUnsupportedError('RPC returned an unsorted or repeated storage page.');
      }
      seenKeys.add(keyHex);
      entries.push(decodeStorageEntry(key, entry[1], XC_DOT_ASSET_ID));
      pageLastKey = keyHex;
    }
    if (pageLastKey === undefined || pageLastKey === startKey) {
      throw new EnumerationUnsupportedError('RPC pagination did not provide a continuation key.');
    }
    previousLastKey = pageLastKey;
    startKey = pageLastKey;
  }
  return entries;
}

export async function extractXcDotSnapshot(
  api: ApiPromise,
  blockHash: string,
  pageSize = 500,
): Promise<ExtractionResult> {
  await assertMoonbeam(api);
  const block = await resolveBlock(api, blockHash);
  const asset = await inspectXcDotAsset(api, block.blockHash);
  const allAccounts = await enumerateXcDotAccounts(api, block.blockHash, pageSize);
  assertAccountCountInvariant(allAccounts.length, asset.accountCount);
  const holders = canonicalizeHolders(allAccounts);
  assertSupplyInvariant(holders, asset.totalSupplyPlanck);
  return { block, asset, allAccounts, holders };
}
