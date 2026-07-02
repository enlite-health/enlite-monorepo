import { z } from 'zod';
import type {
  ReadonlyDbQueryService,
  ReadonlyQueryResult,
} from '../ReadonlyDbQueryService';
import { HARD_MAX_ROWS } from '../ReadonlyDbQueryService';

const ArgsShape = {
  sql: z
    .string()
    .min(8)
    .max(10_000)
    .describe(
      'A single read-only SQL statement (SELECT or WITH). Runs in a READ ONLY ' +
        'transaction with a 10s timeout under a role without write privileges. ' +
        'Encrypted PII columns (*_encrypted, *_bidx) return opaque ciphertext — ' +
        'use the worker.* tools to read decrypted personal data. ' +
        'Useful tables: workers (merged_into_id IS NULL = deduped), ' +
        'worker_job_applications (funnel), job_postings, patients.',
    ),
  maxRows: z.number().int().min(1).max(HARD_MAX_ROWS).optional(),
};
const ArgsSchema = z.object(ArgsShape);

export class DbQueryReadonlyCapability {
  static readonly NAME = 'db.query.readonly';
  static readonly DESCRIPTION =
    'Run an ad-hoc read-only SQL query (SELECT/WITH) against the Enlite Postgres ' +
    'database for analytics and exploration. Single statement, max 200 rows. ' +
    'Prefer the worker.* tools for per-worker data (they decrypt PII); use this ' +
    'for aggregations, joins and questions with no dedicated tool.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly service: ReadonlyDbQueryService) {}

  async execute(args: unknown): Promise<ReadonlyQueryResult> {
    const parsed = ArgsSchema.parse(args);
    return this.service.run(parsed.sql, parsed.maxRows);
  }
}
