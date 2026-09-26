/**
 * VacancyNotesController
 *
 * GET  /api/admin/vacancies/:id/notes → perm.require('vacancy','read')
 * POST /api/admin/vacancies/:id/notes → perm.require('vacancy','update')
 *
 * Anotação tipo CRM por vacante (DX-3.3, #DEC-31: "o quando fez, com quem
 * fez"). Controller sem regra de negócio, por worker-functions/CLAUDE.md:
 * valida a entrada, delega ao use case e traduz o resultado para HTTP.
 *
 * Log de criação: UMA linha, só id/categoria/autor — nunca `contact`/`body`
 * (texto do perímetro, nunca sai em log).
 */
import { Request, Response } from 'express';
import { logger, reportError } from '@shared/logging';
import { staffActor } from '@shared/audit/actorSource';
import { VacancyNotesUseCase } from '../../application/VacancyNotesUseCase';

export class VacancyNotesController {
  private useCase: VacancyNotesUseCase;

  constructor(useCase?: VacancyNotesUseCase) {
    this.useCase = useCase ?? new VacancyNotesUseCase();
  }

  async list(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await this.useCase.list(id);

      if (!result.ok) {
        res.status(404).json({ success: false, error: result.error.message });
        return;
      }

      res.json({ success: true, data: result.notes });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'VacancyNotesController:list' });
      res.status(500).json({ success: false, error: e.message });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const actor = staffActor(req.user?.uid, req.user?.email);
      if (!actor) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { id } = req.params;
      const result = await this.useCase.create(id, req.body, actor.id);

      if (!result.ok) {
        const status = result.error.kind === 'not_found' ? 404 : 400;
        res.status(status).json({ success: false, error: result.error.message });
        return;
      }

      logger.info(
        { vacancyId: id, category: result.note.category, author: actor.id },
        '[vacancy-annotation] created',
      );
      res.status(201).json({ success: true, data: result.note });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'VacancyNotesController:create' });
      res.status(500).json({ success: false, error: e.message });
    }
  }
}
