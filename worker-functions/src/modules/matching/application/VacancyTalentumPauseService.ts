/**
 * VacancyTalentumPauseService — spec 084 F4 (R13, P7): ao baixar a vaga o sistema TENTA pausar o projeto do Talentum
 * por API; quando a vaga volta pela reativação do serviço, TENTA retomar. NUNCA apaga projeto (nenhum DELETE aqui).
 *
 * O que o Talentum recusar (403 = conta sem posse; qualquer outro erro também) NÃO falha em silêncio: grava
 * `job_postings.talentum_pause_state` = MANUAL_PAUSE / MANUAL_RESUME — a lista "pausar à mão no Talentum" da tela de
 * vacantes — e reporta o erro. A baixa em si já foi commitada pelo chamador: esta classe roda DEPOIS e nunca relança.
 *
 * Side-effect outbound: UM `PUT /projects/:id/pause|resume` por vaga com projeto. Em teste o cliente é injetado.
 */
import type { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { TalentumApiClient } from '../../integration/infrastructure/TalentumApiClient';
import type { ITalentumApiClient } from '../../integration/domain/ITalentumApiClient';

export type TalentumPauseState = 'PAUSED' | 'MANUAL_PAUSE' | 'MANUAL_RESUME';
type LifecycleClient = Pick<ITalentumApiClient, 'pauseProject' | 'resumeProject'>;

export interface TalentumPauseOutcome {
  vacancyId: string;
  /** null = vaga sem projeto no Talentum (nada a fazer) ou projeto já no estado pedido. */
  state: TalentumPauseState | null;
  attempted: boolean;
}

/** Porta mínima que o escritor do serviço contratado usa (injetável no unitário). */
export interface VacancyBajaSideEffects {
  pause(vacancyIds: readonly string[]): Promise<TalentumPauseOutcome[]>;
  resume(vacancyIds: readonly string[]): Promise<TalentumPauseOutcome[]>;
}

const httpStatus = (err: unknown): number | null => {
  const m = /HTTP (\d{3})/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : null;
};

export class VacancyTalentumPauseService implements VacancyBajaSideEffects {
  constructor(
    private readonly db: Pick<Pool, 'query'>,
    private readonly clientFactory: () => Promise<LifecycleClient> = () => TalentumApiClient.create(),
  ) {}

  pause(vacancyIds: readonly string[]): Promise<TalentumPauseOutcome[]> {
    return this.run(vacancyIds, 'pause');
  }

  resume(vacancyIds: readonly string[]): Promise<TalentumPauseOutcome[]> {
    return this.run(vacancyIds, 'resume');
  }

  private async run(vacancyIds: readonly string[], op: 'pause' | 'resume'): Promise<TalentumPauseOutcome[]> {
    if (vacancyIds.length === 0) return [];
    const rows = await this.db.query<{ id: string; talentum_project_id: string | null }>(
      `SELECT id, talentum_project_id FROM job_postings WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [vacancyIds],
    );
    const withProject = rows.rows.filter((r) => r.talentum_project_id);
    const outcomes: TalentumPauseOutcome[] = rows.rows
      .filter((r) => !r.talentum_project_id)
      .map((r) => ({ vacancyId: r.id, state: null, attempted: false }));
    if (withProject.length === 0) return outcomes;

    let client: LifecycleClient | null = null;
    let clientError: unknown = null;
    try {
      client = await this.clientFactory();
    } catch (err) {
      clientError = err;
    }

    for (const r of withProject) {
      const state = await this.attempt(client, clientError, r.talentum_project_id as string, op, r.id);
      await this.persist(r.id, state);
      outcomes.push({ vacancyId: r.id, state, attempted: true });
    }
    return outcomes;
  }

  /** Nunca lança: o resultado de uma falha é o estado MANUAL_*, visível na lista — nunca silêncio. */
  private async attempt(
    client: LifecycleClient | null,
    clientError: unknown,
    projectId: string,
    op: 'pause' | 'resume',
    vacancyId: string,
  ): Promise<TalentumPauseState | null> {
    const manual: TalentumPauseState = op === 'pause' ? 'MANUAL_PAUSE' : 'MANUAL_RESUME';
    if (!client) {
      reportError(clientError instanceof Error ? clientError : new Error(String(clientError)), {
        source: 'VacancyTalentumPauseService', op, vacancyId, step: 'client',
      });
      return manual;
    }
    try {
      if (op === 'pause') await client.pauseProject(projectId);
      else await client.resumeProject(projectId);
      return op === 'pause' ? 'PAUSED' : null;
    } catch (err) {
      const status = httpStatus(err);
      // Retomar projeto que não estava pausado (400) ou que já não existe lá (404): nada a retomar — não é falha.
      if (op === 'resume' && (status === 400 || status === 404)) return null;
      reportError(err instanceof Error ? err : new Error(String(err)), {
        source: 'VacancyTalentumPauseService', op, vacancyId, httpStatus: status,
      });
      return manual;
    }
  }

  private async persist(vacancyId: string, state: TalentumPauseState | null): Promise<void> {
    await this.db.query(`UPDATE job_postings SET talentum_pause_state = $2 WHERE id = $1`, [vacancyId, state]);
  }
}
