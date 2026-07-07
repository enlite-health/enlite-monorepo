import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { CreateContactNoteUseCase } from '../../application/CreateContactNoteUseCase';
import { ListContactNotesUseCase } from '../../application/ListContactNotesUseCase';
import { DeleteContactNoteUseCase } from '../../application/DeleteContactNoteUseCase';
import { canDeleteContactNote } from '../../domain/contactNoteDeletion';

/**
 * WJAContactNotesController
 *
 * Gerencia notas de contato escopadas SOMENTE À VAGA (job_posting_id) —
 * migration 236. A thread é única por vaga: a mesma conversa aparece
 * idêntica em todos os cards/candidatos daquela vaga (bloqueado ou não,
 * qualquer coluna).
 *
 * POST   /api/admin/vacancies/:vacancyId/contact-notes → 201
 * GET    /api/admin/vacancies/:vacancyId/contact-notes → 200
 * DELETE /api/admin/vacancies/:vacancyId/contact-notes/:noteId → 200
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

      const { vacancyId } = req.params;
      const { noteText } = req.body as { noteText?: unknown };

      if (typeof noteText !== 'string') {
        res.status(400).json({ success: false, error: 'noteText é obrigatório e deve ser string' });
        return;
      }

      const result = await this.createUseCase.execute({
        vacancyId,
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

      const { vacancyId } = req.params;

      const result = await this.listUseCase.execute({
        vacancyId,
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

      const { vacancyId, noteId } = req.params;

      const result = await this.deleteUseCase.execute({
        vacancyId,
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
