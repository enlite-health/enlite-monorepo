import crypto from 'node:crypto';
import { normalizeSearch } from '../utils/normalizeSearch';

// Fixed key used in testMode: 32 bytes of 0x42. Deterministic for tests.
const TEST_KEY = Buffer.alloc(32, 0x42);

/**
 * BlindIndexService — CipherSweet-compatible trigram blind index for worker name search.
 *
 * Generates HMAC-SHA256 (truncated to 8 bytes) of each trigram of the normalised name,
 * storing them as a BYTEA[] column (`name_trgm_bidx`). Search queries generate the
 * same HMACs from the search term and use the Postgres `@>` operator with the GIN index.
 *
 * Key: `worker-trgm-hmac-key` in GCP Secret Manager (project-specific per environment).
 * testMode: NODE_ENV=test or USE_KMS_ENCRYPTION=false → fixed key, no Secret Manager calls.
 */
export class BlindIndexService {
  private key: Buffer | null;
  private readonly testMode: boolean;
  private readonly projectId: string;
  private readonly secretName: string;

  constructor() {
    this.testMode =
      process.env.NODE_ENV === 'test' || process.env.USE_KMS_ENCRYPTION === 'false';
    this.projectId = process.env.GCP_PROJECT_ID || 'enlite-prd';
    this.secretName = process.env.BLIND_INDEX_SECRET_NAME || 'worker-trgm-hmac-key';
    this.key = null;
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Generates the HMAC trigram array for a worker's name (firstName + lastName).
   * Padding is applied to the FULL concatenated name so that boundary trigrams
   * (e.g. the last 2 chars of firstName + first char of lastName) are captured.
   *
   * Returns [] if both firstName and lastName are null/empty.
   */
  async generateNameTrigramBidx(
    firstName: string | null | undefined,
    lastName: string | null | undefined,
  ): Promise<Buffer[]> {
    const combined = normalizeSearch(
      `${firstName ?? ''} ${lastName ?? ''}`,
    ).trim();

    if (combined.length < 3) {
      return [];
    }

    const key = await this.loadKey();
    // Padding: space on both sides of the full name
    const padded = ` ${combined} `;
    return this.trigramHmacs(padded, key);
  }

  /**
   * Generates the HMAC trigram array for a search term.
   * Padding is applied PER TOKEN so that prefix/suffix trigrams of each token
   * are a subset of the full-name index produced by generateNameTrigramBidx.
   *
   * Tokens with < 3 chars are silently ignored.
   * Throws if NO token has >= 3 chars (the entire normalised term is too short).
   */
  async generateSearchTrigramBidx(searchTerm: string): Promise<Buffer[]> {
    const normalised = normalizeSearch(searchTerm).trim();
    const tokens = normalised.split(/\s+/).filter(Boolean);
    const validTokens = tokens.filter((t) => t.length >= 3);

    if (validTokens.length === 0) {
      throw new Error('Search term must have at least 3 characters');
    }

    const key = await this.loadKey();
    const allHmacs: Buffer[] = [];

    for (const token of validTokens) {
      // No padding on the search side. The full-name index uses bilateral padding,
      // so any substring trigram is already a subset of the indexed array. This
      // gives substring-anywhere semantics (prefix, suffix, middle of token).
      const hmacs = this.trigramHmacs(token, key);
      allHmacs.push(...hmacs);
    }

    return this.dedupAndSort(allHmacs);
  }

  /**
   * Serialises a Buffer[] to a Postgres BYTEA[] array literal string.
   * Format: '{"\\x0102","\\x0304"}' — compatible with the `pg` driver and
   * Postgres BYTEA input format.
   *
   * Returns null for empty arrays so that INSERT/UPDATE stores NULL rather than
   * an empty array (consistent with "not yet indexed" semantic).
   */
  serializeForPg(buffers: Buffer[]): string | null {
    if (buffers.length === 0) return null;

    const elements = buffers.map((b) => {
      const hex = b.toString('hex');
      return `"\\\\x${hex}"`;
    });

    return `{${elements.join(',')}}`;
  }

  /**
   * Generates a single HMAC blind index for an exact value (not trigrams).
   *
   * Usage: sex_bidx — HMAC of the canonical value ('male' | 'female').
   * The caller MUST normalise the value BEFORE calling this method so that
   * write-path, filter and backfill all produce identical HMACs.
   *
   * Returns null for null / undefined / empty-string inputs.
   */
  async generateValueBidx(
    value: string | null | undefined,
  ): Promise<Buffer | null> {
    const normalized = value ? normalizeSearch(value).trim() : '';
    if (normalized.length === 0) return null;

    const key = await this.loadKey();
    const hmac = crypto
      .createHmac('sha256', key)
      .update(normalized, 'utf8')
      .digest()
      .subarray(0, 8);
    return Buffer.from(hmac);
  }

  /**
   * Generates HMAC blind indexes for an array of values (not trigrams).
   *
   * Usage: languages_bidx — one HMAC per language code.
   * Deduplicates and sorts for deterministic output.
   *
   * Returns [] for null / undefined / empty arrays.
   */
  async generateValuesBidx(
    values: string[] | null | undefined,
  ): Promise<Buffer[]> {
    if (!values || values.length === 0) return [];

    const key = await this.loadKey();
    const hmacs: Buffer[] = [];

    for (const value of values) {
      const normalized = normalizeSearch(value).trim();
      if (normalized.length === 0) continue;
      const hmac = crypto
        .createHmac('sha256', key)
        .update(normalized, 'utf8')
        .digest()
        .subarray(0, 8);
      hmacs.push(Buffer.from(hmac));
    }

    return this.dedupAndSort(hmacs);
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * Loads the HMAC key lazily.  In testMode returns a fixed key without any
   * network call.  In production fetches from GCP Secret Manager once and
   * caches the result (idempotent — concurrent calls are harmless since the
   * same secret value would be returned).
   */
  private async loadKey(): Promise<Buffer> {
    if (this.key !== null) return this.key;

    if (this.testMode) {
      this.key = TEST_KEY;
      return this.key;
    }

    // Dynamic require keeps @google-cloud/secret-manager out of the test bundle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SecretManagerServiceClient } = require('@google-cloud/secret-manager') as {
      SecretManagerServiceClient: new () => {
        accessSecretVersion(req: { name: string }): Promise<[{
          payload?: { data?: Buffer | string | { toString(): string } };
        }]>;
      };
    };

    const client = new SecretManagerServiceClient();
    const secretPath = `projects/${this.projectId}/secrets/${this.secretName}/versions/latest`;

    const [res] = await client.accessSecretVersion({ name: secretPath });
    const raw = res.payload?.data;

    if (!raw) {
      throw new Error(`BlindIndexService: secret ${this.secretName} returned empty payload`);
    }

    // Secret Manager returns data as Buffer (binary) or string; normalise to Buffer.
    this.key = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.toString(), 'utf8');

    if (this.key.length < 16) {
      throw new Error(
        `BlindIndexService: HMAC key from ${this.secretName} is too short (${this.key.length} bytes); expected >= 16`,
      );
    }

    return this.key;
  }

  /**
   * Sliding-window trigram extraction + HMAC.
   * Operates on the already-padded input string.
   */
  private trigramHmacs(padded: string, key: Buffer): Buffer[] {
    const hmacs: Buffer[] = [];

    for (let i = 0; i <= padded.length - 3; i++) {
      const trigram = padded.slice(i, i + 3);
      const hmac = crypto
        .createHmac('sha256', key)
        .update(trigram, 'utf8')
        .digest()
        .subarray(0, 8);
      hmacs.push(hmac);
    }

    return this.dedupAndSort(hmacs);
  }

  /**
   * Deduplicates buffers by hex string and sorts lexicographically for
   * deterministic output (important for tests and stable GIN index entries).
   */
  private dedupAndSort(buffers: Buffer[]): Buffer[] {
    const seen = new Map<string, Buffer>();
    for (const b of buffers) {
      const hex = b.toString('hex');
      if (!seen.has(hex)) seen.set(hex, b);
    }
    return [...seen.values()].sort((a, b) => a.toString('hex').localeCompare(b.toString('hex')));
  }
}
