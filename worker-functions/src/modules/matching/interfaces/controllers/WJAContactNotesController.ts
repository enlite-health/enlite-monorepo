import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { CreateContactNoteUseCase } from '../../application/CreateContactNoteUseCase';
import { ListContactNotesUseCase } from '../../application/ListContactNotesUseCase';
import { DeleteContactNoteUseCase } from '../../application/DeleteContactNoteUseCase';
import { canDeleteContactNote } from '../../domain/contactNoteDeletion';

/**
 * WJAContactNotesController
 *
 * Gerencia notas de contato escopadas ao par estável candidato×vaga
 * (worker_id, job_posting_id) — migration 235. O par sobrevive à promoção
 * BLOQUEADO→INICIADO, então cards ainda bloqueados (sem WJA) também podem
 * ter notas.
 *
 * POST   /api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes → 201
 * GET    /api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes → 200
 * DELETE /api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes/:noteId → 200
 *
 * Requer: req.user populado pelo middleware de auth admin (requireStaff).
 */
export class WJAContactNotesController {
  private createUseCase: CreateContactNoteUseCase;
  private listUseCase: ListContactNotesUseCase;
  private deleteUseCase: DeleteContactNoteUseCase;

  constructor() {
    this.createUseCase = new CreateContactNoteUseCase();
    this.listUseCase = new ListContactNotesUseCase();
    this.deleteUseCase = new DeleteContactNoteUseCase();
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.uid) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { vacancyId, workerId } = req.params;
      const { noteText } = req.body as { noteText?: unknown };

      if (typeof noteText !== 'string') {
        res.status(400).json({ success: false, error: 'noteText é obrigatório e deve ser string' });
        return;
      }

      const result = await this.createUseCase.execute({
        vacancyId,
        workerId,
        noteText,
        adminId: user.uid,
        adminEmail: user.email ?? null,
      });

      if (!result.ok) {
        if (result.error.kind === 'not_found') {
          res.status(404).json({ success: false, error: result.error.message });
          return;
        }
        res.status(400).json({ success: false, error: result.error.message });
        return;
      }

      const note = result.note;
      const canDelete = canDeleteContactNote(note, user.uid, Date.now());
      res.status(201).json({ success: true, data: { ...note, canDelete } });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'WJAContactNotesController:create' });
      res.status(500).json({ success: false, error: e.message });
    }
  }

  async list(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.uid) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { vacancyId, workerId } = req.params;

      const result = await this.listUseCase.execute({
        vacancyId,
        workerId,
        requesterAdminId: user.uid,
      });

      if (!result.ok) {
        res.status(404).json({ success: false, error: result.error.message });
        return;
      }

      res.json({ success: true, data: result.notes });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'WJAContactNotesController:list' });
      res.status(500).json({ success: false, error: e.message });
    }
  }

  async delete(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.uid) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { vacancyId, workerId, noteId } = req.params;

      const result = await this.deleteUseCase.execute({
        vacancyId,
        workerId,
        noteId,
        requesterAdminId: user.uid,
      });

      if (!result.ok) {
        if (result.error.kind === 'not_found') {
          res.status(404).json({ success: false, error: result.error.message });
          return;
        }
        // forbidden: not_owner | window_expired
        res.status(403).json({
          success: false,
          error: result.error.message,
          reason: result.error.reason,
        });
        return;
      }

      res.json({ success: true, data: { id: noteId } });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'WJAContactNotesController:delete' });
      res.status(500).json({ success: false, error: e.message });
    }
  }
}
