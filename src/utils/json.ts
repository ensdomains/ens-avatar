/**
 * JSON.parse that drops "__proto__" keys at every depth. JSON.parse makes
 * them own properties; a consumer copying the result with Object.assign (or
 * a spread into an existing object's prototype chain) would turn one into a
 * prototype and inherit its fields.
 */
export function parseJSON(text: string): unknown {
  return JSON.parse(text, (key, value) =>
    key === '__proto__' ? undefined : value
  );
}
