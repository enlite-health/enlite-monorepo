/**
 * EncuadreController — encuadres (entrevistas), status de plataforma, ocupação e documentos.
 *
 * Routes: GET /workers/:id/encuadres, /workers/:id/cases,
 *         /cases/:n/encuadres, /cases/:n/workers,
 *         /workers/status-dashboard, /workers/by-status/:s,
 *         PUT /workers/:id/status, /workers/:id/occupation,
 *         /workers/:id/doc-expiry, GET /workers/docs-expiring
 */

import { Request, Response } from 'express';
import { Pool } from 'pg';
import { EncuadreRepository } from '../../infrastructure/EncuadreRepository';
import { JobPostingARRepository } from '../../infrastructure/JobPostingARRepository';
import { DocExpiryRepository } from '@modules/audit';
import { WorkerRepository, WorkerStatus } from '@modules/worker';
import { WorkerOccupation } from '../../domain/WorkerOccupation';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { staffActor } from '@shared/audit/actorSource';
import { classifyWorkerCaseStatus, groupByResultado } from './EncuadreControllerHelpers';
import { decidirTransicaoDeBaixa, type WorkerStatus as StatusDeBaixa } from '@modules/worker/domain/transicaoDeBaixa';
import { cellsOfRequest } from '@modules/identity/permissions';

export class EncuadreController {
  private encuadreRepo = new EncuadreRepository();
  private jobPostingRepo = new JobPostingARRepository();
  private docExpiryRepo = new DocExpiryRepository();
  private workerRepo = new WorkerRepository();
  private db: Pool = DatabaseConnection.getInstance().getPool();

  // ================================================
  // Histórico de entrevistas
  // ================================================

  async getWorkerEncuadres(req: Request, res: Response): Promise<void> {
    try {
      const encuadres = await this.encuadreRepo.findByWorkerId(req.params.id);
      res.status(200).json({
        success: true,
        data: encuadres.map(e => ({
          id: e.id,
          jobPostingId: e.jobPostingId,
          caseNumber: (e as any).case_number ?? null,
          vacancyNumber: (e as any).vacancy_number ?? null,
          patientName: (e as any).patient_name ?? null,
          resultado: e.resultado,
          interviewDate: e.interviewDate,
          recruitmentDate: e.recruitmentDate,
          recruiterName: e.recruiterName,
          acceptsCase: e.acceptsCase,
          rejectionReason: e.rejectionReason,
          redireccionamiento: e.redireccionamiento,
          createdAt: e.createdAt,
        })),
        total: encuadres.length,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }

  async getWorkerCases(req: Request, res: Response): Promise<void> {
    try {
      const encuadres = await this.encuadreRepo.findByWorkerId(req.params.id);

      // Agrupa por job_posting_id — pega o último encuadre de cada caso
      const caseMap = new Map<string, typeof encuadres[0]>();
      const countByCase = new Map<string, number>();

      for (const e of encuadres) {
        const key = e.jobPostingId ?? `raw_${e.workerRawName}`;
        countByCase.set(key, (countByCase.get(key) ?? 0) + 1);
        if (!caseMap.has(key) || (e.interviewDate && (!caseMap.get(key)!.interviewDate || e.interviewDate > caseMap.get(key)!.interviewDate!))) {
          caseMap.set(key, e);
        }
      }

      const cases = Array.from(caseMap.entries()).map(([key, e]) => ({
        jobPostingId: e.jobPostingId,
        caseNumber: (e as any).case_number ?? null,
        vacancyNumber: (e as any).vacancy_number ?? null,
        patientName: (e as any).patient_name ?? null,
        lastResultado: e.resultado,
        lastInterviewDate: e.interviewDate,
        totalEncuadres: countByCase.get(key) ?? 1,
        status: classifyWorkerCaseStatus(e.resultado),
      }));

      res.status(200).json({
        success: true,
        data: cases,
        summary: {
          total: cases.length,
          selected: cases.filter(c => c.lastResultado === 'SELECCIONADO').length,
          rejected: cases.filter(c => c.lastResultado === 'RECHAZADO').length,
          notInterested: cases.filter(c => c.lastResultado === 'AT_NO_ACEPTA').length,
          inProgress: cases.filter(c => ['PENDIENTE','REPROGRAMAR'].includes(c.lastResultado ?? '')).length,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }

  async getCaseEncuadres(req: Request, res: Response): Promise<void> {
    try {
      const caseNumber = parseInt(req.params.caseNumber);
      if (isNaN(caseNumber)) { res.status(400).json({ success: false, error: 'caseNumber inválido' }); return; }

      const jp = await this.jobPostingRepo.findByCaseNumber(caseNumber);
      if (!jp) { res.status(404).json({ success: false, error: `Caso ${caseNumber} não encontrado` }); return; }

      const encuadres = await this.encuadreRepo.findByJobPostingId(jp.id);

      res.status(200).json({
        success: true,
        data: {
          caseNumber,
          jobPostingId: jp.id,
          encuadres: encuadres.map(e => ({
            id: e.id,
            workerId: e.workerId,
            workerRawName: e.workerRawName,
            workerRawPhone: e.workerRawPhone,
            resultado: e.resultado,
            recruitmentDate: e.recruitmentDate,
            interviewDate: e.interviewDate,
            attended: e.attended,
            acceptsCase: e.acceptsCase,
            rejectionReason: e.rejectionReason,
            redireccionamiento: e.redireccionamiento,
          })),
          summary: {
            total: encuadres.length,
            byResultado: groupByResultado(encuadres),
          },
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }

  async getCaseWorkers(req: Request, res: Response): Promise<void> {
    try {
      const caseNumber = parseInt(req.params.caseNumber);
      if (isNaN(caseNumber)) { res.status(400).json({ success: false, error: 'caseNumber inválido' }); return; }

      const jp = await this.jobPostingRepo.findByCaseNumber(caseNumber);
      if (!jp) { res.status(404).json({ success: false, error: `Caso ${caseNumber} não encontrado` }); return; }

      const encuadres = await this.encuadreRepo.findByJobPostingId(jp.id);

      const workerMap = new Map<string, { workerId: string | null; rawName: string | null; rawPhone: string | null; encuadres: typeof encuadres }>();
      for (const e of encuadres) {
        const key = e.workerId ?? e.workerRawPhone ?? e.workerRawName ?? e.id;
        if (!workerMap.has(key)) workerMap.set(key, { workerId: e.workerId, rawName: e.workerRawName, rawPhone: e.workerRawPhone, encuadres: [] });
        workerMap.get(key)!.encuadres.push(e);
      }

      const workers = Array.from(workerMap.values()).map(w => {
        const last = w.encuadres[0];
        return {
          workerId: w.workerId,
          rawName: w.rawName,
          rawPhone: w.rawPhone,
          totalEncuadres: w.encuadres.length,
          lastResultado: last.resultado,
          lastInterviewDate: last.interviewDate,
          status: classifyWorkerCaseStatus(last.resultado),
        };
      });

      res.status(200).json({
        success: true,
        data: workers,
        summary: {
          totalWorkers: workers.length,
          selected: workers.filter(w => w.status === 'SELECCIONADO').length,
          rejected: workers.filter(w => w.status === 'RECHAZADO').length,
          notInterested: workers.filter(w => w.status === 'NAO_INTERESSADO').length,
          inProgress: workers.filter(w => w.status === 'EM_ANDAMENTO').length,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }

  // ── Worker Status ───────────────────────────────

  async getStatusDashboard(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.db.query(
        `SELECT status, COUNT(*)::int AS count
         FROM workers
         WHERE merged_into_id IS NULL
         GROUP BY status`
      );

      const counts: Record<string, number> = {
        REGISTERED: 0, INCOMPLETE_REGISTER: 0, DISABLED: 0,
      };
      for (const row of result.rows) {
        counts[row.status] = row.count as number;
      }

      res.status(200).json({
        success: true,
        data: {
          REGISTERED:          { count: counts.REGISTERED,          label: 'Cadastro completo' },
          INCOMPLETE_REGISTER: { count: counts.INCOMPLETE_REGISTER, label: 'Cadastro incompleto' },
          DISABLED:            { count: counts.DISABLED,            label: 'Desativados' },
          total: Object.values(counts).reduce((s, n) => s + n, 0),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }

  async getWorkersByStatus(req: Request, res: Response): Promise<void> {
    try {
      const status = req.params.status?.toUpperCase() as WorkerStatus;
      const validStatuses: WorkerStatus[] = ['REGISTERED', 'INCOMPLETE_REGISTER', 'DISABLED'];

      if (!validStatuses.includes(status)) {
        res.status(400).json({
          success: false,
          error: `Status inválido. Use: ${validStatuses.join(', ')}`,
        });
        return;
      }

      const limit    = Math.min(parseInt(String(req.query.limit  ?? '50')), 200);
      const offset   = parseInt(String(req.query.offset ?? '0'));
      const occupation = req.query.occupation as WorkerOccupation | undefined;

      const conditions = ['w.status = $1'];
      const values: unknown[] = [status];
      let idx = 2;

      if (occupation) {
        conditions.push(`w.occupation = $${idx++}`);
        values.push(occupation);
      }

      values.push(limit);
      values.push(offset);

      const result = await this.db.query(
        `SELECT id, phone, email, first_name, last_name, occupation, status, created_at
         FROM workers w
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        values
      );

      const workers = result.rows.map(r => ({
        id: r.id,
        phone: r.phone,
        email: r.email,
        firstName: r.first_name,
        lastName: r.last_name,
        occupation: r.occupation,
        status: r.status,
        createdAt: new Date(r.created_at),
      }));

      res.status(200).json({
        success: true,
        data: workers,
        pagination: { limit, offset, count: workers.length },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }

  async updateWorkerStatus(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status, motivo } = req.body;
      if (!['REGISTERED', 'INCOMPLETE_REGISTER', 'DISABLED'].includes(status)) {
        res.status(400).json({ success: false, error: 'status inválido. Use: REGISTERED, INCOMPLETE_REGISTER, DISABLED' });
        return;
      }

      // C7/C8 — dar e reverter baixa não é `worker:write`. Lê o estado ATUAL e
      // quem fez a baixa: a decisão depende dos dois, e nenhum deles vem do
      // corpo da request (o cliente não é fonte para isto).
      const { rows: atual } = await this.db.query(
        `SELECT w.status,
                (SELECT h.changed_by FROM worker_status_history h
                  WHERE h.worker_id = w.id AND h.field_name = 'status'
                    AND h.new_value = 'DISABLED'
                  ORDER BY h.created_at DESC LIMIT 1) AS autor_da_baixa
           FROM workers w WHERE w.id = $1`,
        [id],
      );
      if (atual.length === 0) {
        res.status(404).json({ success: false, error: 'Worker not found' });
        return;
      }

      const decisao = decidirTransicaoDeBaixa({
        de: (atual[0].status ?? null) as StatusDeBaixa | null,
        para: status as StatusDeBaixa,
        cells: cellsOfRequest(req),
        motivo,
        autorDaBaixa: atual[0].autor_da_baixa as string | null,
      });
      if (!decisao.permitida) {
        // 403 e não 400: não é pedido malformado, é permissão/vontade do titular.
        res.status(403).json({
          success: false,
          error: decisao.explicacao,
          details: { motivo: decisao.motivoRecusa },
        });
        return;
      }

      // REGISTERED não pode ser forçado manualmente — recalcular com base nos campos obrigatórios
      if (status === 'REGISTERED') await this.workerRepo.recalculateStatus(id);
      else await this.runWorkerUpdate(id, 'UPDATE workers SET status = $2 WHERE id = $1', status, (req as any).user?.uid);
      const { rows } = await this.db.query('SELECT status FROM workers WHERE id = $1', [id]);
      res.status(200).json({ success: true, data: { workerId: id, status: rows[0]?.status ?? status } });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }

  async updateOccupation(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { occupation } = req.body;
      const validOccupations: WorkerOccupation[] = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'];
      if (!validOccupations.includes(occupation)) {
        res.status(400).json({ success: false, error: `occupation inválido. Use: ${validOccupations.join(', ')}` });
        return;
      }
      await this.runWorkerUpdate(id, 'UPDATE workers SET occupation = $2 WHERE id = $1', occupation, (req as any).user?.uid);
      res.status(200).json({ success: true, data: { workerId: id, occupation } });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }

  /**
   * Executa um UPDATE em workers dentro de transação, carimbando o ator para o
   * trigger de histórico.
   *
   * Passou a usar `withActorContext` (mesma técnica que já estava aqui à mão)
   * para gravar a identidade no formato único da medição — `staff:<uid>` em vez
   * do uid cru, que não dizia de que lado veio a ação.
   */
  private async runWorkerUpdate(workerId: string, sql: string, value: string, changedByUid?: string): Promise<void> {
    await withActorContext(
      this.db,
      (client) => client.query(sql, [workerId, value]),
      staffActor(changedByUid),
    );
  }

  // ================================================
  // Vencimento de documentos
  // ================================================

  async updateDocExpiry(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { criminalRecordExpiry, insuranceExpiry, professionalRegExpiry } = req.body;

      await this.docExpiryRepo.update({
        workerId: id,
        criminalRecordExpiry: criminalRecordExpiry ? new Date(criminalRecordExpiry) : undefined,
        insuranceExpiry: insuranceExpiry ? new Date(insuranceExpiry) : undefined,
        professionalRegExpiry: professionalRegExpiry ? new Date(professionalRegExpiry) : undefined,
      });

      const updated = await this.docExpiryRepo.findByWorkerId(id);
      res.status(200).json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }

  async getDocsExpiringSoon(_req: Request, res: Response): Promise<void> {
    try {
      const expiring = await this.docExpiryRepo.findExpiringSoon(30);
      res.status(200).json({
        success: true,
        data: expiring,
        total: expiring.length,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }
}
