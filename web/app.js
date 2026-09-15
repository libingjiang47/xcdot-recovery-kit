import { SUPPORTED_LOCALES, getLocale, htmlLanguage, resolveLocale, setLocale, t } from './i18n.js';

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

function applyLocale() {
  document.documentElement.lang = htmlLanguage(getLocale());
  document.title = t('meta.title');
}

function showToast(message) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('visible');
  window.setTimeout(() => toast.classList.remove('visible'), 1800);
}

async function copyText(value, message = t('toast.copied')) {
  await navigator.clipboard.writeText(value);
  showToast(message);
}

function copyableCode(
  value,
  { display = value, message = t('toast.copied'), className = '' } = {},
) {
  return `<button type="button" class="copyable-code ${escapeHtml(className)}" data-copy="${escapeHtml(value)}" data-copy-message="${escapeHtml(message)}" title="${escapeHtml(t('common.clickToCopy'))}" aria-label="${escapeHtml(t('common.clickToCopy'))}"><code>${escapeHtml(display)}</code></button>`;
}

function socialIcon(kind) {
  if (kind === 'x')
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 2H22l-6.77 7.74L23.2 22h-6.25l-4.9-6.41L6.45 22H3.3l7.24-8.28L2.8 2h6.4l4.43 5.85L18.9 2Zm-1.1 17.8h1.73L8.27 4.1H6.42L17.8 19.8Z"/></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2a9.8 9.8 0 0 0-3.1 19.1c.49.09.67-.21.67-.47v-1.83c-2.73.59-3.3-1.16-3.3-1.16-.45-1.14-1.1-1.44-1.1-1.44-.9-.62.07-.61.07-.61 1 .07 1.53 1.02 1.53 1.02.88 1.52 2.3 1.08 2.86.83.09-.64.34-1.08.62-1.33-2.18-.25-4.47-1.09-4.47-4.85 0-1.07.38-1.94 1.02-2.63-.1-.25-.44-1.25.1-2.6 0 0 .83-.27 2.7 1.01A9.4 9.4 0 0 1 12 6.9c.84 0 1.68.11 2.47.34 1.87-1.28 2.7-1.01 2.7-1.01.54 1.35.2 2.35.1 2.6.64.69 1.02 1.56 1.02 2.63 0 3.77-2.3 4.6-4.49 4.84.35.31.66.92.66 1.85v2.73c0 .27.18.57.68.47A9.8 9.8 0 0 0 12 2.2Z"/></svg>';
}

function languageSelector() {
  const labels = {
    en: 'English',
    'zh-CN': '简体中文',
    ja: '日本語',
    de: 'Deutsch',
    fr: 'Français',
  };
  return `<label class="language-picker"><span class="sr-only">${escapeHtml(t('nav.language'))}</span><select id="language-select" aria-label="${escapeHtml(t('nav.language'))}">${SUPPORTED_LOCALES.map((locale) => `<option value="${locale}" ${locale === getLocale() ? 'selected' : ''}>${labels[locale]}</option>`).join('')}</select></label>`;
}

function header(active) {
  const block = Number(state.snapshot.terminalState.blockNumber).toLocaleString('en-US');
  return `<header class="site-header"><a class="brand" href="./">xcDOT Terminal Snapshot</a><nav aria-label="${escapeHtml(t('nav.primary'))}"><a class="${active === 'home' ? 'active' : ''}" href="./">${escapeHtml(t('nav.home'))}</a><a class="${active === 'statistics' ? 'active' : ''}" href="./statistics">${escapeHtml(t('nav.statistics'))}</a><a class="${active === 'top' ? 'active' : ''}" href="./top">${escapeHtml(t('nav.top'))}</a></nav><div class="header-meta"><span>Moonbeam #${block}</span><span class="badge verified">${escapeHtml(t('header.verifiedSnapshot'))}</span></div><div class="header-actions">${languageSelector()}<a class="icon-link" href="https://x.com/libingjiang47" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(t('nav.x'))}" title="${escapeHtml(t('nav.x'))}">${socialIcon('x')}</a><a class="icon-link" href="https://github.com/libingjiang47/xcdot-recovery-kit" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(t('nav.github'))}" title="${escapeHtml(t('nav.github'))}">${socialIcon('github')}</a></div></header>`;
}

function footer() {
  const recovery = state.snapshot.recovery;
  const block = Number(state.snapshot.terminalState.blockNumber).toLocaleString('en-US');
  return `<footer class="site-footer"><div class="footer-meta"><strong>${escapeHtml(t('footer.terminalBlock', { block }))}</strong><span>${escapeHtml(t('footer.knownAddresses', { count: recovery.positiveHolderAddresses.toLocaleString('en-US') }))}</span><span>${escapeHtml(t('footer.unattributed', { amount: formatPlanck(recovery.unattributedPlanck) }))}</span><span>${escapeHtml(t('footer.staticSnapshot', { id: state.snapshot.snapshotId }))}</span></div><div class="footer-links"><a href="https://github.com/libingjiang47/xcdot-recovery-kit" target="_blank" rel="noopener noreferrer">${escapeHtml(t('footer.github'))}</a><a href="./data/holders.csv" download>${escapeHtml(t('footer.downloadCsv'))}</a><a href="./data/holders.jsonl" download>${escapeHtml(t('footer.downloadJsonl'))}</a><a href="./data/manifest.json" download>${escapeHtml(t('footer.downloadManifest'))}</a><a href="./data/SHA256SUMS" download>${escapeHtml(t('footer.sha256'))}</a></div></footer>`;
}

function resultFor(address) {
  const normalized = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) return { error: true };
  const holder = state.holders[normalized];
  return holder ? { address: normalized, holder } : { missing: true, address: normalized };
}

function lookupForm() {
  const terminal = state.snapshot.terminalState;
  return `<section class="panel search-panel"><div class="section-heading"><h2>${escapeHtml(t('search.title'))}</h2></div><form id="lookup-form"><label class="sr-only" for="address-input">${escapeHtml(t('search.addressPlaceholder'))}</label><div class="search-row"><input id="address-input" autocomplete="off" inputmode="text" placeholder="${escapeHtml(t('search.addressPlaceholder'))}" /><button type="submit">${escapeHtml(t('search.button'))}</button></div></form><div class="terminal-context"><div><span>${escapeHtml(t('search.moonbeamBlock'))}</span><strong>${Number(terminal.blockNumber).toLocaleString('en-US')}</strong></div><div><span>${escapeHtml(t('search.stateRoot'))}</span>${copyableCode(terminal.stateRoot, { display: shortHash(terminal.stateRoot), message: t('toast.stateRootCopied'), className: 'compact' })}</div></div><div id="lookup-result"></div></section>`;
}

function notFound(result) {
  const address = `<code>${escapeHtml(result.address)}</code>`;
  return `<div class="notice"><strong>${escapeHtml(t('notFound.title'))}</strong><p>${t('notFound.detail', { address })}</p><p>${escapeHtml(t('notFound.zeroWarning'))}</p><p>${escapeHtml(t('notFound.unattributed', { amount: formatPlanck(state.snapshot.recovery.unattributedPlanck) }))}</p></div>`;
}

function evidencePanel(result, proof) {
  if (!proof)
    return `<div class="evidence-unavailable">${escapeHtml(t('evidence.unavailable'))}</div>`;
  const entry = proof.keys[result.holder.keyIndex];
  if (
    !entry ||
    entry.address !== result.address ||
    entry.balancePlanck !== result.holder.balancePlanck
  )
    return `<div class="evidence-unavailable">${escapeHtml(t('evidence.unavailable'))}</div>`;
  return `<div class="evidence-panel"><div class="evidence-summary"><div><span>${escapeHtml(t('result.proofStatus'))}</span><strong class="good">${escapeHtml(t('result.verified'))}</strong><small>${escapeHtml(t('evidence.verifiedDescription'))}</small></div><div><span>${escapeHtml(t('evidence.stateRoot'))}</span>${copyableCode(state.snapshot.terminalState.stateRoot, { display: shortHash(state.snapshot.terminalState.stateRoot), message: t('toast.stateRootCopied') })}</div><div><span>${escapeHtml(t('evidence.proofBundle'))}</span><code>${proof.proofId}</code></div></div><details><summary>${escapeHtml(t('evidence.showTechnicalDetails'))}</summary><dl class="details"><dt>${escapeHtml(t('evidence.blockHash'))}</dt><dd>${copyableCode(state.snapshot.terminalState.blockHash, { message: t('toast.blockHashCopied') })}</dd><dt>${escapeHtml(t('evidence.stateRoot'))}</dt><dd>${copyableCode(state.snapshot.terminalState.stateRoot, { message: t('toast.stateRootCopied') })}</dd><dt>${escapeHtml(t('evidence.solidityStorageSlot'))}</dt><dd>${copyableCode(entry.solidityStorageSlot, { message: t('toast.storageSlotCopied') })}</dd><dt>${escapeHtml(t('evidence.substrateStorageKey'))}</dt><dd>${copyableCode(entry.substrateStorageKey, { message: t('toast.storageKeyCopied') })}</dd><dt>${escapeHtml(t('evidence.rawStorageValue'))}</dt><dd>${copyableCode(entry.storageValue, { message: t('toast.storageValueCopied') })}</dd><dt>${escapeHtml(t('evidence.proofKeyIndex'))}</dt><dd>${result.holder.keyIndex}</dd></dl></details><div class="evidence-actions"><button type="button" data-evidence-action="copy">${escapeHtml(t('evidence.copy'))}</button><button type="button" class="secondary" data-evidence-action="download">${escapeHtml(t('evidence.download'))}</button></div></div>`;
}

function renderResult(result) {
  const target = $('#lookup-result');
  if (result.error) {
    target.className = 'lookup-result error';
    target.textContent = t('search.invalidAddress');
    return;
  }
  if (result.missing) {
    target.className = 'lookup-result';
    target.innerHTML = notFound(result);
    return;
  }
  const { holder } = result;
  target.className = 'lookup-result';
  target.innerHTML = `<div class="balance-result"><div class="result-top">${copyableCode(result.address, { display: shortAddress(result.address), message: t('toast.addressCopied'), className: 'address-label' })}</div><strong class="balance">${formatPlanck(holder.balancePlanck)} <small>xcDOT</small></strong><dl class="result-fields"><dt>${escapeHtml(t('result.planck'))}</dt><dd>${holder.balancePlanck}</dd><dt>${escapeHtml(t('result.proofStatus'))}</dt><dd id="proof-loading">${escapeHtml(t('result.loadingProof'))}</dd><dt>${escapeHtml(t('result.terminalBlock'))}</dt><dd>${Number(state.snapshot.terminalState.blockNumber).toLocaleString('en-US')}</dd></dl></div><div id="evidence-result" class="evidence-wrap"><p class="muted">${escapeHtml(t('result.loadingProof'))}</p></div>`;
  wireGlobalCopy();
  void loadEvidence(result);
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
      const loading = $('#proof-loading');
      if (loading) loading.textContent = t('result.unavailable');
      const evidence = $('#evidence-result');
      if (evidence) evidence.innerHTML = evidencePanel(result, null);
      return;
    }
  }
  const loading = $('#proof-loading');
  if (!loading) return;
  loading.textContent = t('result.verified');
  loading.className = 'good';
  const evidence = $('#evidence-result');
  evidence.innerHTML = evidencePanel(result, proof);
  wireGlobalCopy();
  for (const button of evidence.querySelectorAll('[data-evidence-action]'))
    button.addEventListener('click', async () => {
      const serialized = JSON.stringify(makeEvidence(result, proof), null, 2);
      if (button.dataset.evidenceAction === 'copy')
        await copyText(serialized, t('evidence.copied'));
      else {
        const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `xcdot-evidence-${result.address}.json`;
        link.click();
        URL.revokeObjectURL(url);
        showToast(t('evidence.downloaded'));
      }
    });
}

function wireGlobalCopy() {
  for (const button of document.querySelectorAll('[data-copy]')) {
    if (button.dataset.copyBound) continue;
    button.dataset.copyBound = 'true';
    button.addEventListener('click', () =>
      copyText(button.dataset.copy, button.dataset.copyMessage || t('toast.copied')),
    );
  }
}

function wireHeaderActions() {
  const select = $('#language-select');
  select?.addEventListener('change', (event) => {
    setLocale(event.target.value);
    render();
  });
}

function renderHome() {
  $('#app').innerHTML = `${header('home')}<main>${lookupForm()}</main>${footer()}`;
  wireHeaderActions();
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
  return `<section class="summary-grid" aria-label="${escapeHtml(t('stats.title'))}"><article class="stat-card"><span>${escapeHtml(t('cards.knownAddresses'))}</span><strong>${summary.knownPositiveAddresses.toLocaleString('en-US')}</strong><small>${escapeHtml(t('cards.knownNonZero'))}</small></article><article class="stat-card"><span>${escapeHtml(t('cards.knownRecovered'))}</span><strong>${formatPlanck(summary.knownRecoveredPlanck)}</strong><small>${escapeHtml(t('cards.xcDOT'))}</small></article><article class="stat-card"><span>${escapeHtml(t('cards.totalSupply'))}</span><strong>${formatPlanck(summary.totalSupplyPlanck)}</strong><small>${escapeHtml(t('cards.xcDOT'))}</small></article><article class="stat-card warning"><span>${escapeHtml(t('cards.unattributed'))}</span><strong>${formatPlanck(summary.unattributedPlanck)}</strong><small>${escapeHtml(t('cards.xcDOT'))}</small></article></section>`;
}

function statBar(label, value, total, detail) {
  const width = Math.min(100, Number((BigInt(value) * 10000n) / BigInt(total)) / 100);
  return `<div class="bar-row"><div><span>${escapeHtml(label)}</span><strong>${detail}</strong></div><div class="bar"><i style="width:${width}%"></i></div></div>`;
}

function renderStatistics() {
  const stats = state.statistics;
  const totalSupply = stats.snapshot.totalSupplyPlanck;
  const distribution = stats.distribution;
  const concentration = stats.concentration;
  const maxBucket = Math.max(...distribution.buckets.map((item) => item.addressCount), 1);
  $('#app').innerHTML =
    `${header('statistics')}<main><section class="page-heading"><p class="eyebrow">${escapeHtml(t('stats.eyebrow'))}</p><h1>${escapeHtml(t('stats.title'))}</h1><p class="lede">${escapeHtml(t('stats.lede'))}</p></section>${metricCards()}<section class="two-column"><section class="panel"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('stats.distribution'))}</p><h2>${escapeHtml(t('stats.distributionTitle'))}</h2></div><span class="muted">${escapeHtml(t('stats.perAddress'))}</span></div><div class="histogram">${distribution.buckets.map((bucket) => `<div class="histogram-col"><div class="histogram-bar" style="height:${Math.max(6, (bucket.addressCount / maxBucket) * 100)}%" title="${escapeHtml(t('top.matchingAddresses', { count: bucket.addressCount.toLocaleString('en-US') }))}"></div><span>${escapeHtml(bucket.label)}</span><small>${bucket.addressCount.toLocaleString('en-US')}</small></div>`).join('')}</div></section><section class="panel"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('stats.concentration'))}</p><h2>${escapeHtml(t('stats.concentrationTitle'))}</h2></div><span class="muted">${escapeHtml(t('stats.shareOfSupply'))}</span></div>${statBar(t('stats.top10'), concentration.top10Planck, totalSupply, `${formatPlanck(concentration.top10Planck)} xcDOT · ${percent(concentration.top10Planck, totalSupply)}`)}${statBar(t('stats.top100'), concentration.top100Planck, totalSupply, `${formatPlanck(concentration.top100Planck)} xcDOT · ${percent(concentration.top100Planck, totalSupply)}`)}${statBar(t('stats.top1000'), concentration.top1000Planck, totalSupply, `${formatPlanck(concentration.top1000Planck)} xcDOT · ${percent(concentration.top1000Planck, totalSupply)}`)}${statBar(t('stats.remaining'), concentration.remainingPlanck, totalSupply, `${formatPlanck(concentration.remainingPlanck)} xcDOT · ${percent(concentration.remainingPlanck, totalSupply)}`)}</section></section></main>${footer()}`;
  wireHeaderActions();
}

function updateTopUrl(page, size, query) {
  const params = new URLSearchParams();
  if (page !== 1) params.set('page', page);
  if (size !== 50) params.set('size', size);
  if (query) params.set('q', query);
  history.replaceState({}, '', `./top${params.toString() ? `?${params}` : ''}`);
}

function rowCopyButton(address) {
  return `<button type="button" class="row-copy-button" data-row-copy="${escapeHtml(address)}" aria-label="${escapeHtml(t('common.copyAddress'))}" title="${escapeHtml(t('common.copyAddress'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg></button>`;
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
    `${header('top')}<main><section class="page-heading"><p class="eyebrow">${escapeHtml(t('top.eyebrow'))}</p><h1>${escapeHtml(t('top.title'))}</h1><p class="lede">${escapeHtml(t('top.lede', { block: Number(state.snapshot.terminalState.blockNumber).toLocaleString('en-US') }))}</p></section><section class="panel top-controls"><label class="filter-search"><span class="sr-only">${escapeHtml(t('top.filterAddress'))}</span><input id="top-query" value="${escapeHtml(query)}" placeholder="${escapeHtml(t('top.filterAddress'))}" /></label><label class="page-size">${escapeHtml(t('top.rows'))} <select id="page-size" aria-label="${escapeHtml(t('top.rows'))}"><option ${size === 25 ? 'selected' : ''}>25</option><option ${size === 50 ? 'selected' : ''}>50</option><option ${size === 100 ? 'selected' : ''}>100</option></select></label></section><section class="panel table-panel"><div class="table-meta"><span>${escapeHtml(t('top.matchingAddresses', { count: filtered.length.toLocaleString('en-US') }))}</span><span>${escapeHtml(t('top.pageOf', { page: currentPage, pages: pageCount }))}</span></div><div class="table-wrap"><table><thead><tr><th>${escapeHtml(t('top.rank'))}</th><th>${escapeHtml(t('top.address'))}</th><th>${escapeHtml(t('top.balance'))}</th><th>${escapeHtml(t('top.share'))}</th></tr></thead><tbody>${rows.map((holder) => `<tr><td>#${holder.rank}</td><td><div class="address-cell"><a class="address-link" href="./?address=${holder.address}" title="${holder.address}">${shortAddress(holder.address)}</a>${rowCopyButton(holder.address)}</div></td><td><strong>${formatPlanck(holder.balancePlanck)}</strong></td><td>${percent(holder.balancePlanck, totalSupply)}</td></tr>`).join('')}</tbody></table></div><div class="pagination"><button type="button" class="secondary" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>${escapeHtml(t('top.previous'))}</button><span>${escapeHtml(t('top.pageOf', { page: currentPage, pages: pageCount }))}</span><button type="button" class="secondary" data-page="${currentPage + 1}" ${currentPage === pageCount ? 'disabled' : ''}>${escapeHtml(t('top.next'))}</button></div></section></main>${footer()}`;
  wireHeaderActions();
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
  for (const button of document.querySelectorAll('[data-row-copy]'))
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copyText(button.dataset.rowCopy, t('toast.addressCopied'));
    });
}

function render() {
  applyLocale();
  const path = location.pathname.slice(BASE_PATH.length).replace(/\/$/, '') || '/';
  if (path === '/statistics') renderStatistics();
  else if (path === '/top') renderTop();
  else renderHome();
}

async function main() {
  setLocale(resolveLocale(), false);
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
  applyLocale();
  $('#app').innerHTML =
    `<main class="fatal"><h1>${escapeHtml(t('state.fatalTitle'))}</h1><p>${escapeHtml(t('state.fatalDescription'))}</p></main>`;
});
