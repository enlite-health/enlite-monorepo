/**
 * UpdateTalentumDescriptionUseCase
 *
 * Persiste uma descrição EDITADA MANUALMENTE em job_postings.talentum_description
 * e, se a vaga já estiver publicada no Talentum, propaga a edição in-place via
 * `updatePrescreening` (PUT) — preservando projectId / whatsappUrl / slug e a
 * identidade das perguntas (`questionId`), diferente de despublicar+republicar.
 *
 * Difere de TalentumDescriptionService.generateDescription: aqui o texto vem do
 * OPERADOR (não do Gemini). Não regenera nada.
 *
 * Ordem deliberada: PROPAGA no Talentum PRIMEIRO, grava local DEPOIS. Se a API do
 * Talentum falhar, nada é persistido — o banco (fonte da vitrine pública) nunca
 * fica divergente do que está no ar. Só é possível divergir se o COMMIT local
 * falhar após um PUT 204, caso raro que fica logado para reconciliação.
 *
 * Auditoria best-effort via logEventSafe (SAVEPOINT): falha do INSERT de auditoria
 * não derruba o UPDATE.
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { TalentumApiClient } from '../infrastructure/TalentumApiClient';
import {
  JobPostingAuditRepository,
  type AuditActorType,
} from '../../matching/infrastructure/JobPostingAuditRepository';

// ─────────────────────────────────────────────────────────────────
// Input / Output types
// ─────────────────────────────────────────────────────────────────

interface UpdateDescriptionInput {
  jobPostingId: string;
  description: string;
}

interface UpdateDescriptionOutput {
  description: string;
  /** true se a edição foi propagada in-place a um projeto Talentum já publicado. */
  propagated: boolean;
}

export interface AuditActor {
  actorUserId: string | null;
  actorType: AuditActorType;
  actorLabel: string;
  traceId?: string | null;
}

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class UpdateTalentumDescriptionUseCase {
  private db: Pool;
  private auditRepo: JobPostingAuditRepository;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.auditRepo = new JobPostingAuditRepository();
  }

  async execute(
    input: UpdateDescriptionInput,
    actor?: AuditActor,
  ): Promise<UpdateDescriptionOutput> {
    const { jobPostingId } = input;
    const description = (input.description ?? '').trim();
    if (!description) {
      throw new UpdateDescriptionError(400, 'Description must not be empty');
    }

    // 1. Load vacancy + validate
    const jpResult = await this.db.query(
      `SELECT id, title, talentum_project_id, talentum_description
       FROM job_postings WHERE id = $1 AND deleted_at IS NULL`,
      [jobPostingId],
    );
    if (jpResult.rows.length === 0) {
      throw new UpdateDescriptionError(404, `Vacancy ${jobPostingId} not found`);
    }
    const vacancy = jpResult.rows[0] as {
      title: string | null;
      talentum_project_id: string | null;
      talentum_description: string | null;
    };
    const before = vacancy.talentum_description;

    // 2. Propaga PRIMEIRO se já publicada (in-place, preservando questions/questionId)
    let propagated = false;
    if (vacancy.talentum_project_id) {
      let talentumClient: TalentumApiClient;
      try {
        talentumClient = await TalentumApiClient.create();
      } catch (err: unknown) {
        throw new UpdateDescriptionError(
          502,
          `Failed to initialize Talentum client: ${(err as Error).message}`,
        );
      }

      // GET reler o projeto → questions com questionId + faq + título vigente,
      // reenviados intactos para que o PUT só troque a descrição.
      let project;
      try {
        project = await talentumClient.getPrescreening(vacancy.talentum_project_id);
      } catch (err: unknown) {
        throw new UpdateDescriptionError(502, `Talentum API error (get): ${(err as Error).message}`);
      }

      try {
        await talentumClient.updatePrescreening(vacancy.talentum_project_id, {
          title: project.title,
          description,
          questions: project.questions,
          faq: project.faq,
        });
      } catch (err: unknown) {
        const msg = (err as Error).message;
        // Achado em prod (27/07): o Talentum tem dono por projeto. Projetos criados
        // por OUTRA conta (recrutadora direto na UI, entram via sync inbound) são
        // legíveis mas NÃO graváveis pela nossa conta → PUT 403. Traduzimos para uma
        // mensagem acionável (409, condição permanente) em vez de um 502 transitório.
        if (msg.includes('HTTP 403') || msg.toLowerCase().includes('not allowed to access')) {
          throw new UpdateDescriptionError(
            409,
            'Esta vacante fue creada directamente en Talentum por otra cuenta, así que su ' +
              'descripción no puede editarse desde el panel. Editala en Talentum.',
          );
        }
        throw new UpdateDescriptionError(502, `Talentum API error (update): ${msg}`);
      }
      propagated = true;
    }

    // 3. Persiste local + auditoria UPDATED (transação)
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE job_postings SET talentum_description = $1, updated_at = NOW() WHERE id = $2`,
        [description, jobPostingId],
      );
      if (actor) {
        await this.auditRepo.logEventSafe(client, {
          jobPostingId,
          eventType: 'UPDATED',
          fieldName: 'talentum_description',
          changes: { before, after: description },
          actorUserId: actor.actorUserId,
          actorType: actor.actorType,
          actorLabel: actor.actorLabel,
          traceId: actor.traceId ?? null,
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // PUT já pode ter alterado o Talentum: sinaliza divergência para reconciliação.
      if (propagated) {
        console.error(
          `[UpdateTalentumDesc] DIVERGENCE: Talentum project ${vacancy.talentum_project_id} ` +
            `updated but local persist failed for job_posting ${jobPostingId}`,
        );
      }
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `[UpdateTalentumDesc] Description saved for job_posting ${jobPostingId} (propagated=${propagated})`,
    );
    return { description, propagated };
  }
}

// ─────────────────────────────────────────────────────────────────
// Custom error with HTTP status
// ─────────────────────────────────────────────────────────────────

export class UpdateDescriptionError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'UpdateDescriptionError';
  }
}
