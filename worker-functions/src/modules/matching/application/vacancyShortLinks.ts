import type { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { ShortLinkService } from '../infrastructure/shortlinks/ShortLinkService';
import { EnsureVacancyShortLinkUseCase } from './EnsureVacancyShortLinkUseCase';
import { PurgeVacancyShortLinksUseCase } from './PurgeVacancyShortLinksUseCase';
import { vagaPublicavelSql } from '../domain/vacancyPublication';

/**
 * Short link da vaga, best-effort: NUNCA rejeita (auto-captura e reporta). Roda DEPOIS do commit de quem a chama.
 *
 * semaforo-da-vaga F4: o link nasce quando a vaga é publicável (dono: `vacancyPublication.ts`), lida do banco na hora —
 * não de um status que o chamador carrega. Vaga de teste/QA nunca cria link real: Short.io é terceiro sem teardown, e
 * `is_test = false` faz parte da regra de publicável. Sem `SHORT_IO_API_KEY`/`SHORT_IO_DOMAIN`, é no-op.
 */
export async function tryEnsureShortLink(pool: Pool, vacancyId: string): Promise<void> {
  const svc = ShortLinkService.fromEnv();
  if (!svc) return;
  try {
    const publicavel = await pool.query(
      `SELECT 1 FROM job_postings jp LEFT JOIN patients p ON p.id = jp.patient_id
        WHERE jp.id = $1 AND ${vagaPublicavelSql('jp', 'p')}`,
      [vacancyId],
    );
    if (publicavel.rows.length === 0) return;
    await new EnsureVacancyShortLinkUseCase(pool, svc).execute(vacancyId, 'site');
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), { source: 'tryEnsureShortLink', vacancyId });
  }
}

/** Libera a cota do Short.io quando a vaga some (apagada). Erros são reportados, nunca lançados. */
export async function tryPurgeShortLinks(pool: Pool, vacancyId: string): Promise<void> {
  const svc = ShortLinkService.fromEnv();
  if (!svc) return;
  try {
    await new PurgeVacancyShortLinksUseCase(pool, svc).execute(vacancyId);
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), { source: 'tryPurgeShortLinks', vacancyId });
  }
}
