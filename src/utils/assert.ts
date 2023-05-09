// simple assert without nested check
export function assert(condition: any, message: string) {
  if (!condition) {
    throw message;
  }
}
