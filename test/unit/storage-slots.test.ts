import { describe, expect, it } from 'vitest';
import {
  decodeU256Storage,
  deriveMappingStorageSlot,
  encodeU256Storage,
  parseVerifiedStorageLayout,
  storageSlotHex,
  verifySolidityStorageLayout,
} from '../../src/storage/solidity.js';
import {
  accountStoragesMetadataSummary,
  deriveAccountStoragesKey,
} from '../../src/storage/substrate-evm.js';

const contract = '0xffffffff1fcacbd218edc0eba20fc2308c778080';
const address = '0x0000000000000000000000000000000000000123';

const layoutArtifact = {
  schemaVersion: 1,
  contract,
  compiler: { version: '0.8.20', optimizer: { enabled: true, runs: 200 } },
  sources: { 'ERC20.sol': 'a'.repeat(64) },
  storageLayout: {
    storage: [
      { label: '_balances', slot: '0', offset: 0, type: 't_mapping(t_address,t_uint256)' },
      { label: '_totalSupply', slot: '2', offset: 0, type: 't_uint256' },
    ],
    types: {
      't_mapping(t_address,t_uint256)': {
        encoding: 'mapping',
        key: 't_address',
        value: 't_uint256',
      },
      t_address: { encoding: 'inplace', label: 'address' },
      t_uint256: { encoding: 'inplace', label: 'uint256' },
    },
  },
};

describe('Solidity storage slot derivation', () => {
  it('uses left-padded address and base slot in the Solidity mapping vector', () => {
    expect(deriveMappingStorageSlot(address, 0n)).toBe(
      '0x6748e2a859e6ada15adb32e9f76b7a4f38d9ad3e4a80162a4b6c8d599d59a920',
    );
    expect(deriveMappingStorageSlot(address, 7n)).toBe(
      '0x821d53c2ef647f17faa14c068f8d53b4e9b9aac4b1ad82a4183e794f381b98bb',
    );
  });

  it('validates the layout instead of assuming slot positions', () => {
    const parsed = parseVerifiedStorageLayout(layoutArtifact);
    expect(parsed.balancesSlot).toBe(0n);
    expect(parsed.totalSupplySlot).toBe(2n);
    expect(verifySolidityStorageLayout(layoutArtifact.storageLayout).totalSupplySlot).toBe(2n);
    expect(() =>
      verifySolidityStorageLayout({
        ...layoutArtifact.storageLayout,
        storage: [
          { label: '_balances', slot: '0', type: 't_uint256' },
          { label: '_totalSupply', slot: '2', type: 't_uint256' },
        ],
      }),
    ).toThrow(/mapping/);
  });

  it('decodes exact big-endian U256 words and missing storage as zero', () => {
    expect(decodeU256Storage(null)).toBe(0n);
    expect(decodeU256Storage('0x')).toBe(0n);
    expect(decodeU256Storage(`0x${'00'.repeat(31)}07`)).toBe(7n);
    expect(decodeU256Storage(`0x${'ff'.repeat(32)}`)).toBe((1n << 256n) - 1n);
    expect(encodeU256Storage(7n)).toBe(`0x${'00'.repeat(31)}07`);
    expect(storageSlotHex(2n)).toBe(`0x${'00'.repeat(31)}02`);
    expect(() => decodeU256Storage('0x01')).toThrow(/32-byte/);
  });

  it('asks runtime metadata to encode AccountStorages without a pallet index', () => {
    const apiAt = {
      query: {
        evm: {
          accountStorages: Object.assign(() => undefined, {
            key: (owner: string, slot: string) => `0x${owner.slice(2)}${slot.slice(2)}`,
            meta: { docs: ['fixture'] },
          }),
        },
      },
    };
    expect(accountStoragesMetadataSummary(apiAt).keyDerivation).toBe('runtime-metadata');
    expect(deriveAccountStoragesKey(apiAt, contract, `0x${'11'.repeat(32)}`)).toBe(
      `0x${contract.slice(2)}${'11'.repeat(32)}`,
    );
    expect(() =>
      deriveAccountStoragesKey({ query: { evm: {} } }, contract, `0x${'11'.repeat(32)}`),
    ).toThrow(/AccountStorages/);
  });
});
