export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export function isZeroAddress(address: string): boolean {
  return normalizeAddress(address) === ZERO_ADDRESS;
}
