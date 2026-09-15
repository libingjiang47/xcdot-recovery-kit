import { sha256Hex } from '../snapshot/digest.js';
import { candidateAddressesSha256, type CandidateDiscovery } from '../subscan/candidates.js';
import { compareCanonicalStrings } from '../utils/order.js';
import type { CandidateExtensionImport } from './candidate-extension.js';

export type CandidateSource = string;

export interface CandidateAddressRecord {
  address: string;
  sources: CandidateSource[];
}

export interface CandidateUniverse {
  records: CandidateAddressRecord[];
  addresses: string[];
  subscanOnly: string[];
  moonscanOnly: string[];
  extensionOnly: string[];
  intersection: string[];
  subscanAddressSha256: string;
  moonscanOnlySha256: string;
  extensionOnlySha256: string;
  extensionSource: string;
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
  extension: Pick<CandidateExtensionImport, 'records'>,
  extensionSource = 'moonscan',
): CandidateUniverse {
  const subscanAddresses = new Set(subscan.addresses);
  const extensionAddresses = new Set(extension.records.map((record) => record.address));
  const addresses = [...new Set([...subscanAddresses, ...extensionAddresses])].sort(
    compareCanonicalStrings,
  );
  const subscanOnly = [...subscanAddresses]
    .filter((address) => !extensionAddresses.has(address))
    .sort(compareCanonicalStrings);
  const extensionOnly = [...extensionAddresses]
    .filter((address) => !subscanAddresses.has(address))
    .sort(compareCanonicalStrings);
  const intersection = [...subscanAddresses]
    .filter((address) => extensionAddresses.has(address))
    .sort(compareCanonicalStrings);
  const records = addresses.map((address) => ({
    address,
    sources: [
      ...(extensionAddresses.has(address) ? ([extensionSource] as const) : []),
      ...(subscanAddresses.has(address) ? (['subscan'] as const) : []),
    ],
  }));
  return {
    records,
    addresses,
    subscanOnly,
    moonscanOnly: extensionOnly,
    extensionOnly,
    intersection,
    subscanAddressSha256: candidateAddressesSha256(subscan.addresses),
    moonscanOnlySha256: candidateAddressesSha256(extensionOnly),
    extensionOnlySha256: candidateAddressesSha256(extensionOnly),
    extensionSource,
    unionSha256: candidateAddressesSha256(addresses),
  };
}

export function sourceSha256(bytes: string | Uint8Array): string {
  return sha256Hex(bytes);
}
