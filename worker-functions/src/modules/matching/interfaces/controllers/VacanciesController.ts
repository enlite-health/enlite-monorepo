import { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  buildListVacanciesQuery,
  mapVacancyListRow,
  VacancyListRow,
} from './vacancyListHelpers';
import { normalizeSchedule } from '../../infrastructure/scheduleNormalizer';
import { AdminVacancyDetailSchema } from '../schemas/AdminVacancyDetailSchema';
import { reportError } from '@shared/logging';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { cellsOfRequest, projectWorkerFields, ProjecaoSemDecryptorError } from '@modules/identity/permissions';
import { projectPatientInVacancy } from '../../application/patientInVacancyProjection';

/**
 * Decryptor da rota `GET /vacancies/:id`: os campos de prestador aqui já vêm em
 * TEXTO CLARO do SQL, então nenhum ramo da projeção tem cifra para abrir. Se
 * este `decrypt` for chamado, é porque alguém passou um campo `*Encrypted` para
 * a projeção sem trazer o KMS de verdade — e aí falhar alto é o certo, não
 * devolver string vazia em silêncio.
 */
const SEM_KMS = {
  async decrypt(): Promise<string> {
    // Sentinela, não `Error` cru: o `abrir()` da projeção engole exceção de
    // runtime de propósito (oscilação de KMS não derruba o Kanban), e um
    // `Error` comum virava `null` em silêncio — a promessa "falhar alto" deste
    // bloco era letra morta. Achado ALTO do gate `revisao-pr`.
    throw new ProjecaoSemDecryptorError('VacanciesController: esta rota não descriptografa — campo cifrado chegou à projeção');
  },
};

/**
 * VacanciesController
 *
 * Core read-only endpoints for the AdminVacanciesPage.
 *
 * Write endpoints (create/update/delete) → VacancyCrudController
 * Match/enrichment/encuadre endpoints   → VacancyMatchController
 * Talentum/prescreening endpoints        → VacancyTalentumController
 * Auxiliary read endpoints               → VacanciesAuxController
 *   (in-progress, by-address, pending-address-review, filter-options)
 */

export class VacanciesController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  async listVacancies(req: Request, res: Response): Promise<void> {
    try {
      const {
        search, status, priority,
        worker_type, state, city, required_sex,
        days, time_from, time_to,
        limit = '20', offset = '0',
      } = req.query;

      const { baseQuery, params, paramIndex } = buildListVacanciesQuery({
        search, status, priority,
        workerType: worker_type,
        state,
        city,
        requiredSex: required_sex,
        days,
        timeFrom: time_from,
        timeTo: time_to,
        limit: limit as string,
        offset: offset as string,
      });

      const countQuery = `SELECT COUNT(*) as total FROM (${baseQuery}) as count_query`;
      const countResult = await this.db.query(countQuery, params);
      const total = parseInt(countResult.rows[0]?.total || '0');

      const finalQuery =
        baseQuery +
        ` ORDER BY jp.created_at DESC` +
        ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(parseInt(limit as string), parseInt(offset as string));

      const result = await this.db.query(finalQuery, params);
      // D286 fase 2: nome do paciente na lista segue `patient_identity:read`, não `vacancy:read`.
      const cellsDaLista = cellsOfRequest(req);
      const vacancies = (result.rows as VacancyListRow[]).map((r) => mapVacancyListRow(projectPatientInVacancy(r, cellsDaLista)));

      res.status(200).json({
        success: true,
        data: vacancies,
        total,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(
        error instanceof Error ? error : new Error(msg),
        { source: 'VacanciesController:listVacancies' },
      );
      res.status(500).json({ success: false, error: 'Failed to list vacancies', details: msg });
    }
  }

  async getVacanciesStats(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query(`
        SELECT
          COUNT(*) FILTER (
            WHERE search_start_date IS NOT NULL
              AND EXTRACT(DAY FROM NOW() - search_start_date) > 7
              AND status IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE')
          ) as mais_7_dias,
          COUNT(*) FILTER (
            WHERE search_start_date IS NOT NULL
              AND EXTRACT(DAY FROM NOW() - search_start_date) > 24
              AND status IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE')
          ) as mais_24_dias,
          COUNT(DISTINCT jp.id) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM encuadres e WHERE e.job_posting_id = jp.id
            )
          ) as em_selecao,
          COUNT(*) FILTER (
            WHERE status IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE')
          ) as total_vacantes,
          AVG(
            CASE
              WHEN search_start_date IS NOT NULL
                AND status NOT IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE')
              THEN EXTRACT(EPOCH FROM (updated_at - search_start_date)) / 3600
              ELSE NULL
            END
          ) as tempo_medio_fechamento
        FROM job_postings jp
        WHERE case_number IS NOT NULL AND deleted_at IS NULL
      `);

      const stats = result.rows[0];
      const formattedStats = [
        { label: '+7 dias',     value: stats.mais_7_dias?.toString() || '0',  icon: 'clock' as const },
        { label: '+24 dias',    value: stats.mais_24_dias?.toString() || '0', icon: 'clock' as const },
        { label: 'Em seleção',  value: stats.em_selecao?.toString() || '0',   icon: 'user-check' as const },
        {
          label: 'Total de Vacantes',
          value: stats.tempo_medio_fechamento
            ? `${Math.round(parseFloat(stats.tempo_medio_fechamento))}h`
            : '0h',
          icon: 'user-search' as const,
        },
      ];

      res.status(200).json({ success: true, data: formattedStats });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(
        error instanceof Error ? error : new Error(msg),
        { source: 'VacanciesController:getVacanciesStats' },
      );
      res.status(500).json({ success: false, error: 'Failed to fetch vacancies stats', details: msg });
    }
  }

  /**
   * `GET /api/admin/vacancies/:id`
   *
   * ⚠️ Esta rota NÃO devolve o diagnóstico do paciente (C1 do veredito do `lex`):
   * texto clínico livre não sai sob `vacancy:read`. Guarda de regressão em
   * `__tests__/diagnosticoForaDaVaga.test.ts`, que assere a QUERY — não a
   * resposta, porque apagar o campo depois do `SELECT` é esconder da tela.
   *
   * Os encuadres embutidos passam por `projectWorkerFields` (F2/C3): nome e
   * telefone do prestador saem daqui em texto claro do `json_agg`, então a prova
   * desta rota é a fronteira, e não o espião no KMS.
   */
  async getVacancyById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await this.db.query(`
        SELECT
          jp.*,
          jp.closes_at as closed_at,
          p.first_name as patient_first_name,
          p.last_name as patient_last_name,
          COALESCE(pa.neighborhood, p.zone_neighborhood) as patient_zone,
          p.dependency_level as dependency_level,
          -- ATENCAO: a coluna clinica livre de patients NAO entra neste SELECT
          -- (C1 do veredito do lex). Ela saia sob vacancy:read -- a celula de quem
          -- opera a vaga, que toda recrutadora tem. Nao foi movida para tras de
          -- outra celula: foi TIRADA, porque o dado nao e necessario para operar a
          -- vaga (o requisito de perfil vem de required_professions,
          -- worker_attributes e da descricao). Quem precisar do quadro clinico le
          -- no cadastro do paciente, que tem guarda propria. Irmao do mesmo
          -- defeito: RecruitmentAnalyticsController.getCaseAnalysis.
          -- (O ponteiro para a guarda mora no JSDoc do metodo, nao aqui: comentario
          -- de SQL viaja DENTRO da query, e ate o NOME do arquivo de teste casaria
          -- a regex clinica da guarda -- D182.)
          p.insurance_verified,
          p.service_type,
          COALESCE(pa.city, p.city_locality) as patient_city,
          COALESCE(pa.neighborhood, p.zone_neighborhood) as patient_neighborhood,
          pa.address_formatted as patient_address_formatted,
          pa.address_raw as patient_address_raw,
          json_agg(
            DISTINCT jsonb_build_object(
              'id', e.id,
              'worker_name', e.worker_raw_name,
              'worker_phone', COALESCE(w.phone, e.worker_raw_phone),
              'interview_date', e.interview_date,
              'resultado', e.resultado,
              'attended', e.attended,
              'rejection_reason_category', e.rejection_reason_category,
              'rejection_reason', e.rejection_reason
            )
          ) FILTER (WHERE e.id IS NOT NULL AND ${excludeDisabledWorkersSql('w')}) as encuadres,
          json_agg(
            DISTINCT jsonb_build_object(
              'channel', pub.channel,
              'published_at', pub.published_at,
              'recruiter', pub.recruiter_name
            )
          ) FILTER (WHERE pub.id IS NOT NULL) as publications
        FROM job_postings jp
        LEFT JOIN patients p ON jp.patient_id = p.id
        LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
        LEFT JOIN encuadres e ON jp.id = e.job_posting_id
        LEFT JOIN workers w ON e.worker_id = w.id
        LEFT JOIN publications pub ON jp.id = pub.job_posting_id
        WHERE jp.id = $1
        GROUP BY jp.id, p.id, pa.id
      `, [id]);

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Vacancy not found' });
        return;
      }

      const row = result.rows[0];

      // F2/C3 — os encuadres embutidos carregam NOME e TELEFONE do prestador
      // sob `vacancy:read`. Aqui não há KMS a economizar: `e.worker_raw_name` e
      // `COALESCE(w.phone, e.worker_raw_phone)` já saem do SQL em texto claro.
      // Logo a prova desta rota NÃO é o espião com 0 chamadas — é a fronteira:
      // o nome não pode aparecer em NENHUM lugar do corpo da resposta.
      // `cells === null` = engine não decidiu → devolve como antes (D113).
      const cells = cellsOfRequest(req);
      const encuadresBrutos = Array.isArray(row.encuadres) ? row.encuadres : null;
      const encuadres = encuadresBrutos
        ? await Promise.all(
            encuadresBrutos.map(async (e: Record<string, unknown>) => {
              const visivel = await projectWorkerFields(
                cells,
                {
                  rawName: (e.worker_name as string | null) ?? null,
                  phone: (e.worker_phone as string | null) ?? null,
                },
                SEM_KMS,
              );
              return {
                ...e,
                worker_name: visivel.name ?? null,
                worker_phone: visivel.phone ?? null,
              };
            }),
          )
        : row.encuadres;

      // D286 fase 2: nome e endereço do PACIENTE seguem a célula do paciente (identidade,
      // endereço), não a da vaga — a mesma chave que vale na ficha dele e no mapa.
      const normalized = projectPatientInVacancy({
        ...row,
        encuadres,
        schedule: normalizeSchedule(row.schedule),
      }, cells);

      // Observe-only contract check: log shape drift without breaking requests.
      // After a stable window with no drift logged, promote to .parse() (strict).
      const parseResult = AdminVacancyDetailSchema.safeParse(normalized);
      if (!parseResult.success) {
        reportError(
          new Error('AdminVacancyDetail response shape drift'),
          {
            source: 'VacanciesController:getVacancyById',
            vacancyId: id,
            issues: parseResult.error.issues.map((i) => ({
              path: i.path.join('.'),
              code: i.code,
              message: i.message,
            })),
          },
        );
      }

      res.status(200).json({ success: true, data: normalized });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(
        error instanceof Error ? error : new Error(msg),
        { source: 'VacanciesController:getVacancyById' },
      );
      res.status(500).json({ success: false, error: 'Failed to fetch vacancy', details: msg });
    }
  }

  async getNextVacancyNumber(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query(
        `SELECT nextval('job_postings_vacancy_number_seq') AS next_vacancy_number`,
      );
      const nextVacancyNumber = parseInt(result.rows[0].next_vacancy_number);
      res.status(200).json({ success: true, data: { nextVacancyNumber } });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(
        error instanceof Error ? error : new Error(msg),
        { source: 'VacanciesController:getNextVacancyNumber' },
      );
      res.status(500).json({ success: false, error: 'Failed to get next vacancy number' });
    }
  }

  async getCasesForSelect(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query(`
        SELECT
          p.case_number   AS "caseNumber",
          p.id            AS "patientId",
          COALESCE(p.dependency_level, '') AS "dependencyLevel"
        FROM patients p
        WHERE p.case_number IS NOT NULL
          AND p.deleted_at IS NULL
          AND p.status IN ('ACTIVE', 'PENDING_ADMISSION', 'ADMISSION')
          AND EXISTS (
            SELECT 1 FROM patient_addresses pa
              WHERE pa.patient_id = p.id
                AND pa.archived_at IS NULL
          )
        ORDER BY p.case_number DESC
      `);
      res.status(200).json({ success: true, data: result.rows });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(
        error instanceof Error ? error : new Error(msg),
        { source: 'VacanciesController:getCasesForSelect' },
      );
      res.status(500).json({ success: false, error: 'Failed to fetch cases for select' });
    }
  }
}
