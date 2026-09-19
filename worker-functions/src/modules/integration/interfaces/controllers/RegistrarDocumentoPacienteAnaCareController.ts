/**
 * RegistrarDocumentoPacienteAnaCareController — POST /api/admin/integrations/anacare/patient-document.
 *
 * Zero lógica de negócio aqui (mesma regra de `LancarPrestacaoAxonicoController`): valida com Zod
 * na borda e delega ao `RegistrarDocumentoPacienteAnaCareUseCase`; `mapError()` traduz cada erro
 * nomeado (guard) num par (errorType, httpStatus), igual ao `mapError` do controller irmão.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { AuthMiddleware } from '@modules/identity';
import { RegistrarDocumentoPacienteAnaCareUseCase } from '../../application/RegistrarDocumentoPacienteAnaCareUseCase';
import {
  AnaCarePatientIdAusenteError,
  DocumentoInvalidoError,
  DocumentoJaRegistradoDivergenteError,
} from '../../application/RegistrarDocumentoPacienteAnaCareUseCase';

const PatientDocumentBodySchema = z.object({
  anaCarePatientId: z.string().min(1, 'anaCarePatientId é obrigatório'),
  documentNumber: z.string().min(1, 'documentNumber é obrigatório'),
  documentType: z.string().optional(),
});

export class RegistrarDocumentoPacienteAnaCareController {
  /** `useCaseFactory` — lazy, mesmo padrão de `LancarPrestacaoAxonicoController`. */
  constructor(private readonly useCaseFactory: () => RegistrarDocumentoPacienteAnaCareUseCase) {}

  async handle(req: Request, res: Response): Promise<void> {
    const parsed = PatientDocumentBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
      return;
    }

    const registeredBy = AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';

    try {
      const useCase = this.useCaseFactory();
      const result = await useCase.execute({ ...parsed.data, registeredBy });
      res.status(200).json({ success: true, data: { status: result.status, record: result.record } });
    } catch (err) {
      const mapped = mapError(err);
      res.status(mapped.httpStatus).json({
        success: false,
        error: mapped.errorType,
        message: mapped.message,
        ...(mapped.data !== undefined ? { data: mapped.data } : {}),
      });
    }
  }
}

function mapError(err: unknown): { errorType: string; message: string; httpStatus: number; data?: unknown } {
  if (err instanceof AnaCarePatientIdAusenteError) {
    return { errorType: err.name, message: err.message, httpStatus: 400 };
  }
  if (err instanceof DocumentoInvalidoError) {
    return { errorType: err.name, message: err.message, httpStatus: 422 };
  }
  if (err instanceof DocumentoJaRegistradoDivergenteError) {
    return {
      errorType: err.name,
      message: err.message,
      httpStatus: 409,
      data: {
        anaCarePatientId: err.anaCarePatientId,
        documentoExistente: {
          documentType: err.existente.documentType,
          registeredBy: err.existente.registeredBy,
          registradoEm: err.existente.createdAt,
        },
      },
    };
  }
  const e = err instanceof Error ? err : new Error(String(err));
  return { errorType: 'UnknownError', message: e.message, httpStatus: 500 };
}
