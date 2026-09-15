const DATA = './data/';
const BASE_PATH = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const state = { snapshot: null, statistics: null, holders: {}, ranked: [], evidence: new Map() };
const $ = (selector) => document.querySelector(selector);

function formatPlanck(value, decimals = 10) {
  const amount = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = amount % base;
  if (fraction === 0n) return whole.toLocaleString('en-US');
  return `${whole.toLocaleString('en-US')}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

function percent(part, total) {
  if (BigInt(total) === 0n) return '0.00%';
  const scaled = (BigInt(part) * 10000n) / BigInt(total);
  const digits = scaled.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}%`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

function shortHash(value, start = 10, end = 8) {
  const text = String(value);
  return `${text.slice(0, start)}…${text.slice(-end)}`;
}

function shortAddress(value) {
  return shortHash(value, 8, 6);
}

async function loadJson(path) {
  const response = await fetch(`${DATA}${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  window.setTimeout(() => toast.classList.remove('visible'), 1800);
}

async function copyText(value, message = 'Copied') {
  await navigator.clipboard.writeText(value);
  showToast(message);
}

function copyButton(value, label = 'Copy') {
  return `<button class="text-button" data-copy="${escapeHtml(value)}" aria-label="${label}">${label}</button>`;
}

function header(active) {
  return `<header class="site-header"><a class="brand" href="./">xcDOT Terminal Snapshot</a><nav aria-label="Primary navigation"><a class="${active === 'home' ? 'active' : ''}" href="./">Home</a><a class="${active === 'statistics' ? 'active' : ''}" href="./statistics">Statistics</a><a class="${active === 'top' ? 'active' : ''}" href="./top">Top</a></nav><div class="header-meta"><span>Moonbeam #${Number(state.snapshot.terminalState.blockNumber).toLocaleString()}</span><span class="badge verified">Verified Snapshot</span></div></header>`;
}

function footer() {
  const recovery = state.snapshot.recovery;
  return `<footer class="site-footer"><div class="footer-meta"><strong>Moonbeam terminal block #${Number(state.snapshot.terminalState.blockNumber).toLocaleString()}</strong><span>${recovery.positiveHolderAddresses.toLocaleString()} known non-zero addresses</span><span>${formatPlanck(recovery.unattributedPlanck)} xcDOT remains unattributed</span><span>Static snapshot · ${escapeHtml(state.snapshot.snapshotId)}</span></div><div class="footer-links"><a href="https://github.com/libingjiang47/xcdot-recovery-kit">GitHub repository</a><a href="./data/holders.csv" download>Download CSV</a><a href="./data/holders.jsonl" download>Download JSONL</a><a href="./data/manifest.json" download>Download manifest</a><a href="./data/SHA256SUMS" download>SHA256SUMS</a></div></footer>`;
}

function summaryCards() {
  const recovery = state.snapshot.recovery;
  return `<section class="summary-grid" aria-label="Snapshot summary"><article class="stat-card"><span>Known Addresses</span><strong>${recovery.positiveHolderAddresses.toLocaleString()}</strong><small>known non-zero</small></article><article class="stat-card"><span>Known Recovered</span><strong>${formatPlanck(recovery.knownBalancePlanck)}</strong><small>xcDOT</small></article><article class="stat-card"><span>Total Supply</span><strong>${formatPlanck(recovery.totalSupplyPlanck)}</strong><small>xcDOT</small></article><article class="stat-card warning"><span>Unattributed</span><strong>${formatPlanck(recovery.unattributedPlanck)}</strong><small>xcDOT</small></article></section>`;
}

function resultFor(address) {
  const normalized = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) return { error: 'Invalid EVM address.' };
  const holder = state.holders[normalized];
  return holder ? { address: normalized, holder } : { missing: true, address: normalized };
}

function lookupForm() {
  const terminal = state.snapshot.terminalState;
  return `<section class="panel search-panel"><div class="section-heading"><h2>Find an xcDOT balance</h2></div><form id="lookup-form"><label class="sr-only" for="address-input">EVM address</label><div class="search-row"><input id="address-input" autocomplete="off" inputmode="text" placeholder="Enter a 0x address" /><button type="submit">Search</button></div></form><div class="terminal-context"><div><span>Moonbeam block</span><strong>${Number(terminal.blockNumber).toLocaleString()}</strong></div><div><span>State root</span><div><code title="${terminal.stateRoot}">${shortHash(terminal.stateRoot)}</code> ${copyButton(terminal.stateRoot)}</div></div></div><div id="lookup-result" class="lookup-placeholder">Enter a canonical H160 address.</div></section>`;
}

function notFound(result) {
  return `<div class="notice"><strong>No non-zero balance record was found</strong><p>There is no record for <code>${escapeHtml(result.address)}</code> in the recovered snapshot.</p><p>This does not prove that the address had a zero terminal balance.</p><p>${formatPlanck(state.snapshot.recovery.unattributedPlanck)} xcDOT remains unattributed.</p></div>`;
}

function evidencePanel(result, proof) {
  if (!proof)
    return '<div class="evidence-unavailable">Evidence file unavailable. The frozen balance remains available, but proof details could not be loaded.</div>';
  const entry = proof.keys[result.holder.keyIndex];
  if (
    !entry ||
    entry.address !== result.address ||
    entry.balancePlanck !== result.holder.balancePlanck
  )
    return '<div class="evidence-unavailable">Evidence file unavailable.</div>';
  return `<div class="evidence-panel"><div class="evidence-summary"><div><span>Proof Status</span><strong class="good">Verified</strong><small>The stored proof was verified offline against the frozen terminal state root.</small></div><div><span>State Root</span><code>${shortHash(state.snapshot.terminalState.stateRoot)}</code></div><div><span>Proof Bundle</span><code>${proof.proofId}</code></div></div><details><summary>Show technical details</summary><dl class="details"><dt>Block hash</dt><dd><code>${state.snapshot.terminalState.blockHash}</code> ${copyButton(state.snapshot.terminalState.blockHash)}</dd><dt>State root</dt><dd><code>${state.snapshot.terminalState.stateRoot}</code> ${copyButton(state.snapshot.terminalState.stateRoot)}</dd><dt>Solidity storage slot</dt><dd><code>${entry.solidityStorageSlot}</code> ${copyButton(entry.solidityStorageSlot)}</dd><dt>Substrate storage key</dt><dd><code>${entry.substrateStorageKey}</code> ${copyButton(entry.substrateStorageKey)}</dd><dt>Raw storage value</dt><dd><code>${entry.storageValue}</code> ${copyButton(entry.storageValue)}</dd><dt>Proof key index</dt><dd>${result.holder.keyIndex}</dd></dl></details><div class="evidence-actions"><button data-evidence-action="copy">Copy Evidence</button><button class="secondary" data-evidence-action="download">Download Evidence</button></div></div>`;
}

function renderResult(result) {
  const target = $('#lookup-result');
  if (result.error) {
    target.className = 'lookup-result error';
    target.textContent = result.error;
    return;
  }
  if (result.missing) {
    target.className = 'lookup-result';
    target.innerHTML = notFound(result);
    return;
  }
  target.className = 'lookup-result';
  const { holder } = result;
  target.innerHTML = `<div class="balance-result"><div class="result-top"><div><span class="address-label">${shortAddress(result.address)}</span><button class="text-button" data-copy="${result.address}">Copy address</button></div></div><strong class="balance">${formatPlanck(holder.balancePlanck)} <small>xcDOT</small></strong><dl class="result-fields"><dt>Planck</dt><dd>${holder.balancePlanck}</dd><dt>Proof Status</dt><dd id="proof-loading">Loading frozen proof…</dd><dt>Terminal Block</dt><dd>${Number(state.snapshot.terminalState.blockNumber).toLocaleString()}</dd></dl></div><div id="evidence-result" class="evidence-wrap"><p class="muted">Loading evidence bundle…</p></div>`;
  wireGlobalCopy();
  loadEvidence(result);
}

function makeEvidence(result, proof) {
  const entry = proof.keys[result.holder.keyIndex];
  return {
    schemaVersion: 2,
    snapshot: {
      id: state.snapshot.snapshotId,
      blockNumber: state.snapshot.terminalState.blockNumber,
      blockHash: state.snapshot.terminalState.blockHash,
      stateRoot: state.snapshot.terminalState.stateRoot,
    },
    asset: {
      symbol: state.snapshot.asset.symbol,
      contract: state.snapshot.asset.contract,
      decimals: state.snapshot.asset.decimals,
    },
    holder: {
      address: result.address,
      balancePlanck: result.holder.balancePlanck,
      balanceXcDOT: formatPlanck(result.holder.balancePlanck),
    },
    storage: {
      solidityStorageSlot: entry.solidityStorageSlot,
      substrateStorageKey: entry.substrateStorageKey,
      storageValue: entry.storageValue,
    },
    proof: { type: 'substrate-state_getReadProof', verifiedOffline: true, nodes: proof.proofNodes },
  };
}

async function loadEvidence(result) {
  const meta = result.holder;
  let proof = state.evidence.get(meta.proofId);
  if (!proof) {
    try {
      proof = await loadJson(`proofs/balance/${meta.proofId}.json`);
      state.evidence.set(meta.proofId, proof);
    } catch {
      $('#proof-loading').textContent = 'Unavailable';
      $('#evidence-result').innerHTML = evidencePanel(result, null);
      return;
    }
  }
  $('#proof-loading').textContent = 'Verified';
  $('#proof-loading').className = 'good';
  $('#evidence-result').innerHTML = evidencePanel(result, proof);
  wireGlobalCopy();
  for (const button of document.querySelectorAll('[data-evidence-action]'))
    button.addEventListener('click', async () => {
      const serialized = JSON.stringify(makeEvidence(result, proof), null, 2);
      if (button.dataset.evidenceAction === 'copy') await copyText(serialized, 'Evidence copied');
      else {
        const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `xcdot-evidence-${result.address}.json`;
        link.click();
        URL.revokeObjectURL(url);
        showToast('Evidence downloaded');
      }
    });
}

function wireGlobalCopy() {
  for (const button of document.querySelectorAll('[data-copy]')) {
    if (button.dataset.copyBound) continue;
    button.dataset.copyBound = 'true';
    button.addEventListener('click', () => copyText(button.dataset.copy));
  }
}

function renderHome() {
  $('#app').innerHTML = `${header('home')}<main>${lookupForm()}${summaryCards()}</main>${footer()}`;
  wireGlobalCopy();
  const input = $('#address-input');
  const query = new URLSearchParams(location.search).get('address');
  $('#lookup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    history.pushState({}, '', value ? `./?address=${encodeURIComponent(value)}` : './');
    renderResult(resultFor(value));
  });
  if (query) {
    input.value = query;
    renderResult(resultFor(query));
  }
}

function metricCards() {
  const summary = state.statistics.snapshot;
  return `<section class="summary-grid"><article class="stat-card"><span>Known Addresses</span><strong>${summary.knownPositiveAddresses.toLocaleString()}</strong></article><article class="stat-card"><span>Known Recovered</span><strong>${formatPlanck(summary.knownRecoveredPlanck)}</strong><small>xcDOT</small></article><article class="stat-card"><span>Total Supply</span><strong>${formatPlanck(summary.totalSupplyPlanck)}</strong><small>xcDOT</small></article><article class="stat-card warning"><span>Unattributed</span><strong>${formatPlanck(summary.unattributedPlanck)}</strong><small>xcDOT</small></article></section>`;
}

function statBar(label, value, total, detail) {
  const width = Math.min(100, Number((BigInt(value) * 10000n) / BigInt(total)) / 100);
  return `<div class="bar-row"><div><span>${label}</span><strong>${detail}</strong></div><div class="bar"><i style="width:${width}%"></i></div></div>`;
}

function renderStatistics() {
  const stats = state.statistics;
  const totalSupply = stats.snapshot.totalSupplyPlanck;
  const distribution = stats.distribution;
  const concentration = stats.concentration;
  const maxBucket = Math.max(...distribution.buckets.map((item) => item.addressCount), 1);
  $('#app').innerHTML =
    `${header('statistics')}<main><section class="page-heading"><p class="eyebrow">Frozen snapshot analysis</p><h1>Statistics</h1><p class="lede">A build-time summary of the known non-zero addresses in the terminal snapshot.</p></section>${metricCards()}<section class="two-column"><section class="panel"><div class="section-heading"><div><p class="eyebrow">Distribution</p><h2>Holder balance distribution</h2></div><span class="muted">xcDOT per address</span></div><div class="histogram">${distribution.buckets.map((bucket) => `<div class="histogram-col"><div class="histogram-bar" style="height:${Math.max(6, (bucket.addressCount / maxBucket) * 100)}%" title="${bucket.addressCount.toLocaleString()} addresses"></div><span>${bucket.label}</span><small>${bucket.addressCount.toLocaleString()}</small></div>`).join('')}</div></section><section class="panel"><div class="section-heading"><div><p class="eyebrow">Concentration</p><h2>Known balance concentration</h2></div><span class="muted">share of known recovered balance</span></div>${statBar('Top 10', concentration.top10Planck, totalSupply, `${formatPlanck(concentration.top10Planck)} xcDOT · ${percent(concentration.top10Planck, totalSupply)}`)}${statBar('Top 100', concentration.top100Planck, totalSupply, `${formatPlanck(concentration.top100Planck)} xcDOT · ${percent(concentration.top100Planck, totalSupply)}`)}${statBar('Top 1,000', concentration.top1000Planck, totalSupply, `${formatPlanck(concentration.top1000Planck)} xcDOT · ${percent(concentration.top1000Planck, totalSupply)}`)}${statBar('Remaining', concentration.remainingPlanck, totalSupply, `${formatPlanck(concentration.remainingPlanck)} xcDOT · ${percent(concentration.remainingPlanck, totalSupply)}`)}</section></section></main>${footer()}`;
}

function updateTopUrl(page, size, query) {
  const params = new URLSearchParams();
  if (page !== 1) params.set('page', page);
  if (size !== 50) params.set('size', size);
  if (query) params.set('q', query);
  history.replaceState({}, '', `./top${params.toString() ? `?${params}` : ''}`);
}

function renderTop() {
  const params = new URLSearchParams(location.search);
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const size = [25, 50, 100].includes(Number(params.get('size'))) ? Number(params.get('size')) : 50;
  const query = (params.get('q') ?? '').toLowerCase();
  const filtered = state.ranked.filter((holder) => holder.address.includes(query));
  const pageCount = Math.max(1, Math.ceil(filtered.length / size));
  const currentPage = Math.min(page, pageCount);
  const rows = filtered.slice((currentPage - 1) * size, currentPage * size);
  const totalSupply = state.snapshot.recovery.totalSupplyPlanck;
  $('#app').innerHTML =
    `${header('top')}<main><section class="page-heading"><p class="eyebrow">Known non-zero addresses</p><h1>Top xcDOT Holders</h1><p class="lede">Known non-zero addresses at Moonbeam terminal block #${Number(state.snapshot.terminalState.blockNumber).toLocaleString()}.</p></section><section class="panel top-controls"><label class="filter-search"><span class="sr-only">Filter address</span><input id="top-query" value="${escapeHtml(query)}" placeholder="Filter address" /></label><label class="page-size">Rows <select id="page-size"><option ${size === 25 ? 'selected' : ''}>25</option><option ${size === 50 ? 'selected' : ''}>50</option><option ${size === 100 ? 'selected' : ''}>100</option></select></label></section><section class="panel table-panel"><div class="table-meta"><span>${filtered.length.toLocaleString()} matching addresses</span><span>Page ${currentPage} of ${pageCount}</span></div><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Address</th><th>Balance</th><th>Share</th></tr></thead><tbody>${rows.map((holder) => `<tr><td>#${holder.rank}</td><td><a class="address-link" href="./?address=${holder.address}" title="${holder.address}">${shortAddress(holder.address)}</a> ${copyButton(holder.address, 'Copy')}</td><td><strong>${formatPlanck(holder.balancePlanck)}</strong> xcDOT</td><td>${percent(holder.balancePlanck, totalSupply)}</td></tr>`).join('')}</tbody></table></div><div class="pagination"><button class="secondary" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>Previous</button><span>${currentPage} / ${pageCount}</span><button class="secondary" data-page="${currentPage + 1}" ${currentPage === pageCount ? 'disabled' : ''}>Next</button></div></section></main>${footer()}`;
  $('#top-query').addEventListener('input', (event) => {
    updateTopUrl(1, size, event.target.value.toLowerCase());
    renderTop();
  });
  $('#page-size').addEventListener('change', (event) => {
    updateTopUrl(1, Number(event.target.value), query);
    renderTop();
  });
  for (const button of document.querySelectorAll('[data-page]'))
    button.addEventListener('click', () => {
      updateTopUrl(Number(button.dataset.page), size, query);
      renderTop();
    });
  wireGlobalCopy();
}

function render() {
  const path = location.pathname.slice(BASE_PATH.length).replace(/\/$/, '') || '/';
  if (path === '/statistics') renderStatistics();
  else if (path === '/top') renderTop();
  else renderHome();
}

async function main() {
  [state.snapshot, state.statistics, state.holders, state.ranked] = await Promise.all([
    loadJson('snapshot.json'),
    loadJson('statistics.json'),
    loadJson('holders-index.json'),
    loadJson('holders-ranked.json'),
  ]);
  render();
}

window.addEventListener('popstate', render);
main().catch(() => {
  $('#app').innerHTML =
    '<main class="fatal"><h1>Snapshot data could not be loaded.</h1><p>The static evidence files are unavailable. No live RPC fallback is used.</p></main>';
});
