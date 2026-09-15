import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceData = join(root, 'data');
const outputData = join(root, 'web', 'data');

const EXPECTED = {
  holderCount: 11785,
  knownBalance: 2334506800114108n,
  totalSupply: 2334516727484230n,
  unattributed: 9927370122n,
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readHolders() {
  return readFileSync(join(sourceData, 'holders.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function percentage(part, whole) {
  if (whole === 0n) return '0.0000000';
  const scaled = ((part * 1000000000n) / whole).toString().padStart(8, '0');
  return `${scaled.slice(0, -7) || '0'}.${scaled.slice(-7)}`;
}

function classify(value) {
  if (
    value === 'code-present' ||
    value === 'no-code' ||
    value === 'system-precompile' ||
    value === 'unknown'
  )
    return value;
  return 'unknown';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function buildStatistics(holders, classifications, snapshot, existing) {
  const sorted = [...holders].sort((a, b) => {
    const balanceOrder = BigInt(b.balancePlanck) - BigInt(a.balancePlanck);
    return balanceOrder === 0n ? a.address.localeCompare(b.address) : balanceOrder > 0n ? 1 : -1;
  });
  const knownBalance = holders.reduce((sum, holder) => sum + BigInt(holder.balancePlanck), 0n);
  const counts = { 'code-present': 0, 'no-code': 0, 'system-precompile': 0, unknown: 0 };
  const balances = { 'code-present': 0n, 'no-code': 0n, 'system-precompile': 0n, unknown: 0n };
  for (const holder of holders) {
    const type = classify(classifications[holder.address]?.classification);
    counts[type] += 1;
    balances[type] += BigInt(holder.balancePlanck);
  }

  const ascending = [...holders].sort((a, b) => {
    const difference = BigInt(a.balancePlanck) - BigInt(b.balancePlanck);
    return difference === 0n ? a.address.localeCompare(b.address) : difference > 0n ? 1 : -1;
  });
  const percentile = (fraction) =>
    BigInt(ascending[Math.floor((ascending.length - 1) * fraction)].balancePlanck);
  const bucketDefinitions = [
    ['< 0.1', 0n, 1000000000n],
    ['0.1 – 1', 1000000000n, 10000000000n],
    ['1 – 10', 10000000000n, 100000000000n],
    ['10 – 100', 100000000000n, 1000000000000n],
    ['100 – 1,000', 1000000000000n, 10000000000000n],
    ['1,000 – 10,000', 10000000000000n, 100000000000000n],
    ['>= 10,000', 100000000000000n, null],
  ];
  const buckets = bucketDefinitions.map(([label, lower, upper]) => {
    const members = holders.filter((holder) => {
      const balance = BigInt(holder.balancePlanck);
      return balance >= lower && (upper === null || balance < upper);
    });
    return {
      label,
      addressCount: members.length,
      balancePlanck: members
        .reduce((sum, holder) => sum + BigInt(holder.balancePlanck), 0n)
        .toString(),
    };
  });
  const topBalance = (count) =>
    sorted.slice(0, count).reduce((sum, holder) => sum + BigInt(holder.balancePlanck), 0n);
  const totalSupply = BigInt(
    snapshot.asset.totalSupplyPlanck ?? snapshot.recovery.totalSupplyPlanck,
  );
  const recovery = {
    knownPositiveAddresses: holders.length,
    totalSupplyPlanck: totalSupply.toString(),
    knownRecoveredPlanck: knownBalance.toString(),
    unattributedPlanck: (totalSupply - knownBalance).toString(),
  };

  return {
    schemaVersion: 2,
    snapshot: recovery,
    terminalState: snapshot.terminalState,
    classification: Object.fromEntries(
      ['code-present', 'no-code', 'system-precompile', 'unknown'].map((type) => [
        type === 'code-present'
          ? 'codePresent'
          : type === 'no-code'
            ? 'noCode'
            : type === 'system-precompile'
              ? 'systemPrecompile'
              : 'unknown',
        {
          count: counts[type],
          balancePlanck: balances[type].toString(),
          addressPercentage: percentage(BigInt(counts[type]), BigInt(holders.length)),
          knownBalancePercentage: percentage(balances[type], knownBalance),
          totalSupplyPercentage: percentage(balances[type], totalSupply),
        },
      ]),
    ),
    distribution: {
      meanPlanck: (knownBalance / BigInt(holders.length)).toString(),
      medianPlanck: percentile(0.5).toString(),
      p25Planck: percentile(0.25).toString(),
      p75Planck: percentile(0.75).toString(),
      p90Planck: percentile(0.9).toString(),
      p95Planck: percentile(0.95).toString(),
      p99Planck: percentile(0.99).toString(),
      largestPlanck: sorted[0].balancePlanck,
      buckets,
    },
    concentration: {
      top10Planck: topBalance(10).toString(),
      top100Planck: topBalance(100).toString(),
      top1000Planck: topBalance(1000).toString(),
      remainingPlanck: (knownBalance - topBalance(1000)).toString(),
    },
    classificationStatus: existing.classificationStatus,
    legacy: existing,
  };
}

function main() {
  const snapshot = readJson(join(sourceData, 'snapshot.json'));
  const existingStatistics = readJson(join(sourceData, 'statistics.json'));
  const evidenceIndex = readJson(join(sourceData, 'evidence-index.json'));
  const classificationDocument = readJson(join(sourceData, 'classification.json'));
  const classifications = classificationDocument.accounts ?? {};
  const holders = readHolders();
  const statistics = buildStatistics(holders, classifications, snapshot, existingStatistics);

  if (classificationDocument.status !== 'PASS')
    throw new Error(`WEB_BUILD_FAIL: classification status ${classificationDocument.status}`);

  const sum = holders.reduce((total, holder) => total + BigInt(holder.balancePlanck), 0n);
  const totalSupply = BigInt(
    snapshot.asset.totalSupplyPlanck ?? snapshot.recovery.totalSupplyPlanck,
  );
  if (holders.length !== EXPECTED.holderCount)
    throw new Error(`WEB_BUILD_FAIL: holder count ${holders.length}`);
  if (sum !== EXPECTED.knownBalance) throw new Error(`WEB_BUILD_FAIL: known balance ${sum}`);
  if (totalSupply !== EXPECTED.totalSupply)
    throw new Error(`WEB_BUILD_FAIL: total supply ${totalSupply}`);
  if (totalSupply - sum !== EXPECTED.unattributed)
    throw new Error('WEB_BUILD_FAIL: unattributed balance');

  const unknownCount = holders.filter(
    (holder) => classify(classifications[holder.address]?.classification) === 'unknown',
  ).length;
  if (unknownCount !== 0)
    throw new Error(`WEB_BUILD_FAIL: unknown classifications ${unknownCount}`);

  rmSync(outputData, { recursive: true, force: true });
  mkdirSync(outputData, { recursive: true });
  const holderIndex = {};
  const ranked = [...holders]
    .sort((a, b) => {
      const difference = BigInt(b.balancePlanck) - BigInt(a.balancePlanck);
      return difference === 0n ? a.address.localeCompare(b.address) : difference > 0n ? 1 : -1;
    })
    .map((holder, index) => {
      const evidence = evidenceIndex[holder.address];
      if (!evidence?.proofId || !Number.isInteger(evidence.keyIndex)) {
        throw new Error(`WEB_BUILD_FAIL: missing evidence index for ${holder.address}`);
      }
      const proofPath = join(sourceData, 'proofs', 'balance', `${evidence.proofId}.json`);
      const proof = readJson(proofPath);
      const entry = proof.keys[evidence.keyIndex];
      if (
        !entry ||
        entry.address !== holder.address ||
        entry.balancePlanck !== holder.balancePlanck
      ) {
        throw new Error(`WEB_BUILD_FAIL: evidence mismatch for ${holder.address}`);
      }
      if (
        entry.storageValue !== `0x${BigInt(holder.balancePlanck).toString(16).padStart(64, '0')}`
      ) {
        throw new Error(`WEB_BUILD_FAIL: storage mismatch for ${holder.address}`);
      }
      const classification = classify(classifications[holder.address]?.classification);
      holderIndex[holder.address] = {
        balancePlanck: holder.balancePlanck,
        classification,
        proofId: evidence.proofId,
        keyIndex: evidence.keyIndex,
      };
      return {
        rank: index + 1,
        address: holder.address,
        balancePlanck: holder.balancePlanck,
        classification,
      };
    });

  writeJson(join(outputData, 'snapshot.json'), snapshot);
  writeJson(join(outputData, 'statistics.json'), statistics);
  writeJson(join(outputData, 'holders-index.json'), holderIndex);
  writeJson(join(outputData, 'holders-ranked.json'), ranked);
  writeJson(join(outputData, 'evidence-index.json'), evidenceIndex);
  writeJson(join(outputData, 'manifest.json'), {
    schemaVersion: 1,
    snapshotId: snapshot.snapshotId,
    sourceCommit: '20eaffd',
    staticOnly: true,
    candidateDigest: readFileSync(join(sourceData, 'candidate-addresses.sha256'), 'utf8').trim(),
    holdersDigest: sha256(readFileSync(join(sourceData, 'holders.jsonl'))),
  });
  for (const name of ['holders.csv', 'holders.jsonl'])
    cpSync(join(sourceData, name), join(outputData, name));
  mkdirSync(join(outputData, 'proofs', 'balance'), { recursive: true });
  cpSync(join(sourceData, 'proofs', 'balance'), join(outputData, 'proofs', 'balance'), {
    recursive: true,
  });
  cpSync(join(root, 'SHA256SUMS'), join(outputData, 'SHA256SUMS'));
  cpSync(join(root, 'web', 'index.html'), join(root, 'web', '404.html'));

  console.log(`WEB_BUILD=PASS`);
  console.log(`KNOWN_HOLDER_COUNT=${holders.length}`);
  console.log(`KNOWN_BALANCE_SUM_PLANCK=${sum}`);
  console.log(`TOTAL_SUPPLY_PLANCK=${totalSupply}`);
  console.log(`UNATTRIBUTED_PLANCK=${totalSupply - sum}`);
  console.log(`PROOF_INDEX=PASS`);
  console.log(`CLASSIFICATION_STATUS=${classificationDocument.status}`);
  console.log(`CONTRACT_COUNT=${statistics.classification.codePresent.count}`);
  console.log(`EOA_COUNT=${statistics.classification.noCode.count}`);
  console.log(`SYSTEM_COUNT=${statistics.classification.systemPrecompile.count}`);
  console.log(`UNKNOWN_COUNT=${unknownCount}`);
}

main();
