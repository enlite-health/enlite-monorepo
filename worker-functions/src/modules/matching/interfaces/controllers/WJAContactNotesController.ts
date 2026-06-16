import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { CreateContactNoteUseCase } from '../../application/CreateContactNoteUseCase';
import { ListContactNotesUseCase } from '../../application/ListContactNotesUseCase';

/**
 * WJAContactNotesController
 *
 * Gerencia notas de contato escopadas ao par candidato×vaga (WJA).
 *
 * POST /api/admin/vacancies/:vacancyId/applications/:wjaId/contact-notes → 201
 * GET  /api/admin/vacancies/:vacancyId/applications/:wjaId/contact-notes → 200
 *
 * Requer: req.user populado pelo middleware de auth admin (requireStaff).
 */
export class WJAContactNotesController {
  private createUseCase: CreateContactNoteUseCase;
  private listUseCase: ListContactNotesUseCase;

  constructor() {
    this.createUseCase = new CreateContactNoteUseCase();
    this.listUseCase = new ListContactNotesUseCase();
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.uid) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { vacancyId, wjaId } = req.params;
      const { noteText } = req.body as { noteText?: unknown };

      if (typeof noteText !== 'string') {
        res.status(400).json({ success: false, error: 'noteText é obrigatório e deve ser string' });
        return;
      }

      const result = await this.createUseCase.execute({
        vacancyId,
        wjaId,
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

      res.status(201).json({ success: true, data: result.note });
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

      const { vacancyId, wjaId } = req.params;

      const result = await this.listUseCase.execute({ vacancyId, wjaId });

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
}
