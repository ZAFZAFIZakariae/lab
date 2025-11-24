import { Version } from "./lww";

export interface MetadataStore {
  get(bucket: string, key: string): Version | undefined;
  set(bucket: string, key: string, version: Version): void;
  all(bucket: string): Map<string, Version>;
}

/**
 * In-memory implementation.
 *
 * Structure:
 *   data[bucket][key] = Version
 */
export class InMemoryMetadataStore implements MetadataStore {
  private data: Map<string, Map<string, Version>> = new Map();

  private ensureBucket(bucket: string): Map<string, Version> {
    let b = this.data.get(bucket);
    if (!b) {
      b = new Map();
      this.data.set(bucket, b);
    }
    return b;
  }

  get(bucket: string, key: string): Version | undefined {
    const b = this.data.get(bucket);
    if (!b) return undefined;
    return b.get(key);
  }

  set(bucket: string, key: string, version: Version): void {
    const b = this.ensureBucket(bucket);
    b.set(key, version);
  }

  all(bucket: string): Map<string, Version> {
    const b = this.data.get(bucket);
    return b ? new Map(b) : new Map();
  }
}
