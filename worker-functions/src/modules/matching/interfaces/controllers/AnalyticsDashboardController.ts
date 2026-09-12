/**
 * AnalyticsDashboardController
 *
 * Dashboard-specific analytics endpoints, extracted from AnalyticsController
 * to keep both files under the 400-line limit.
 *
 * Rotas (registradas em analyticsRoutes.ts via AnalyticsController extends):
 *   GET /analytics/dashboard/global?startDate=&endDate=&country=AR
 *   GET /analytics/dashboard/cases/:caseNumber?startDate=&endDate=
 *   GET /analytics/dashboard/zones?country=AR
 *   GET /analytics/dashboard/reemplazos?country=AR
 *   GET /analytics/dashboard/zone-analytics?profession=
 */

import { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { PublicationRepository } from '@modules/audit';
import { ClickUpCaseRepository } from '../../../../infrastructure/repositories/ClickUpCaseRepository';
import { EncuadreRepository } from '../../infrastructure/EncuadreRepository';
import { WorkerApplicationRepository } from '../../infrastructure/WorkerApplicationRepository';
import { JobPostingARRepository } from '../../infrastructure/JobPostingARRepository';
import { GetManagementDashboardUseCase } from '../../application/GetManagementDashboardUseCase';
import { GetZoneAnalyticsUseCase } from '../../application/GetZoneAnalyticsUseCase';
import { zoneAnalyticsQuerySchema } from '../../application/zoneAnalyticsSchema';
import { cellsOfRequest } from '@modules/identity/permissions';
import { resolveCountryScope, CountryScopeError } from '@modules/identity';
import { currentDbContext } from '@shared/database/requestDbSession';
import { projectManagementDashboard } from '../../application/dashboardContainerAccess';

export class AnalyticsDashboardController {
  protected db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  /**
   * GET /analytics/dashboard/global?startDate=&endDate=&country=AR
   * Métricas globais para o painel principal do Dashboard.
   */
  async getGlobalMetrics(req: Request, res: Response): Promise<void> {
    try {
      const { startDate, endDate, country = 'AR' } = req.query as Record<string, string>;
      const filters = { startDate, endDate, country };

      const clickUpRepo     = new ClickUpCaseRepository();
      const encuadreRepo    = new EncuadreRepository();
      const publicationRepo = new PublicationRepository();

      // Count workers by platform status (replaces old overall_status funnel grouping)
      const countByStatus = async (status: string): Promise<number> => {
        const conditions: string[] = [`w.status = $1`];
        const values: unknown[] = [status];
        let idx = 2;
        if (filters.startDate) { conditions.push(`w.created_at >= $${idx++}`); values.push(filters.startDate); }
        if (filters.endDate)   { conditions.push(`w.created_at <= $${idx++}`); values.push(filters.endDate); }
        if (filters.country)   { conditions.push(`w.country = $${idx++}`);     values.push(filters.country); }
        const { rows } = await this.db.query(
          `SELECT COUNT(*)::int AS count FROM workers w WHERE ${conditions.join(' AND ')}`,
          values
        );
        return (rows[0]?.count as number) ?? 0;
      };

      const [activeCases, postulantesCount, candidatosCount, publicationsByChannel, encuadresCount] =
        await Promise.all([
          clickUpRepo.findActiveCases(country),
          countByStatus('REGISTERED'),
          countByStatus('INCOMPLETE_REGISTER'),
          publicationRepo.countByChannel(filters),
          encuadreRepo.countAttended(filters),
        ]);

      const busquedaCount   = activeCases.filter(c => c.status === 'SEARCHING').length;
      const reemplazoCount  = activeCases.filter(c => c.status === 'SEARCHING_REPLACEMENT').length;
      const totalPubs       = publicationsByChannel.reduce((s, p) => s + p.count, 0);

      res.json({
        success: true,
        data: {
          activeCasesCount:           activeCases.length,
          busquedaCount,
          reemplazoCount,
          postulantesInTalentumCount: postulantesCount,
          candidatosEnProgresoCount:  candidatosCount,
          totalPubs,
          pubChartData:               publicationsByChannel.map(p => ({ name: p.channel ?? 'Sin canal', value: p.count })),
          cantidadEncuadres:          encuadresCount,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  /**
   * GET /analytics/dashboard/management?funnelPeriodDays=7|30|90&country=AR|BR|ALL
   * "Dashboard para Gestão à Vista" (ClickUp 86ajb4qnw): big numbers operacionais,
   * prioridades de contato, totalização do funil e cadastros. Read-only, sem PII.
   * `funnelPeriodDays` (opcional) filtra o funil por prestador pela ENTRADA da
   * candidatura (call 22/07); ausente = tudo. Valor fora do conjunto é 400.
   *
   * `country` (PR-9, `lex` #9, FR-730/731): resolvido NO SERVIDOR por
   * `resolveCountryScope` — nunca gated por `COUNTRY_RLS_ENABLED` (L9-3). País
   * fora do escopo do ator → 403 `COUNTRY_SCOPE_REQUIRED`; valor fora de
   * AR|BR|ALL → 400.
   */
  async getManagementMetrics(req: Request, res: Response): Promise<void> {
    try {
      const rawPeriod = req.query.funnelPeriodDays;
      let funnelPeriodDays: number | undefined;
      if (rawPeriod !== undefined) {
        if (typeof rawPeriod !== 'string' || !['7', '30', '90'].includes(rawPeriod)) {
          res.status(400).json({
            success: false,
            error: 'funnelPeriodDays deve ser 7, 30 ou 90 (ou ausente para todo o período)',
          });
          return;
        }
        funnelPeriodDays = Number(rawPeriod);
      }

      let scope;
      try {
        scope = await resolveCountryScope(this.db, currentDbContext()?.uid, req.query.country);
      } catch (err) {
        if (err instanceof CountryScopeError) {
          res.status(err.status).json({ success: false, error: err.code, detail: err.message });
          return;
        }
        throw err;
      }

      const useCase = new GetManagementDashboardUseCase(this.db);
      const data = await useCase.execute({
        funnelPeriodDays,
        countries: scope.countries,
        requested: scope.requested,
      });
      // D286: cada bloco da tela tem célula própria — a resposta sai projetada por seção.
      res.json({ success: true, data: projectManagementDashboard(data as unknown as Record<string, unknown>, cellsOfRequest(req)) });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  /**
   * GET /analytics/dashboard/zone-analytics?profession=
   * Bloco "Analytics por Zona" do Dashboard para Gestão à Vista (ClickUp
   * 86ajb4qnw): pacientes/prestadores por zona×sexo + demanda/disponibilidade.
   * ?profession= é opcional — valores aceitos vêm do SSOT PROFESSIONS
   * (@modules/worker/domain/enums/Profession: AT|CAREGIVER|NURSE|KINESIOLOGIST|
   * PSYCHOLOGIST). Valor fora do enum é 400.
   */
  async getZoneAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const parsedQuery = zoneAnalyticsQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        res.status(400).json({ success: false, error: 'Parâmetro profession inválido' });
        return;
      }
      const useCase = new GetZoneAnalyticsUseCase(this.db);
      const data = await useCase.execute({ profession: parsedQuery.data.profession ?? null });
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  /**
   * GET /analytics/dashboard/cases/:caseNumber?startDate=&endDate=
   * Métricas detalhadas de um caso específico.
   */
  async getCaseMetrics(req: Request, res: Response): Promise<void> {
    try {
      const caseNumber = parseInt(req.params.caseNumber);
      if (isNaN(caseNumber)) {
        res.status(400).json({ success: false, error: 'caseNumber inválido' });
        return;
      }
      const { startDate, endDate } = req.query as Record<string, string>;
      const filters = { startDate, endDate };

      const clickUpRepo     = new ClickUpCaseRepository();
      const encuadreRepo    = new EncuadreRepository();
      const workerAppRepo   = new WorkerApplicationRepository();
      const publicationRepo = new PublicationRepository();
      const jobPostingRepo  = new JobPostingARRepository();

      const jobPosting = await jobPostingRepo.findByCaseNumber(caseNumber);
      if (!jobPosting) {
        res.status(404).json({ success: false, error: `Caso ${caseNumber} não encontrado em job_postings` });
        return;
      }

      const [clickUpCase, postuladosCount, candidatosCount, invitedAttended, resultados, publicationsByChannel, publicacionesList] =
        await Promise.all([
          clickUpRepo.findByCaseNumber(caseNumber),
          workerAppRepo.countByJobPosting(jobPosting.id, filters),
          encuadreRepo.countCandidatesByJobPosting(jobPosting.id, filters),
          encuadreRepo.countInvitedAndAttended(jobPosting.id, filters),
          encuadreRepo.countByResultado(jobPosting.id, filters),
          publicationRepo.countByChannelForJobPosting(jobPosting.id, filters),
          publicationRepo.findByJobPosting(jobPosting.id, { ...filters, orderBy: 'published_at DESC' }),
        ]);

      const { invitados, asistentes } = invitedAttended;
      const selCount = resultados.find(r => r.resultado === 'SELECCIONADO')?.count ?? 0;
      const remCount = resultados.find(r => r.resultado === 'REEMPLAZO')?.count ?? 0;

      res.json({
        success: true,
        data: {
          clickUpInfo:        clickUpCase,
          postuladosCount,
          candidatosCount,
          invitados,
          asistentes,
          asistenciaPct:      invitados > 0 ? Math.round((asistentes / invitados) * 100) : 0,
          seleccionadosCount: selCount,
          reemplazosCount:    remCount,
          pubChartData:       publicationsByChannel.map(p => ({ name: p.channel ?? 'Sin canal', value: p.count })),
          publicacionesList:  publicacionesList.map(p => ({
            fecha:        p.publishedAt?.toISOString().split('T')[0] ?? 'Sin fecha',
            canal:        p.channel,
            publicadoPor: p.recruiterName,
            descripcion:  p.observations ?? '',
          })),
          resultadosChartData: resultados.map(r => ({ name: r.resultado, value: r.count })),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  /**
   * GET /analytics/dashboard/zones?country=AR
   * Distribuição de casos por zona geográfica.
   */
  async getZoneMetrics(req: Request, res: Response): Promise<void> {
    try {
      const { country = 'AR' } = req.query as Record<string, string>;
      const clickUpRepo = new ClickUpCaseRepository();
      const zonesDistribution = await clickUpRepo.countByZone(country);

      const total      = zonesDistribution.reduce((s, z) => s + z.count, 0);
      const nullCount  = zonesDistribution.find(z => z.zone === null)?.count ?? 0;
      const validTotal = total - nullCount;
      const maxCount   = Math.max(0, ...zonesDistribution.filter(z => z.zone !== null).map(z => z.count));

      const zonas = zonesDistribution
        .filter(z => z.zone !== null)
        .map(z => ({
          name:       z.zone,
          count:      z.count,
          pct:        validTotal > 0 ? Math.round((z.count / validTotal) * 100) : 0,
          pctOfTotal: total > 0 ? Math.round((z.count / total) * 100) : 0,
        }))
        .sort((a, b) => b.count - a.count);

      res.json({
        success: true,
        data: {
          zonas,
          nullCount,
          nullPct:    total > 0 ? ((nullCount / total) * 100).toFixed(1) : '0.0',
          total,
          validTotal,
          maxCount,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }

  /**
   * GET /analytics/dashboard/reemplazos?country=AR
   * Seleccionados e reemplazos por caso, com última publicação e candidatos.
   */
  async getReemplazosMetrics(req: Request, res: Response): Promise<void> {
    try {
      const { country = 'AR' } = req.query as Record<string, string>;

      const encuadreRepo    = new EncuadreRepository();
      const publicationRepo = new PublicationRepository();
      const workerAppRepo   = new WorkerApplicationRepository();

      const [reemplazosCounts, lastPublications, candidatosCounts, postuladosCounts] =
        await Promise.all([
          encuadreRepo.countSelAndRemByCaseNumber(country),
          publicationRepo.findLastPublicationPerCase(country),
          workerAppRepo.countCandidatesByCaseNumber(country),
          workerAppRepo.countPostuladosByCaseNumber(country),
        ]);

      const lastPubDates:    Record<string, string> = {};
      const lastPubChannels: Record<string, string | null> = {};
      for (const p of lastPublications) {
        const key = String(p.caseNumber);
        lastPubDates[key]    = p.timeAgo;
        lastPubChannels[key] = p.channel;
      }

      res.json({
        success: true,
        data: {
          reemplazosCounts,
          lastPubDates,
          lastPubChannels,
          candidatosCounts,
          postuladosCounts,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  }
}
