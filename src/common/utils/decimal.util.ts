export function formatTokenAmount(raw: string, decimals: number): string {
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals) || '0';
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  const value = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${value}` : value;
}
