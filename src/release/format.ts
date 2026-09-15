/** Format an unsigned integer amount without converting it to a JavaScript Number. */
export function formatUnits(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error('decimals must be a non-negative integer');
  }
  if (value < 0n) throw new Error('value must be unsigned');
  if (decimals === 0) return value.toString(10);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) return whole.toString(10);
  return `${whole.toString(10)}.${fraction.toString(10).padStart(decimals, '0').replace(/0+$/, '')}`;
}

/** Return a deterministic decimal percentage using integer arithmetic only. */
export function formatPercent(numerator: bigint, denominator: bigint, decimals = 7): string {
  if (numerator < 0n || denominator <= 0n) throw new Error('invalid percentage operands');
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('invalid percentage precision');
  const scale = 10n ** BigInt(decimals);
  const scaled = (numerator * 100n * scale) / denominator;
  const whole = scaled / scale;
  const fraction = scaled % scale;
  if (decimals === 0) return whole.toString(10);
  return `${whole.toString(10)}.${fraction.toString(10).padStart(decimals, '0')}`;
}
