export function normalizeH160(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Invalid H160 address: ${value}`);
  }
  return value.toLowerCase();
}

export function isH160(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
