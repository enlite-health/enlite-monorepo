/**
 * DraftFusionRepository — SQL da fusão rascunho→oficial (manutenção, 03/11). TODO método roda no `client` da
 * transação do use case (uma por paciente). Só IDs e contagens saem daqui — nenhuma coluna de conteúdo.
 *
 * O que a fusão move do rascunho para a oficial (e conta antes/depois): as tabelas de {@link FUSION_COUNTED_TABLES}.
 * O que fica no rascunho apagado de propósito: `job_posting_audit_log` (é a história DELE). Qualquer outra referência
 * ao rascunho (FK para `job_postings` ou as colunas sem FK de {@link EXTRA_REF_COLUMNS}) faz a fusão daquele paciente
 * ser pulada (fail-closed) — {@link DraftFusionRepository.unhandledReferences}.
 */
import type { PoolClient } from 'pg';
import {
  APPLICATION_KEY_COLUMNS,
  ENCUADRE_KEY_COLUMNS,
  mergeEmptyColumns,
} from '../../matching/application/ReconcileMergedWorkerApplications';
import type { ServiceRecruitmentFields } from '../domain/PatientCompleteness';

export const FUSION_COUNTED_TABLES = [
  'worker_job_applications',
  'worker_job_application_stage_history',
  'encuadres',
  'talentum_prescreenings',
  'funnel_stage_message_log',
  'wja_contact_notes',
] as const;
export type FusionTable = (typeof FUSION_COUNTED_TABLES)[number];
export type FusionCounts = Record<FusionTable, { draft: number; official: number }>;

/** Referências ao rascunho que a fusão TRATA (movidas) ou deixa de propósito (auditoria). Formato `tabela.coluna`. */
export const HANDLED_REF_COLUMNS: readonly string[] = [
  'worker_job_applications.job_posting_id',
  'encuadres.job_posting_id',
  'talentum_prescreenings.job_posting_id',
  'funnel_stage_message_log.job_posting_id',
  'encuadre_ambiguity_queue.resolved_job_posting_id',
  'job_posting_audit_log.job_posting_id',
];

/** Colunas que apontam para vaga SEM FK (não aparecem em `pg_constraint`), medidas no schema em 03/11. */
export const EXTRA_REF_COLUMNS: readonly string[] = [
  'worker_blocked_applications.job_posting_id',
  'enquadre_event_participants.job_posting_id',
];

export interface ApplicationCollision {
  draftApplicationId: string;
  officialApplicationId: string;
  workerId: string;
  draftStage: string | null;
  officialStage: string | null;
}

export interface PatientVacancyShape {
  openLegacy: number;
  liveDrafts: number;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export class DraftFusionRepository {
  /** Mesma régua do mapa (PAR_UNICO): 1 vaga legada aberta (sem serviço, fora de CLOSED/DE_BAJA) e 1 rascunho de serviço. */
  async patientVacancyShape(client: PoolClient, patientId: string): Promise<PatientVacancyShape> {
    const res = await client.query<{ open_legacy: number; live_drafts: number }>(
      `SELECT count(*) FILTER (WHERE NOT is_draft AND contracted_service_id IS NULL
                                 AND status NOT IN ('CLOSED', 'DE_BAJA'))::int AS open_legacy,
              count(*) FILTER (WHERE is_draft AND contracted_service_id IS NOT NULL)::int AS live_drafts
         FROM job_postings
        WHERE patient_id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    return { openLegacy: res.rows[0].open_legacy, liveDrafts: res.rows[0].live_drafts };
  }

  /** `tabela.coluna` com linha apontando para o rascunho que a fusão NÃO sabe mover. Vazio = seguro fundir. */
  async unhandledReferences(client: PoolClient, draftId: string): Promise<string[]> {
    const fks = await client.query<{ ref: string }>(
      `SELECT DISTINCT c.conrelid::regclass::text || '.' || a.attname AS ref
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'job_postings'::regclass
        ORDER BY 1`,
    );
    const refs = [...new Set([...fks.rows.map((r) => r.ref), ...EXTRA_REF_COLUMNS])]
      .filter((ref) => !HANDLED_REF_COLUMNS.includes(ref))
      .sort();
    const parts = refs.map((ref, i) => {
      const [table, column] = ref.split('.');
      return `SELECT ${i} AS i WHERE EXISTS (SELECT 1 FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} = $1)`;
    });
    const hit = await client.query<{ i: number }>(parts.join(' UNION ALL '), [draftId]);
    return hit.rows.map((r) => refs[r.i]);
  }

  async countRows(client: PoolClient, draftId: string, officialId: string): Promise<FusionCounts> {
    const res = await client.query<{ t: FusionTable; v: string; n: number }>(
      `SELECT 'worker_job_applications' AS t, job_posting_id AS v, count(*)::int AS n
         FROM worker_job_applications WHERE job_posting_id = ANY ($1::uuid[]) GROUP BY 2
       UNION ALL
       SELECT 'worker_job_application_stage_history', w.job_posting_id, count(*)::int
         FROM worker_job_application_stage_history h JOIN worker_job_applications w ON w.id = h.application_id
        WHERE w.job_posting_id = ANY ($1::uuid[]) GROUP BY 2
       UNION ALL
       SELECT 'encuadres', job_posting_id, count(*)::int FROM encuadres WHERE job_posting_id = ANY ($1::uuid[]) GROUP BY 2
       UNION ALL
       SELECT 'talentum_prescreenings', job_posting_id, count(*)::int
         FROM talentum_prescreenings WHERE job_posting_id = ANY ($1::uuid[]) GROUP BY 2
       UNION ALL
       SELECT 'funnel_stage_message_log', job_posting_id, count(*)::int
         FROM funnel_stage_message_log WHERE job_posting_id = ANY ($1::uuid[]) GROUP BY 2
       UNION ALL
       SELECT 'wja_contact_notes', job_posting_id, count(*)::int
         FROM wja_contact_notes WHERE job_posting_id = ANY ($1::uuid[]) GROUP BY 2`,
      [[draftId, officialId]],
    );
    const counts = Object.fromEntries(
      FUSION_COUNTED_TABLES.map((t) => [t, { draft: 0, official: 0 }]),
    ) as FusionCounts;
    for (const r of res.rows) counts[r.t][r.v === draftId ? 'draft' : 'official'] = r.n;
    return counts;
  }

  /** Mesmo worker nas duas vagas (a UNIQUE (worker_id, job_posting_id) impede o reparent direto). Trava as duas linhas. */
  async listApplicationCollisions(
    client: PoolClient,
    draftId: string,
    officialId: string,
  ): Promise<ApplicationCollision[]> {
    const res = await client.query<{
      draft_id: string;
      official_id: string;
      worker_id: string;
      draft_stage: string | null;
      official_stage: string | null;
    }>(
      `SELECT d.id AS draft_id, o.id AS official_id, d.worker_id,
              d.application_funnel_stage AS draft_stage, o.application_funnel_stage AS official_stage
         FROM worker_job_applications d
         JOIN worker_job_applications o ON o.worker_id = d.worker_id AND o.job_posting_id = $2
        WHERE d.job_posting_id = $1
        ORDER BY d.worker_id
        FOR UPDATE OF d, o`,
      [draftId, officialId],
    );
    return res.rows.map((r) => ({
      draftApplicationId: r.draft_id,
      officialApplicationId: r.official_id,
      workerId: r.worker_id,
      draftStage: r.draft_stage,
      officialStage: r.official_stage,
    }));
  }

  /**
   * Funde a postulação do rascunho na da oficial e apaga a do rascunho — mesma ordem da reconciliação de cadastros
   * fundidos: trilha e notas ANTES do DELETE (FK ON DELETE CASCADE, migrations 169/204), campos vazios por
   * `mergeEmptyColumns` (a oficial vence onde já tem valor), e a etapa pela regra própria (`stage` já decidido).
   */
  async mergeCollidingApplication(
    client: PoolClient,
    c: ApplicationCollision,
    draftId: string,
    officialId: string,
    stage: string | null,
  ): Promise<void> {
    await client.query(
      `UPDATE worker_job_application_stage_history SET application_id = $1 WHERE application_id = $2`,
      [c.officialApplicationId, c.draftApplicationId],
    );
    await client.query(
      `UPDATE wja_contact_notes SET worker_job_application_id = $1, job_posting_id = $2
        WHERE worker_job_application_id = $3 OR (worker_id = $4 AND job_posting_id = $5)`,
      [c.officialApplicationId, officialId, c.draftApplicationId, c.workerId, draftId],
    );
    await mergeEmptyColumns(client, {
      table: 'worker_job_applications',
      keyColumns: APPLICATION_KEY_COLUMNS,
      srcId: c.draftApplicationId,
      dstId: c.officialApplicationId,
    });
    if (stage !== null) {
      // O trigger da trilha (migration 169) grava a mudança com o ator da transação.
      await client.query(
        `UPDATE worker_job_applications SET application_funnel_stage = $2, updated_at = NOW() WHERE id = $1`,
        [c.officialApplicationId, stage],
      );
    }
    await client.query(`DELETE FROM worker_job_applications WHERE id = $1`, [c.draftApplicationId]);
  }

  /** Encuadre do mesmo worker nas duas vagas: completa o da oficial, move a fila de ambiguidade, apaga o do rascunho. */
  async mergeCollidingEncuadres(client: PoolClient, draftId: string, officialId: string): Promise<number> {
    const res = await client.query<{ draft_id: string; official_id: string }>(
      `SELECT d.id AS draft_id, o.id AS official_id
         FROM encuadres d
         JOIN encuadres o ON o.worker_id = d.worker_id AND o.job_posting_id = $2
        WHERE d.job_posting_id = $1
        ORDER BY d.id
        FOR UPDATE OF d, o`,
      [draftId, officialId],
    );
    for (const r of res.rows) {
      await mergeEmptyColumns(client, {
        table: 'encuadres',
        keyColumns: ENCUADRE_KEY_COLUMNS,
        srcId: r.draft_id,
        dstId: r.official_id,
      });
      await client.query(`UPDATE encuadre_ambiguity_queue SET encuadre_id = $1 WHERE encuadre_id = $2`, [
        r.official_id,
        r.draft_id,
      ]);
      await client.query(`DELETE FROM encuadres WHERE id = $1`, [r.draft_id]);
    }
    return res.rows.length;
  }

  /** Reparent de tudo que sobrou no rascunho (já sem colisão). A trilha segue a postulação pelo `application_id`. */
  async reparentToOfficial(client: PoolClient, draftId: string, officialId: string): Promise<void> {
    for (const [table, column] of REPARENT_COLUMNS) {
      await client.query(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`, [draftId, officialId]);
    }
  }

  /** Os 5 campos de recrutamento do serviço, no formato do portão (`ServiceRecruitmentFields`). undefined = serviço não existe. */
  async readServiceRecruitmentFields(client: PoolClient, serviceId: string): Promise<ServiceRecruitmentFields | undefined> {
    const res = await client.query<{
      required_professions: string[] | null;
      required_sex: string | null;
      required_experience: string | null;
      work_schedule: string | null;
      payment_day: string | null;
    }>(
      `SELECT required_professions, required_sex, required_experience, work_schedule, payment_day
         FROM patient_contracted_services WHERE id = $1`,
      [serviceId],
    );
    return res.rows.map((r) => ({
      requiredProfessions: r.required_professions,
      requiredSex: r.required_sex,
      requiredExperience: r.required_experience,
      workSchedule: r.work_schedule,
      paymentDay: r.payment_day,
    }))[0];
  }

  /** Endereço VIVO do serviço (arquivado = ausente — mesmo critério de `lockRecruitmentContext`). */
  async readServiceLiveAddress(client: PoolClient, serviceId: string): Promise<string | null> {
    const res = await client.query<{ id: string }>(
      `SELECT pa.id FROM patient_contracted_services pcs
         JOIN patient_addresses pa ON pa.id = pcs.address_id AND pa.archived_at IS NULL
        WHERE pcs.id = $1`,
      [serviceId],
    );
    return res.rows[0]?.id ?? null;
  }

  /** "Endereço divergente: vale o do serviço" (Gabriel, 03/11) — alinha a vaga antes do vínculo. */
  async alignVacancyAddress(client: PoolClient, vacancyId: string, addressId: string): Promise<void> {
    await client.query(`UPDATE job_postings SET patient_address_id = $2, updated_at = NOW() WHERE id = $1`, [
      vacancyId,
      addressId,
    ]);
  }
}

/** Whitelist FIXA (nunca interpolar nome de fora). Roda DEPOIS das fusões: não sobra colisão na UNIQUE. */
const REPARENT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['worker_job_applications', 'job_posting_id'],
  ['wja_contact_notes', 'job_posting_id'],
  ['encuadres', 'job_posting_id'],
  ['talentum_prescreenings', 'job_posting_id'],
  ['funnel_stage_message_log', 'job_posting_id'],
  ['encuadre_ambiguity_queue', 'resolved_job_posting_id'],
];
