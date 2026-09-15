import { keccak256, type Hex } from 'viem';
import { XC_DOT_XC20_ADDRESS } from '../asset/constants.js';
import { FinalStateStorageLayoutError } from '../utils/errors.js';

const U256_MAX = (1n << 256n) - 1n;

export interface SolidityStorageLayoutEntry {
  label: string;
  slot: string;
  offset?: number;
  type: string;
  contract?: string;
}

export interface SolidityStorageType {
  encoding?: string;
  label?: string;
  key?: string;
  value?: string;
}

export interface SolidityStorageLayout {
  storage: SolidityStorageLayoutEntry[];
  types: Record<string, SolidityStorageType>;
}

export interface VerifiedStorageLayout {
  contract: string;
  codeHash?: string;
  compiler: { version: string; optimizer?: Record<string, unknown> };
  sources: Record<string, string>;
  storageLayout: SolidityStorageLayout;
  balancesSlot: bigint;
  totalSupplySlot: bigint;
}

function fail(message: string, details: Record<string, string | number | boolean> = {}): never {
  throw new FinalStateStorageLayoutError(message, details);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function unsignedSlot(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) {
    fail(`${label} must be an unsigned storage slot.`);
  }
  const slot = BigInt(value);
  if (slot < 0n || slot > U256_MAX) fail(`${label} is outside the U256 range.`);
  return slot;
}

function typeLabel(types: Record<string, SolidityStorageType>, id: string, label: string): string {
  const type = types[id];
  if (!type) fail(`${label} references unknown Solidity type ${id}.`);
  return type.label ?? id;
}

function parseLayout(value: unknown): SolidityStorageLayout {
  const record = asRecord(value, 'storageLayout');
  if (!Array.isArray(record.storage)) fail('storageLayout.storage must be an array.');
  const rawTypes = asRecord(record.types, 'storageLayout.types');
  const types: Record<string, SolidityStorageType> = {};
  for (const [id, rawType] of Object.entries(rawTypes)) {
    const type = asRecord(rawType, `storageLayout.types.${id}`);
    types[id] = {
      ...(typeof type.encoding === 'string' ? { encoding: type.encoding } : {}),
      ...(typeof type.label === 'string' ? { label: type.label } : {}),
      ...(typeof type.key === 'string' ? { key: type.key } : {}),
      ...(typeof type.value === 'string' ? { value: type.value } : {}),
    };
  }
  const storage: SolidityStorageLayoutEntry[] = record.storage.map((rawEntry, index) => {
    const entry = asRecord(rawEntry, `storageLayout.storage[${index}]`);
    if (
      typeof entry.label !== 'string' ||
      typeof entry.slot !== 'string' ||
      typeof entry.type !== 'string'
    ) {
      fail(`storageLayout.storage[${index}] lacks label, slot, or type.`);
    }
    if (entry.offset !== undefined && typeof entry.offset !== 'number') {
      fail(`storageLayout.storage[${index}].offset must be a number.`);
    }
    return {
      label: entry.label,
      slot: entry.slot,
      type: entry.type,
      ...(typeof entry.offset === 'number' ? { offset: entry.offset } : {}),
      ...(typeof entry.contract === 'string' ? { contract: entry.contract } : {}),
    };
  });
  return { storage, types };
}

function mappingEntry(
  layout: SolidityStorageLayout,
  label: string,
): { entry: SolidityStorageLayoutEntry; slot: bigint } {
  const matches = layout.storage.filter((entry) => entry.label === label);
  if (matches.length !== 1) {
    fail(`Expected exactly one Solidity storage entry named ${label}.`, {
      matches: matches.length,
    });
  }
  const entry = matches[0];
  if (!entry) fail(`Solidity storage entry ${label} is missing.`);
  const mapping = layout.types[entry.type];
  if (!mapping || mapping.encoding !== 'mapping' || !mapping.key || !mapping.value) {
    fail(`${label} is not a Solidity mapping with explicit key and value types.`);
  }
  const keyLabel = typeLabel(layout.types, mapping.key, `${label} key`);
  const valueLabel = typeLabel(layout.types, mapping.value, `${label} value`);
  if (!/^address(?:\s|$)/i.test(keyLabel) || !/^uint256(?:\s|$)/i.test(valueLabel)) {
    fail(`${label} is not mapping(address => uint256).`, { key: keyLabel, value: valueLabel });
  }
  return { entry, slot: unsignedSlot(entry.slot, `${label} slot`) };
}

function totalSupplyEntry(layout: SolidityStorageLayout): {
  entry: SolidityStorageLayoutEntry;
  slot: bigint;
} {
  const matches = layout.storage.filter((entry) => entry.label === '_totalSupply');
  if (matches.length !== 1) {
    fail('Expected exactly one Solidity storage entry named _totalSupply.', {
      matches: matches.length,
    });
  }
  const entry = matches[0];
  if (!entry) fail('Solidity _totalSupply storage entry is missing.');
  const type = layout.types[entry.type];
  const label = typeLabel(layout.types, entry.type, '_totalSupply');
  if (!type || type.encoding !== 'inplace' || !/^uint256(?:\s|$)/i.test(label)) {
    fail('_totalSupply is not an in-place uint256 storage value.', { type: label });
  }
  if (entry.offset !== undefined && entry.offset !== 0) {
    fail('_totalSupply is not aligned at offset zero.', { offset: entry.offset });
  }
  return { entry, slot: unsignedSlot(entry.slot, '_totalSupply slot') };
}

export function verifySolidityStorageLayout(value: unknown): {
  storageLayout: SolidityStorageLayout;
  balancesSlot: bigint;
  totalSupplySlot: bigint;
} {
  const storageLayout = parseLayout(value);
  const balances = mappingEntry(storageLayout, '_balances');
  const supply = totalSupplyEntry(storageLayout);
  return {
    storageLayout,
    balancesSlot: balances.slot,
    totalSupplySlot: supply.slot,
  };
}

export function deriveMappingStorageSlot(address: string, baseSlot: bigint | string): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new FinalStateStorageLayoutError('Mapping key is not a canonical H160 address.', {
      address,
    });
  }
  const slot =
    typeof baseSlot === 'bigint' ? baseSlot : unsignedSlot(baseSlot, 'mapping base slot');
  if (slot < 0n || slot > U256_MAX) {
    throw new FinalStateStorageLayoutError('Mapping base slot is outside the U256 range.');
  }
  const addressWord = address.slice(2).toLowerCase().padStart(64, '0');
  const slotWord = slot.toString(16).padStart(64, '0');
  return keccak256(`0x${addressWord}${slotWord}` as Hex);
}

export function storageSlotHex(slot: bigint | string): Hex {
  const value = typeof slot === 'bigint' ? slot : unsignedSlot(slot, 'storage slot');
  if (value < 0n || value > U256_MAX) {
    throw new FinalStateStorageLayoutError('Storage slot is outside the U256 range.');
  }
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}

export function decodeU256Storage(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value === '0x') return 0n;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new FinalStateStorageLayoutError(
      'AccountStorages value is not exactly one 32-byte U256 word.',
      { value },
    );
  }
  return BigInt(value);
}

export function encodeU256Storage(value: bigint): Hex {
  if (value < 0n || value > U256_MAX) {
    throw new FinalStateStorageLayoutError('U256 value is outside the unsigned range.');
  }
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}

export function parseVerifiedStorageLayout(value: unknown): VerifiedStorageLayout {
  const record = asRecord(value, 'storage layout artifact');
  if (record.schemaVersion !== 1) fail('Unsupported storage layout artifact schema.');
  if (
    typeof record.contract !== 'string' ||
    record.contract.toLowerCase() !== XC_DOT_XC20_ADDRESS
  ) {
    fail('Storage layout artifact is for a different contract.', {
      expected: XC_DOT_XC20_ADDRESS,
      actual: typeof record.contract === 'string' ? record.contract : 'missing',
    });
  }
  const compiler = asRecord(record.compiler, 'storage layout compiler');
  if (typeof compiler.version !== 'string' || compiler.version.length === 0) {
    fail('Storage layout artifact lacks a compiler version.');
  }
  const sourcesRecord = asRecord(record.sources, 'storage layout sources');
  const sources: Record<string, string> = {};
  for (const [name, hash] of Object.entries(sourcesRecord)) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) {
      fail(`Storage layout source hash for ${name} is invalid.`);
    }
    sources[name] = hash.toLowerCase();
  }
  if (Object.keys(sources).length === 0) fail('Storage layout artifact has no source hashes.');
  const verified = verifySolidityStorageLayout(record.storageLayout);
  const codeHash = record.codeHash;
  if (
    codeHash !== undefined &&
    (typeof codeHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(codeHash))
  ) {
    fail('Storage layout artifact codeHash is invalid.');
  }
  return {
    contract: XC_DOT_XC20_ADDRESS,
    ...(codeHash === undefined ? {} : { codeHash: codeHash.toLowerCase() }),
    compiler: {
      version: compiler.version,
      ...(compiler.optimizer === undefined
        ? {}
        : { optimizer: asRecord(compiler.optimizer, 'storage layout optimizer') }),
    },
    sources,
    storageLayout: verified.storageLayout,
    balancesSlot: verified.balancesSlot,
    totalSupplySlot: verified.totalSupplySlot,
  };
}
