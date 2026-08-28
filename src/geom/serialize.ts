/**
 * Stable serialization for geometry output (task F3).
 *
 * Determinism acceptance: `buildIntersectionGeometry` is a pure function of
 * the config, and its stable serialization (object keys sorted, arrays in
 * canonical construction order, numbers via shortest round-trip `String`)
 * must be bit-identical across builds of the same config — this is what the
 * run-hash world (research R2) consumes later. `-0` normalizes to `"0"`
 * under String(); NaN/±Infinity throw (never valid geometry).
 */

export function stableStringify(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number cannot be serialized: ${String(value)}`);
    return String(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null || value === undefined) {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  throw new Error(`value of type ${typeof value} cannot be serialized`);
}

/** Object paths at which non-finite numbers appear (empty = all finite). */
export function findNonFinite(value: unknown, path = '$'): readonly string[] {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? [] : [path];
  }
  if (Array.isArray(value)) {
    const found: string[] = [];
    value.forEach((item, index) => {
      found.push(...findNonFinite(item, `${path}[${index}]`));
    });
    return found;
  }
  if (value !== null && typeof value === 'object') {
    const found: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      found.push(...findNonFinite((value as Record<string, unknown>)[key], `${path}.${key}`));
    }
    return found;
  }
  return [];
}
