import { sha256Hex } from '../snapshot/digest.js';
import { candidateAddressesSha256, type CandidateDiscovery } from '../subscan/candidates.js';
import { compareCanonicalStrings } from '../utils/order.js';
import type { MoonscanImport } from './moonscan.js';

export type CandidateSource = 'moonscan' | 'subscan';

export interface CandidateAddressRecord {
  address: string;
  sources: CandidateSource[];
}

export interface CandidateUniverse {
  records: CandidateAddressRecord[];
  addresses: string[];
  subscanOnly: string[];
  moonscanOnly: string[];
  intersection: string[];
  subscanAddressSha256: string;
  moonscanOnlySha256: string;
  unionSha256: string;
}

export function serializeAddressRecords(addresses: readonly string[]): string {
  return addresses.length === 0
    ? ''
    : addresses.map((address) => JSON.stringify({ address })).join('\n') + '\n';
}

export function serializeCandidateProvenance(records: readonly CandidateAddressRecord[]): string {
  return records.length === 0
    ? ''
    : records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

export function buildCandidateUniverse(
  subscan: CandidateDiscovery,
  moonscan: MoonscanImport,
): CandidateUniverse {
  const subscanAddresses = new Set(subscan.addresses);
  const moonscanAddresses = new Set(moonscan.records.map((record) => record.address));
  const addresses = [...new Set([...subscanAddresses, ...moonscanAddresses])].sort(
    compareCanonicalStrings,
  );
  const subscanOnly = [...subscanAddresses]
    .filter((address) => !moonscanAddresses.has(address))
    .sort(compareCanonicalStrings);
  const moonscanOnly = [...moonscanAddresses]
    .filter((address) => !subscanAddresses.has(address))
    .sort(compareCanonicalStrings);
  const intersection = [...subscanAddresses]
    .filter((address) => moonscanAddresses.has(address))
    .sort(compareCanonicalStrings);
  const records = addresses.map((address) => ({
    address,
    sources: [
      ...(moonscanAddresses.has(address) ? (['moonscan'] as const) : []),
      ...(subscanAddresses.has(address) ? (['subscan'] as const) : []),
    ],
  }));
  return {
    records,
    addresses,
    subscanOnly,
    moonscanOnly,
    intersection,
    subscanAddressSha256: candidateAddressesSha256(subscan.addresses),
    moonscanOnlySha256: candidateAddressesSha256(moonscanOnly),
    unionSha256: candidateAddressesSha256(addresses),
  };
}

export function sourceSha256(bytes: string | Uint8Array): string {
  return sha256Hex(bytes);
}
