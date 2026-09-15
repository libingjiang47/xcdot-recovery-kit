const DATA = '../data/';
const state = {
  snapshot: null,
  statistics: null,
  index: {},
  classifications: {},
  holders: new Map(),
};

function formatUnits(value, decimals = 10) {
  const amount = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = amount % base;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

async function json(path) {
  return fetch(`${DATA}${path}`).then((response) => {
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  });
}
async function text(path) {
  return fetch(`${DATA}${path}`).then((response) => {
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.text();
  });
}

function renderSummary() {
  const snapshot = state.snapshot;
  const recovery = snapshot.recovery;
  document.querySelector('#block-number').textContent = Number(
    snapshot.terminalState.blockNumber,
  ).toLocaleString();
  document.querySelector('#snapshot-id').textContent = snapshot.snapshotId;
  document.querySelector('#state-root').textContent = snapshot.terminalState.stateRoot;
  document.querySelector('#holder-count').textContent =
    recovery.positiveHolderAddresses.toLocaleString();
  document.querySelector('#known-recovered').textContent = formatUnits(recovery.knownBalancePlanck);
  document.querySelector('#total-supply').textContent = formatUnits(recovery.totalSupplyPlanck);
  document.querySelector('#unattributed').textContent = formatUnits(recovery.unattributedPlanck);
  const proof = snapshot.proofStatus;
  document.querySelector('#proof-status').textContent =
    `proofs: ${proof.knownBalanceProofsVerified ? 'verified' : 'captured/verification pending'}`;
  const stats = state.statistics;
  const classes = ['codePresent', 'noCode', 'unknown'];
  document.querySelector('#stats-result').innerHTML = classes
    .map(
      (key) =>
        `<div class="stat"><span>${key}</span><strong>${stats.holders[key].toLocaleString()} addresses</strong><span>${formatUnits(stats.balancePlanck[key])} xcDOT</span><small>${stats.percentages.byTotalSupply[key]}% of total supply</small></div>`,
    )
    .join('');
}

function resultFor(address) {
  const normalized = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) return { error: 'Invalid H160 address.' };
  const holder = state.holders.get(normalized);
  if (!holder) return { missing: true, address: normalized };
  return {
    address: normalized,
    holder,
    classification: state.classifications[normalized] ?? { classification: 'unknown' },
    evidence: state.index[normalized],
  };
}

function renderLookup(result) {
  const target = document.querySelector('#lookup-result');
  if (result.error) {
    target.className = 'result bad';
    target.textContent = result.error;
    return;
  }
  if (result.missing) {
    target.className = 'result bad';
    target.innerHTML = `<p>No non-zero balance record was found for <code>${escapeHtml(result.address)}</code>.</p><p>That does not prove a terminal-state balance of zero. The current dataset has ${formatUnits(state.snapshot.recovery.unattributedPlanck)} xcDOT unattributed.</p>`;
    return;
  }
  const classification = result.classification.classification ?? 'unknown';
  const evidence = result.evidence?.proofId ? 'available' : 'not captured';
  target.className = 'result';
  target.innerHTML = `<dl class="result-card"><dt>Address</dt><dd><code>${result.address}</code></dd><dt>Balance</dt><dd><strong>${formatUnits(result.holder.balancePlanck)} xcDOT</strong> (${result.holder.balancePlanck} planck)</dd><dt>Classification</dt><dd>${escapeHtml(classification)}</dd><dt>Terminal block</dt><dd>${Number(state.snapshot.terminalState.blockNumber).toLocaleString()}</dd><dt>State root</dt><dd><code>${state.snapshot.terminalState.stateRoot}</code></dd><dt>Proof</dt><dd>${evidence}${evidence === 'available' ? ` · <button id="copy-evidence">Copy Evidence</button>` : ''}</dd></dl>`;
  if (result.evidence?.proofId)
    document.querySelector('#copy-evidence').addEventListener('click', () => copyEvidence(result));
}

async function copyEvidence(result) {
  const proof = await json(`proofs/balance/${result.evidence.proofId}.json`);
  const entry = proof.keys[result.evidence.keyIndex];
  const evidence = {
    schemaVersion: 1,
    asset: {
      symbol: 'xcDOT',
      contract: state.snapshot.asset.contract,
      decimals: state.snapshot.asset.decimals,
    },
    terminalState: state.snapshot.terminalState,
    holder: {
      address: result.address,
      balancePlanck: result.holder.balancePlanck,
      balanceXcDOT: formatUnits(result.holder.balancePlanck),
    },
    storage: {
      soliditySlot: entry.solidityStorageSlot,
      substrateKey: entry.substrateStorageKey,
      value: entry.storageValue,
    },
    proof: { type: 'substrate-state_getReadProof', nodes: proof.proofNodes },
  };
  await navigator.clipboard.writeText(JSON.stringify(evidence, null, 2));
  document.querySelector('#copy-evidence').textContent = 'Copied';
}

function addressesFromText(value) {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}
function renderBatch() {
  const rows = addressesFromText(document.querySelector('#batch-input').value).map(resultFor);
  document.querySelector('#batch-result').innerHTML =
    rows.length === 0
      ? ''
      : `<table><thead><tr><th>Address</th><th>Status</th><th>Balance</th><th>Classification</th></tr></thead><tbody>${rows.map((row) => (row.error ? `<tr><td>${escapeHtml(row.error)}</td><td>invalid-address</td><td>—</td><td>—</td></tr>` : row.missing ? `<tr><td><code>${row.address}</code></td><td>not-in-recovered-snapshot</td><td>—</td><td>—</td></tr>` : `<tr><td><code>${row.address}</code></td><td>known-positive</td><td>${formatUnits(row.holder.balancePlanck)}</td><td>${escapeHtml(row.classification.classification ?? 'unknown')}</td></tr>`)).join('')}</tbody></table>`;
}

async function main() {
  const [snapshot, statistics, index, classifications, holdersText] = await Promise.all([
    json('snapshot.json'),
    json('statistics.json'),
    json('evidence-index.json'),
    json('classification.json'),
    text('holders.jsonl'),
  ]);
  state.snapshot = snapshot;
  state.statistics = statistics;
  state.index = index;
  state.classifications = classifications.accounts ?? {};
  for (const line of holdersText.trim().split('\n')) {
    if (!line) continue;
    const holder = JSON.parse(line);
    state.holders.set(holder.address, holder);
  }
  renderSummary();
  document
    .querySelector('#lookup-button')
    .addEventListener('click', () =>
      renderLookup(resultFor(document.querySelector('#address-input').value)),
    );
  document.querySelector('#address-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') renderLookup(resultFor(event.target.value));
  });
  document.querySelector('#batch-button').addEventListener('click', renderBatch);
}

main().catch((error) => {
  document.querySelector('#lookup-result').className = 'result bad';
  document.querySelector('#lookup-result').textContent =
    `Local snapshot could not be loaded: ${error.message}`;
});
