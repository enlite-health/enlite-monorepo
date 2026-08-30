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

    // ── Recusa EXPLICITA do filtro clinico removido (25/08/2026) ─────────────
    // O schema nao e `.strict()` e nao pode ser: o portal WordPress manda um `_` de
    // cache-bust que passaria a dar 400. Sem esta checagem, `?pathology=` seria descartado
    // em SILENCIO — o chamador continuaria enviando, receberia a lista inteira achando que
    // filtrou, e ninguem descobriria que o filtro morreu. Falha silenciosa e pior que erro.
    if (req.query.pathology !== undefined) {
      res.status(400).json({
        success: false,
        error: 'Invalid query params',
        details: [{
          path: ['pathology'],
          code: 'removed',
          message:
            'The `pathology` filter was removed: it matched on patient clinical data on an ' +
            'unauthenticated route. Filter by state, city, worker_type or q instead.',
        }],
      });
      return;
    }

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
          // ⚠️ C6 do parecer do `lex`: `filters` NAO sai inteiro no log. O `q` e busca livre
          // digitada por quem chama, entao pode conter termo clinico — e este log carrega
          // `req.ip` e cai em bucket global. Termo clinico + IP no mesmo registro e o achado
          // F0 do plano de compliance, por outra porta. Sai a FORMA da consulta, nunca o
          // conteudo: quais filtros vieram, e o tamanho do termo.
          filterKeys: Object.keys(filters).sort(),
          qLength: filters.q ? filters.q.length : 0,
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
