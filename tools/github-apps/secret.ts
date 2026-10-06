import { inspect } from "node:util";

const REDACTED = "[redacted]";

/**
 * Holds a credential so that logging it by accident prints nothing: string
 * conversion, JSON and `util.inspect` all show a placeholder. Only `reveal`
 * returns the value, and only the code that saves it should call that.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
