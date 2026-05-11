import { Request, Response } from 'express';
import { z } from 'zod';
import { ListActivePublicJobsUseCase } from '../../application/ListActivePublicJobsUseCase';
import { JobPostingARRepository } from '../../infrastructure/JobPostingARRepository';

// ── Query param schema ────────────────────────────────────────────────────────

const PublicJobsQuerySchema = z.object({
  country: z
    .string()
    .transform(s => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'country must be a 2-letter ISO code'))
    .default('AR'),
  state: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  pathology: z.string().trim().min(1).optional(),
  worker_sex: z.enum(['FEMALE', 'MALE', 'BOTH']).optional(),
  worker_type: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
});

type PublicJobsQuery = z.infer<typeof PublicJobsQuerySchema>;

// ── Controller ────────────────────────────────────────────────────────────────

export class PublicJobsController {
  private readonly useCase: ListActivePublicJobsUseCase;

  constructor() {
    this.useCase = new ListActivePublicJobsUseCase(new JobPostingARRepository());
  }

  async listActiveJobs(req: Request, res: Response): Promise<void> {
    const start = Date.now();

    // Validate query params
    const parsed = PublicJobsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query params',
        details: parsed.error.issues,
      });
      return;
    }

    const filters: PublicJobsQuery = parsed.data;

    try {
      const jobs = await this.useCase.execute(filters);
      const duration = Date.now() - start;
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'public_jobs_list',
          count: jobs.length,
          durationMs: duration,
          filters,
          ip: req.ip,
        }),
      );
      res
        .setHeader('Cache-Control', 'public, max-age=300, s-maxage=600')
        .status(200)
        .json({ success: true, data: jobs });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(
        JSON.stringify({ level: 'error', event: 'public_jobs_error', message, ip: req.ip }),
      );
      res.status(500).json({ success: false, error: 'Failed to fetch public jobs' });
    }
  }
}
