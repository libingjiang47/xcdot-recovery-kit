import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as T;
}

describe('v1 terminal frontend data boundary', () => {
  it('builds offline when address classification is not captured', () => {
    const sourceClassification = readJson<{ status: string }>('data/classification.json');
    expect(sourceClassification.status).toBe('NOT_CAPTURED');

    const output = execFileSync(process.execPath, ['scripts/build-web-data.mjs'], {
      cwd: root,
      env: { ...process.env, NO_NETWORK: '1' },
      encoding: 'utf8',
    });

    expect(output).toContain('WEB_BUILD=PASS');
    expect(output).toContain('KNOWN_HOLDER_COUNT=11785');
    expect(output).toContain('KNOWN_BALANCE_SUM_PLANCK=2334506800114108');
    expect(output).not.toContain('CLASSIFICATION_STATUS');
    expect(output).not.toContain('UNKNOWN_COUNT');
  }, 20_000);

  it('emits a classification-free static schema', () => {
    const statistics = readJson<{
      schemaVersion: number;
      snapshot: { knownRecoveredPlanck: string };
      distribution: { buckets: unknown[] };
      concentration: { top1000Planck: string; remainingPlanck: string };
    }>('web/data/statistics.json');
    const index = readJson<Record<string, Record<string, unknown>>>('web/data/holders-index.json');
    const ranked = readJson<Array<Record<string, unknown>>>('web/data/holders-ranked.json');
    const firstIndex = index[Object.keys(index)[0]];

    expect(statistics.schemaVersion).toBe(3);
    expect(Object.keys(statistics)).toEqual([
      'schemaVersion',
      'snapshot',
      'terminalState',
      'distribution',
      'concentration',
    ]);
    expect(Object.keys(statistics.distribution)).toEqual(['buckets']);
    expect(
      BigInt(statistics.concentration.top1000Planck) +
        BigInt(statistics.concentration.remainingPlanck),
    ).toBe(BigInt(statistics.snapshot.knownRecoveredPlanck));
    expect(firstIndex).not.toHaveProperty('classification');
    expect(ranked[0]).not.toHaveProperty('classification');
    expect(existsSync(resolve(root, 'web/data/classification.json'))).toBe(false);
  });

  it('keeps the frontend address, evidence, and top views classification-free', () => {
    const app = readFileSync(resolve(root, 'web/app.js'), 'utf8');

    expect(app).not.toContain('typeLabel');
    expect(app).not.toContain('typeHint');
    expect(app).not.toContain('Address Type');
    expect(app).not.toContain('data-type-filter');
    expect(app).not.toContain('classification');
    expect(app).toContain('schemaVersion: 2');
    expect(app).not.toMatch(/holder:\s*\{[^}]*classification/s);
    expect(app).not.toContain("params.get('type')");
    expect(app).toContain("t('top.filterAddress')");
    expect(app).toContain("t('stats.distributionTitle')");
    expect(app).toContain("t('stats.concentrationTitle')");
    expect(app).not.toContain('class="home-main"');
    expect(app).toContain('class="copyable-code');
    expect(app).toContain('function copyableCode');
    expect(app).not.toContain('function copyButton');
    expect(app).not.toContain('summaryCards');
    expect(app).toContain('schemaVersion: 2');
  });

  it('uses a full-height shell without a fixed footer spacer', () => {
    const app = readFileSync(resolve(root, 'web/app.js'), 'utf8');
    const styles = readFileSync(resolve(root, 'web/styles.css'), 'utf8');

    expect(app).toContain('copyableCode(result.address');
    expect(app).toContain('copyableCode(state.snapshot.terminalState.blockHash');
    expect(app).toContain('copyableCode(entry.solidityStorageSlot');
    expect(app).toContain('copyableCode(entry.substrateStorageKey');
    expect(app).toContain('copyableCode(entry.storageValue');
    expect(app).not.toContain('Copy address</button>');
    expect(styles).toContain('grid-template-rows: auto minmax(0, 1fr) auto');
    expect(styles).toContain('min-height: 100dvh');
    expect(styles).toContain('#lookup-result:empty');
    expect(styles).not.toContain('.home-main');
    expect(styles).not.toMatch(/\.site-footer\s*\{[^}]*position:\s*(fixed|absolute)/);
  });
});
