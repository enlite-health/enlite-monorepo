import { Request, Response } from 'express';
import { sendVacancyDeBajaReadOnly } from './vacancyDeBajaGuard';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { reportError } from '@shared/logging';
import { MatchmakingService } from '../../infrastructure/MatchmakingService';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  excludeDisabledWorkersSql,
  workerNotDisabledSql,
} from '@shared/database/activeWorkerFilter';
import { UpdateEncuadreResultUseCase } from '../../application/UpdateEncuadreResultUseCase';
import { EncuadreResultado, RejectionReasonCategory } from '../../domain/Encuadre';
import { cellsOfRequest, projectWorkerFields, NOME_REDIGIDO } from '@modules/identity/permissions';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import { distanceKmSql, nearestServiceAreaLateralSql, repliedSql } from '../../infrastructure/candidateDistanceSql';
import { operationDateOf } from '@shared/locale/operationDate';

/** Teto do `limit` do GET `match-results` (emenda 06/11 da spec 089: prd mediu máx 438 prestadores até 50 km). */
export const MATCH_RESULTS_MAX_LIMIT = 500;

/**
 * VacancyMatchController
 *
 * Match, match-results, and encuadre endpoints.
 * Split from VacanciesController to respect the 400-line limit.
 */
export class VacancyMatchController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  async triggerMatch(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const topN                   = req.query.top_n     ? parseInt(req.query.top_n as string)     : 20;
      const radiusKm               = req.query.radius_km ? parseInt(req.query.radius_km as string) : undefined;
      const excludeWithActiveCases = req.query.exclude_active === 'true';

      const jobRes = await this.db.query<{ id: string; status: string | null }>(
        `SELECT id, status FROM job_postings WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [id],
      );
      if (jobRes.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Job posting not found' });
        return;
      }
      // Spec 084 (P4/R6): o Match não roda em vaga dada de baja — o recrutamento não trabalha vaga sem serviço contratado.
      if (jobRes.rows[0].status === 'DE_BAJA') {
        sendVacancyDeBajaReadOnly(res);
        return;
      }

      const matchingService = new MatchmakingService();
      const result = await matchingService.matchWorkersForJob(id, {
        topN,
        radiusKm,
        excludeWithActiveCases,
      });

      res.status(200).json({ success: true, data: result });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'VacancyMatchController:triggerMatch' });
      res.status(500).json({ success: false, error: 'Failed to run matchmaking', details: e.message });
    }
  }

  async getMatchResults(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      // Spec 089 (emenda 06/11): teto 500. `limit=0` é válido (só meta — contador do botão da vacante).
      const rawLimit = parseInt((req.query.limit as string) || '50', 10);
      const limit    = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 0), MATCH_RESULTS_MAX_LIMIT);
      const rawOffset = parseInt((req.query.offset as string) || '0', 10);
      const offset   = Number.isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0);
      const requestNow = new Date();

      // Meta numa query só. Contagens por PESSOA (DISTINCT worker) e só de worker não desativado, a mesma regra da lista.
      //   invitedCount          = DF-4: messaged_at IS NOT NULL.
      //   pendingInVacancyCount = ⚑4 (contador do F0): INVITED, sem WhatsApp, source='manual', sem resposta.
      const metaResult = await this.db.query<{
        total: string; last_match_at: Date | null; invited: string; pending: string;
        country: string | null; lat: string | null; lng: string | null; address_label: string | null;
      }>(
        `SELECT
           COUNT(DISTINCT wja.worker_id)::text AS total,
           MAX(wja.updated_at) AS last_match_at,
           COUNT(DISTINCT wja.worker_id) FILTER (WHERE wja.messaged_at IS NOT NULL)::text AS invited,
           COUNT(DISTINCT wja.worker_id) FILTER (
             WHERE wja.application_funnel_stage = 'INVITED' AND wja.messaged_at IS NULL
               AND wja.source = 'manual' AND NOT ${repliedSql('wja.interview_response')}
           )::text AS pending,
           MAX(jpx.country) AS country,
           MAX(pax.lat)::text AS lat,
           MAX(pax.lng)::text AS lng,
           MAX(COALESCE(NULLIF(pax.address_formatted, ''), NULLIF(pax.address_raw, ''))) AS address_label
         FROM job_postings jpx
         LEFT JOIN patient_addresses pax ON pax.id = jpx.patient_address_id
         LEFT JOIN worker_job_applications wja ON wja.job_posting_id = jpx.id
           -- total tem que bater com a lista abaixo (que exclui baixados)
           AND ${workerNotDisabledSql('wja.worker_id')}
         WHERE jpx.id = $1`,
        [id]
      );
      const meta = metaResult.rows[0];
      const totalCandidates = parseInt(meta?.total || '0', 10);
      const lastMatchAt     = meta?.last_match_at ?? null;
      const invitedCount    = parseInt(meta?.invited || '0', 10);
      const pendingInVacancyCount = parseInt(meta?.pending || '0', 10);
      // Sem coordenada = null, nunca 0 (um 0 desenharia o serviço no Golfo da Guiné).
      const serviceLat = meta?.lat != null ? parseFloat(meta.lat) : null;
      const serviceLng = meta?.lng != null ? parseFloat(meta.lng) : null;
      const hasPoint   = serviceLat !== null && serviceLng !== null;
      const service = {
        lat: hasPoint ? serviceLat : null,
        lng: hasPoint ? serviceLng : null,
        addressLabel: meta?.address_label ?? null,
      };
      // Dia de operação do PAÍS DA VACANTE (SUP-5), pelo único dono da conta. País vazio = default da coluna (AR).
      const operationDate = operationDateOf(meta?.country ?? 'AR', requestNow);

      // F7.c (ADR-004): application_status removido do SELECT; source + application_funnel_stage
      // adicionados para derivar alreadyApplied sem depender do campo depreciado.
      // Spec 089: uma linha por prestador — área viva mais próxima (LATERAL) e documentos por LATERAL LIMIT 1 (SUP-1).
      const result = limit === 0 ? { rows: [] as any[] } : await this.db.query(
        `SELECT
           wja.worker_id,
           wja.match_score,
           wja.internal_notes,
           wja.source,
           wja.application_funnel_stage,
           wja.messaged_at,
           ${repliedSql('wja.interview_response')} AS replied,
           w.phone,
           w.first_name_encrypted,
           w.last_name_encrypted,
           w.occupation,
           w.status,
           wd.documents_status,
           wsa.work_zone,
           wsa.latitude  AS area_lat,
           wsa.longitude AS area_lng,
           ${distanceKmSql('wsa.location', 'pa.lat', 'pa.lng')} AS distance_km,
           (
             SELECT COUNT(*)::int
             FROM encuadres ea
             JOIN job_postings jp2 ON jp2.id = ea.job_posting_id
             WHERE ea.worker_id = w.id
               AND ea.resultado = 'SELECCIONADO'
               AND jp2.is_covered = false
           ) AS active_cases_count
         FROM worker_job_applications wja
         JOIN workers w    ON w.id  = wja.worker_id
         JOIN job_postings jp ON jp.id = wja.job_posting_id
         LEFT JOIN LATERAL (
           SELECT d.documents_status FROM worker_documents d WHERE d.worker_id = w.id ORDER BY d.updated_at DESC NULLS LAST LIMIT 1
         ) wd ON true
         LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
         ${nearestServiceAreaLateralSql()}
         WHERE wja.job_posting_id = $1
           -- worker que deu baixa na conta não é candidato contatável
           AND ${excludeDisabledWorkersSql('w')}
         ORDER BY distance_km ASC NULLS LAST, wja.worker_id
         LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      );

      const kms = new KMSEncryptionService();
      // F2/C3: a célula decide ANTES do KMS. `cells === null` = engine não
      // decidiu nesta request (a família ainda está fora de
      // PERMISSION_ENFORCED_ROUTES) e a projeção devolve o que esta rota já
      // devolvia — D113. NUNCA `?? []` aqui.
      const cells = cellsOfRequest(req);
      const candidates = await Promise.all(
        result.rows.map(async row => {
          const visivel = await projectWorkerFields(cells, {
            phone: row.phone,
            firstNameEncrypted: row.first_name_encrypted,
            lastNameEncrypted: row.last_name_encrypted,
          }, kms);
          // O pseudônimo só entra quando a projeção AUTORIZOU o nome e não
          // achou nenhum — nunca por cima da redação.
          const workerName = visivel.name ?? 'Nome não disponível';

          return {
            workerId:          row.worker_id,
            workerName,
            workerPhone:       visivel.phone ?? null,
            occupation:        row.occupation,
            workZone:          row.work_zone,
            distanceKm:        row.distance_km,
            // Spec 089: lat/lng da MESMA área que deu a distância (DECIMAL chega como string do pg).
            lat:               row.area_lat != null ? parseFloat(row.area_lat) : null,
            lng:               row.area_lng != null ? parseFloat(row.area_lng) : null,
            activeCasesCount:  row.active_cases_count ?? 0,
            workerStatus:      row.status,
            documentStatus:    row.documents_status ?? null,
            source:            row.source,
            funnelStage:       row.application_funnel_stage ?? null,
            replied:           row.replied === true,
            matchScore:        row.match_score !== null ? parseFloat(row.match_score) : null,
            internalNotes:     row.internal_notes,
            // F7.c (ADR-004): applicationStatus REMOVIDO. alreadyApplied agora deriva da combinação
            // source != 'system' OR messaged_at != null OR funnel_stage != 'INVITED'.
            // Lógica: "worker chegou por canal ≠ match, OU já foi contatado, OU já avançou no funil".
            alreadyApplied:
              row.source !== 'system'
              || row.messaged_at !== null
              || row.application_funnel_stage !== 'INVITED',
            messagedAt:        row.messaged_at,
          };
        })
      );

      emitirTrilhaDeContato(
        req,
        candidates.map((c) => (c.workerName === NOME_REDIGIDO ? null : (c.workerId as string | null))),
      );

      res.status(200).json({
        success: true,
        data: {
          jobPostingId: id, lastMatchAt, totalCandidates, service,
          invitedCount, pendingInVacancyCount, operationDate, candidates,
        },
      });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'VacancyMatchController:getMatchResults' });
      res.status(500).json({ success: false, error: 'Failed to fetch match results', details: e.message });
    }
  }

  async updateEncuadreResult(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { resultado, rejectionReasonCategory, rejectionReason } = req.body;

      if (!resultado) {
        res.status(400).json({ success: false, error: 'resultado is required' });
        return;
      }

      const validResultados: EncuadreResultado[] = [
        'SELECCIONADO', 'RECHAZADO', 'AT_NO_ACEPTA', 'REPROGRAMAR', 'REEMPLAZO', 'BLACKLIST', 'PENDIENTE'
      ];
      if (!validResultados.includes(resultado)) {
        res.status(400).json({ success: false, error: `Invalid resultado: ${resultado}` });
        return;
      }

      const validCategories: (RejectionReasonCategory | null | undefined)[] = [
        'DISTANCE', 'SCHEDULE_INCOMPATIBLE', 'INSUFFICIENT_EXPERIENCE',
        'SALARY_EXPECTATION', 'WORKER_DECLINED', 'OVERQUALIFIED',
        'DEPENDENCY_MISMATCH', 'OTHER', null, undefined
      ];
      if (rejectionReasonCategory && !validCategories.includes(rejectionReasonCategory)) {
        res.status(400).json({ success: false, error: `Invalid rejectionReasonCategory: ${rejectionReasonCategory}` });
        return;
      }

      const useCase = new UpdateEncuadreResultUseCase();
      const result = await useCase.execute({
        encuadreId: id,
        resultado,
        rejectionReasonCategory: rejectionReasonCategory ?? null,
        rejectionReason: rejectionReason ?? null,
      });

      res.json({ success: true, data: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const status = message.includes('not found') ? 404 : 500;
      res.status(status).json({ success: false, error: message });
    }
  }
}
