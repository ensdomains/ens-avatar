/**
 * Validate a numeric limit option. NaN, Infinity and negatives would silently
 * disable a cap (`x > NaN` is always false), so they are rejected loudly.
 */
export function assertLimit(
  name: string,
  value: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {}
): void {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new TypeError(
      `${name} must be an integer between ${min} and ${max}, got ${value}`
    );
  }
}

/** Options like allowPrivateIPs must be real booleans: "false" is truthy. */
export function assertBoolean(name: string, value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean, got ${typeof value}`);
  }
}

export function assertStringArray(name: string, value: unknown): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some(v => typeof v !== 'string'))
  ) {
    throw new TypeError(`${name} must be an array of strings`);
  }
}
