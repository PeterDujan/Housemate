/**
 * Cache for a pure text function. Routing normalises every entity id and
 * friendly name on every turn, so the same few thousand strings repeat;
 * utterances do not, so the cache is capped and starts again when full.
 */
export class TextMemo {
  private readonly values = new Map<string, string>();

  constructor(private readonly limit = 50_000) {}

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  set(key: string, value: string): string {
    if (this.values.size >= this.limit) {
      this.values.clear();
    }
    this.values.set(key, value);
    return value;
  }
}
