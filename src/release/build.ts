import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { XC_DOT_DECIMALS, XC_DOT_SYMBOL, XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import {
  EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
} from '../final-state/constants.js';
import {
  deriveBalanceAccountStoragesKeyDirect,
  deriveTotalSupplyAccountStoragesKeyDirect,
} from '../storage/substrate-evm.js';
import { compareCanonicalStrings } from '../utils/order.js';
import { formatPercent, formatUnits } from './format.js';

const KNOWN_SUM_PLANCK = 2334506800114108n;
const UNATTRIBUTED_PLANCK = 9927370122n;
const BALANCE_BATCH_SIZE = 128;

export interface FrozenBalance {
  address: string;
  balancePlanck: string;
}

export interface BuildReleaseOptions {
  source: string;
  out?: string;
  projectRoot?: string;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalAddress(value: unknown, line: number): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`invalid H160 address at source line ${line}`);
  }
  return value.toLowerCase();
}

function parseSourceLine(line: string, lineNumber: number): FrozenBalance {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON at source line ${lineNumber}: ${String(error)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`source line ${lineNumber} is not an object`);
  }
  const record = value as { address?: unknown; balancePlanck?: unknown };
  const address = canonicalAddress(record.address, lineNumber);
  if (typeof record.balancePlanck !== 'string' || !/^(0|[1-9][0-9]*)$/.test(record.balancePlanck)) {
    throw new Error(`invalid balance at source line ${lineNumber}`);
  }
  return { address, balancePlanck: BigInt(record.balancePlanck).toString(10) };
}

export async function readFrozenPositiveBalances(source: string): Promise<FrozenBalance[]> {
  return (await readFrozenBalances(source)).filter((record) => BigInt(record.balancePlanck) > 0n);
}

export async function readFrozenBalances(source: string): Promise<FrozenBalance[]> {
  const lines = (await readFile(resolve(source), 'utf8')).split(/\r?\n/);
  const seen = new Set<string>();
  const records: FrozenBalance[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === '') continue;
    const record = parseSourceLine(line, index + 1);
    if (seen.has(record.address)) throw new Error(`duplicate frozen balance for ${record.address}`);
    seen.add(record.address);
    records.push(record);
  }
  records.sort((a, b) => compareCanonicalStrings(a.address, b.address));
  return records;
}

function serializeJsonl(records: readonly unknown[]): string {
  return records.length === 0
    ? ''
    : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function serializeCsv(holders: readonly FrozenBalance[]): string {
  const rows = ['address,balance_planck,balance_xcdot'];
  for (const holder of holders) {
    rows.push(
      `${holder.address},${holder.balancePlanck},${formatUnits(BigInt(holder.balancePlanck), XC_DOT_DECIMALS)}`,
    );
  }
  return `${rows.join('\n')}\n`;
}

function proofKeyIndex(
  holders: readonly FrozenBalance[],
): Map<string, { proofId: string; keyIndex: number; storageKey: string; slot: string }> {
  const entries = holders
    .map((holder) => ({
      holder,
      ...deriveBalanceAccountStoragesKeyDirect(XC_DOT_XC20_ADDRESS, holder.address, 0n),
    }))
    .sort((a, b) => compareCanonicalStrings(a.substrateStorageKey, b.substrateStorageKey));
  const result = new Map<
    string,
    { proofId: string; keyIndex: number; storageKey: string; slot: string }
  >();
  entries.forEach((entry, index) => {
    result.set(entry.holder.address, {
      proofId: `balance-${Math.floor(index / BALANCE_BATCH_SIZE)
        .toString()
        .padStart(6, '0')}`,
      keyIndex: index % BALANCE_BATCH_SIZE,
      storageKey: entry.substrateStorageKey,
      slot: entry.evmStorageSlot,
    });
  });
  return result;
}

async function ensureDirectories(dataDirectory: string): Promise<void> {
  await Promise.all([
    mkdir(join(dataDirectory, 'raw', 'total-supply'), { recursive: true }),
    mkdir(join(dataDirectory, 'raw', 'balances'), { recursive: true }),
    mkdir(join(dataDirectory, 'proofs', 'balance'), { recursive: true }),
  ]);
}

export async function buildFrozenRelease(options: BuildReleaseOptions): Promise<{
  dataDirectory: string;
  holderCount: number;
  knownSumPlanck: string;
  unattributedPlanck: string;
}> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const dataDirectory = resolve(options.out ?? join(projectRoot, 'data'));
  const source = resolve(options.source);
  const allCandidates = await readFrozenBalances(source);
  const holders = allCandidates.filter((record) => BigInt(record.balancePlanck) > 0n);
  const knownSum = holders.reduce((sum, holder) => sum + BigInt(holder.balancePlanck), 0n);
  const totalSupply = BigInt(EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK);
  if (
    holders.length !== 11785 ||
    knownSum !== KNOWN_SUM_PLANCK ||
    totalSupply - knownSum !== UNATTRIBUTED_PLANCK
  ) {
    throw new Error(
      `frozen balance invariants failed: count=${holders.length} sum=${knownSum.toString(10)} deficit=${(totalSupply - knownSum).toString(10)}`,
    );
  }
  await mkdir(dataDirectory, { recursive: true });
  await ensureDirectories(dataDirectory);

  const holdersJsonl = serializeJsonl(holders);
  const holdersCsv = serializeCsv(holders);
  const keyIndex = proofKeyIndex(holders);
  const evidenceIndex: Record<string, unknown> = {};
  for (const holder of holders) {
    const proof = keyIndex.get(holder.address);
    evidenceIndex[holder.address] = {
      status: 'known-positive',
      balancePlanck: holder.balancePlanck,
      ...(proof === undefined ? {} : { proofId: proof.proofId, keyIndex: proof.keyIndex }),
    };
  }

  const snapshot = {
    schemaVersion: 1,
    snapshotId: 'moonbeam-xcdot-terminal-16796696-v1',
    status: 'UNATTRIBUTED_SHORTFALL',
    terminalState: {
      blockNumber: Number(MOONBEAM_FINAL_BLOCK_NUMBER),
      blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
      stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
    },
    asset: {
      contract: XC_DOT_XC20_ADDRESS,
      symbol: XC_DOT_SYMBOL,
      decimals: XC_DOT_DECIMALS,
      balancesSlot: 0,
      totalSupplySlot: 2,
    },
    recovery: {
      positiveHolderAddresses: holders.length,
      knownBalancePlanck: knownSum.toString(10),
      totalSupplyPlanck: totalSupply.toString(10),
      unattributedPlanck: UNATTRIBUTED_PLANCK.toString(10),
      knownCoveragePercent: formatPercent(knownSum, totalSupply),
    },
    proofStatus: {
      type: 'substrate-state_getReadProof',
      stateVersion: 1,
      totalSupplyCaptured: false,
      totalSupplyVerified: false,
      knownBalanceProofsCaptured: 0,
      knownBalanceProofsVerified: false,
    },
    limitations: {
      holderDiscoveryComplete: false,
      unattributedBalancePlanck: UNATTRIBUTED_PLANCK.toString(10),
      missingAddressIsNotProvenZero: true,
    },
    relayAnchor: { status: 'pending' },
  };

  const writes: Array<[string, string]> = [
    ['holders.jsonl', holdersJsonl],
    ['holders.csv', holdersCsv],
    ['snapshot.json', json(snapshot)],
    ['evidence-index.json', json(evidenceIndex)],
  ];
  for (const [name, contents] of writes)
    await writeFile(join(dataDirectory, name), contents, 'utf8');
  return {
    dataDirectory,
    holderCount: holders.length,
    knownSumPlanck: knownSum.toString(10),
    unattributedPlanck: UNATTRIBUTED_PLANCK.toString(10),
  };
}

export {
  BALANCE_BATCH_SIZE,
  KNOWN_SUM_PLANCK,
  UNATTRIBUTED_PLANCK,
  deriveTotalSupplyAccountStoragesKeyDirect,
};
