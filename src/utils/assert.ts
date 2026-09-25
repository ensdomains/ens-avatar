import { BaseError } from './error';

export function assert(condition: any, message: string) {
  if (!condition) {
    throw new BaseError(message);
  }
}
