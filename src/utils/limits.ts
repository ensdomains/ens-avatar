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
