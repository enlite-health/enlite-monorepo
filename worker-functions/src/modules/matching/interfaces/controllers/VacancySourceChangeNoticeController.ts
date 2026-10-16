/**
 * VacancySourceChangeNoticeController (vaga-le-do-servico-contratado, F3)
 *
 * POST /api/admin/vacancies/:id/source-change-notices/:field/ack → perm.require('vacancy','update')
 * (a MESMA célula do `PUT /vacancies/:id`; nenhuma célula nova).
 *
 * "Marcar como atendido": fecha o aviso aberto de (vaga, campo). O recrutamento republica no Talentum e avisa os
 * convidados por conta própria — o sistema só avisa. Log: `{ jobPostingId, field }`, nunca valor.
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { staffActor } from '@shared/audit/actorSource';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { acknowledgeNotice, isSourceChangeField } from '@modules/case/infrastructure/vacancySourceChangeNotice';

const VacancyIdSchema = z.string().uuid();

export class VacancySourceChangeNoticeController {
  private db: Pool;

  constructor(db?: Pool) {
    this.db = db ?? DatabaseConnection.getInstance().getPool();
  }

  async acknowledge(req: Request, res: Response): Promise<void> {
    try {
      const { id, field } = req.params;
      if (!VacancyIdSchema.safeParse(id).success) {
        res.status(400).json({ success: false, error: 'Invalid vacancy id' });
        return;
      }
      if (!isSourceChangeField(field)) {
        res.status(400).json({ success: false, error: 'Invalid field' });
        return;
      }
      const actor = staffActor(req.user?.uid, req.user?.email);
      if (!actor) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      const closed = await acknowledgeNotice(this.db, id, field, actor.id);
      if (!closed) {
        res.status(404).json({ success: false, error: 'No open notice for this vacancy and field' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'VacancySourceChangeNoticeController:acknowledge' });
      res.status(500).json({ success: false, error: e.message });
    }
  }
}
