export function formatDot(balancePlanck: bigint, decimals = 10): string {
  if (balancePlanck < 0n) throw new Error('Balance must be unsigned.');
  if (!Number.isInteger(decimals) || decimals < 0)
    throw new Error('Decimals must be a non-negative integer.');
  if (decimals === 0) return balancePlanck.toString(10);
  const scale = 10n ** BigInt(decimals);
  const whole = balancePlanck / scale;
  const fraction = (balancePlanck % scale).toString(10).padStart(decimals, '0');
  return `${whole.toString(10)}.${fraction}`;
}

export function parseBigIntDecimal(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`${label} must be an unsigned integer string.`);
  return BigInt(value);
}
