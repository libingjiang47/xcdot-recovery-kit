import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { XC_DOT_DECIMALS, XC_DOT_SYMBOL, XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import {
  EXPECTED_XC_DOT_TOTAL_SUPPLY_PLANCK,
  MOONBEAM_FINAL_BLOCK_NUMBER,
  MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
  MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
  RANK565_HISTORICAL_BALANCE_PLANCK,
} from '../final-state/constants.js';
import {
  deriveBalanceAccountStoragesKeyDirect,
  deriveTotalSupplyAccountStoragesKeyDirect,
} from '../storage/substrate-evm.js';
import { sha256Hex } from '../snapshot/digest.js';
import { compareCanonicalStrings } from '../utils/order.js';
import { formatPercent, formatUnits } from './format.js';

const KNOWN_SUM_PLANCK = 2334506800114108n;
const UNATTRIBUTED_PLANCK = 9927370122n;
const BALANCE_BATCH_SIZE = 128;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_SOURCE =
  'diagnostics/candidate-extension/candidate-cd2e0f20e5d49992/final-balances.ndjson';

export interface FrozenBalance {
  address: string;
  balancePlanck: string;
}

export interface BuildReleaseOptions {
  source?: string;
  out?: string;
  projectRoot?: string;
}

interface ClassificationRecord {
  classification: 'unknown';
  codeLength: null;
  codeHash: null;
  source: 'not-captured';
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
    mkdir(join(dataDirectory, 'raw', 'account-code'), { recursive: true }),
    mkdir(join(dataDirectory, 'proofs', 'balance'), { recursive: true }),
    mkdir(join(dataDirectory, 'proofs', 'code'), { recursive: true }),
  ]);
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

export async function writeReleaseSums(projectRoot: string, dataDirectory: string): Promise<void> {
  const files = await listFiles(dataDirectory);
  const lines = [] as string[];
  for (const file of files)
    lines.push(`${sha256Hex(await readFile(join(dataDirectory, file)))}  data/${file}`);
  await writeFile(join(projectRoot, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
}

export async function buildFrozenRelease(options: BuildReleaseOptions = {}): Promise<{
  dataDirectory: string;
  holderCount: number;
  knownSumPlanck: string;
  unattributedPlanck: string;
  candidateAddressesSha256: string;
}> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const dataDirectory = resolve(options.out ?? join(projectRoot, 'data'));
  const source = resolve(options.source ?? join(projectRoot, DEFAULT_SOURCE));
  const allCandidates = await readFrozenBalances(source);
  const holders = allCandidates.filter((record) => BigInt(record.balancePlanck) > 0n);
  const zeroCandidates = allCandidates.filter((record) => BigInt(record.balancePlanck) === 0n);
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
  const holdersJson = `${JSON.stringify(holders, null, 2)}\n`;
  const holdersCsv = serializeCsv(holders);
  const keyIndex = proofKeyIndex(holders);
  const candidateAddresses = holders.map((holder) => ({ address: holder.address }));
  const candidateAddressesSha256 = sha256Hex(serializeJsonl(candidateAddresses));
  const evidenceIndex: Record<string, unknown> = {};
  for (const holder of holders) {
    const proof = keyIndex.get(holder.address);
    evidenceIndex[holder.address] = {
      status: 'known-positive',
      balancePlanck: holder.balancePlanck,
      ...(proof === undefined ? {} : { proofId: proof.proofId, keyIndex: proof.keyIndex }),
    };
  }

  const classification: Record<string, ClassificationRecord> = {};
  for (const holder of holders)
    classification[holder.address] = {
      classification: 'unknown',
      codeLength: null,
      codeHash: null,
      source: 'not-captured',
    };
  const classBalance = {
    codePresent: '0',
    noCode: '0',
    unknown: knownSum.toString(10),
  };
  const statistics = {
    schemaVersion: 1,
    terminalState: {
      blockNumber: Number(MOONBEAM_FINAL_BLOCK_NUMBER),
      blockHash: MOONBEAM_FINAL_SUBSTRATE_BLOCK_HASH,
      stateRoot: MOONBEAM_FINAL_SUBSTRATE_STATE_ROOT,
    },
    holders: {
      knownPositive: holders.length,
      codePresent: 0,
      noCode: 0,
      unknown: holders.length,
    },
    balancePlanck: {
      totalSupply: totalSupply.toString(10),
      knownRecovered: knownSum.toString(10),
      unattributed: UNATTRIBUTED_PLANCK.toString(10),
      codePresent: classBalance.codePresent,
      noCode: classBalance.noCode,
      unknown: classBalance.unknown,
    },
    percentages: {
      byKnownRecoveredBalance: {
        codePresent: formatPercent(0n, knownSum),
        noCode: formatPercent(0n, knownSum),
        unknown: formatPercent(knownSum, knownSum),
      },
      byTotalSupply: {
        codePresent: formatPercent(0n, totalSupply),
        noCode: formatPercent(0n, totalSupply),
        unknown: formatPercent(knownSum, totalSupply),
      },
    },
    classificationStatus: 'NOT_CAPTURED',
  };
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
      classificationComplete: false,
      checkedZeroCandidateAddresses: zeroCandidates.length,
    },
    relayAnchor: { status: 'pending' },
  };

  const writes: Array<[string, string]> = [
    ['holders.jsonl', holdersJsonl],
    ['holders.json', holdersJson],
    ['holders.csv', holdersCsv],
    ['snapshot.json', json(snapshot)],
    ['statistics.json', json(statistics)],
    [
      'classification.json',
      json({ schemaVersion: 1, status: 'NOT_CAPTURED', accounts: classification }),
    ],
    ['evidence-index.json', json(evidenceIndex)],
    ['candidate-addresses.ndjson', serializeJsonl(candidateAddresses)],
    ['candidate-addresses.sha256', `${candidateAddressesSha256}\n`],
    [
      'zero-balance-candidates.ndjson',
      serializeJsonl(zeroCandidates.map((record) => ({ address: record.address }))),
    ],
  ];
  for (const [name, contents] of writes)
    await writeFile(join(dataDirectory, name), contents, 'utf8');
  await writeReleaseSums(projectRoot, dataDirectory);
  return {
    dataDirectory,
    holderCount: holders.length,
    knownSumPlanck: knownSum.toString(10),
    unattributedPlanck: UNATTRIBUTED_PLANCK.toString(10),
    candidateAddressesSha256,
  };
}

export {
  BALANCE_BATCH_SIZE,
  DEFAULT_SOURCE,
  KNOWN_SUM_PLANCK,
  UNATTRIBUTED_PLANCK,
  ZERO_ADDRESS,
  deriveTotalSupplyAccountStoragesKeyDirect,
  RANK565_HISTORICAL_BALANCE_PLANCK,
};
