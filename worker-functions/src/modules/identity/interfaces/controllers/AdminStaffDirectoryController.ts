/**
 * AdminStaffDirectoryController — GET /api/admin/staff-directory?q=
 * (spec 022, T128; `contracts/openapi-staff-directory.md`).
 *
 * Alimenta o autocomplete de menção (`<@uid>`) do chat interno sobre um
 * paciente. NÃO é uma API de diretório de pessoal: a resposta é
 * `{ uid, displayName }[]` — NUNCA `email` nem `role` (D-06, explícito no
 * contrato — vazar campo aqui é defeito de privacidade, não detalhe).
 */
import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AdminRepository } from '../../infrastructure/AdminRepository';
import {
  staffDirectoryQuerySchema,
  MIN_STAFF_DIRECTORY_QUERY_LENGTH,
  MAX_STAFF_DIRECTORY_RESULTS,
} from '../validators/staffDirectorySchema';

export class AdminStaffDirectoryController {
  constructor(private readonly adminRepo: AdminRepository = new AdminRepository()) {}

  /** GET /api/admin/staff-directory */
  async search(req: Request, res: Response): Promise<void> {
    const query = staffDirectoryQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query',
        details: { fields: Object.keys(query.error.flatten().fieldErrors), minQueryLength: MIN_STAFF_DIRECTORY_QUERY_LENGTH },
      });
      return;
    }

    try {
      const entries = await this.adminRepo.searchStaffDirectory(query.data.q, MAX_STAFF_DIRECTORY_RESULTS);
      // Forma explícita — mesmo que o repositório só devolva `uid`/`displayName` hoje, a
      // resposta NUNCA reflete o row inteiro por conta própria (defesa contra um SELECT * futuro).
      res.status(200).json({
        success: true,
        data: entries.map((e) => ({ uid: e.uid, displayName: e.displayName })),
      });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminStaffDirectoryController:search' });
      res.status(500).json({ success: false, error: 'Failed to search staff directory' });
    }
  }
}
