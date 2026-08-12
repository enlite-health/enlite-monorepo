import { Request, Response } from 'express';
import { ListActivePublicJobsUseCase } from '../../application/ListActivePublicJobsUseCase';
import { JobPostingARRepository } from '../../infrastructure/JobPostingARRepository';
import { PublicJobsFiltersSchema, type PublicJobsFilters } from '../../domain/PublicJobsFilters';

// ── Query param schema ────────────────────────────────────────────────────────
// TD-014: schema canônico vem do domain pra evitar drift.

const PublicJobsQuerySchema = PublicJobsFiltersSchema;

type PublicJobsQuery = PublicJobsFilters;

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
