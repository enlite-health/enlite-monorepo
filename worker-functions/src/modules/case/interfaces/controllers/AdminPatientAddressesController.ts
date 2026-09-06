import { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { reportError, logger } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

/**
 * AdminPatientAddressesController — edição da LOGÍSTICA por endereço (spec 012, US-B2).
 *
 *   PATCH /api/admin/patients/:patientId/addresses/:addressId
 *     body: { neighborhood?, logistics_corridor?, access_notes? } — só os 3 campos; `null` limpa.
 *
 * Zona/bairro é a coluna `neighborhood` que já existia (lex C2.7). `access_notes` é texto livre
 * sobre o domicílio de um paciente — lex C2.3: o valor NUNCA vai para log nem para a mensagem de
 * erro; sai `{patientId, addressId, campo, tamanho}`. Teto 2000 no servidor (C2.6; CHECK na 316).
 */
export const ACCESS_NOTES_MAX = 2000;

export const updatePatientAddressSchema = z
  .object({
    neighborhood: z.string().trim().min(1).max(120).nullable().optional(),
    logistics_corridor: z.string().trim().min(1).max(200).nullable().optional(),
    access_notes: z.string().trim().min(1).max(ACCESS_NOTES_MAX).nullable().optional(),
  })
  .strict();

const paramsSchema = z.object({
  patientId: z.string().uuid(),
  addressId: z.string().uuid(),
});

const COLUMN_BY_KEY: Record<string, string> = {
  neighborhood: 'neighborhood',
  logistics_corridor: 'logistics_corridor',
  access_notes: 'access_notes',
};

export class AdminPatientAddressesController {
  private readonly db: Pool;

  constructor(db?: Pool) {
    this.db = db ?? DatabaseConnection.getInstance().getPool();
  }

  async updatePatientAddress(req: Request, res: Response): Promise<void> {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params', details: params.error.flatten() });
      return;
    }
    const body = updatePatientAddressSchema.safeParse(req.body);
    if (!body.success) {
      // C2.3: o flatten do zod não ecoa o VALOR (só path + mensagem); ainda assim, sem `details`
      // aqui — um teto estourado não precisa devolver nada além do campo.
      const fields = Object.keys(body.error.flatten().fieldErrors);
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields } });
      return;
    }

    const sets: string[] = [];
    const values: unknown[] = [params.data.addressId, params.data.patientId];
    for (const [key, column] of Object.entries(COLUMN_BY_KEY)) {
      if (Object.prototype.hasOwnProperty.call(body.data, key)) {
        values.push((body.data as Record<string, unknown>)[key] ?? null);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) {
      res.status(400).json({ success: false, error: 'Nothing to update' });
      return;
    }

    try {
      const r = await this.db.query<{ id: string }>(
        `UPDATE patient_addresses SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $1 AND patient_id = $2 AND archived_at IS NULL
          RETURNING id`,
        values,
      );
      if ((r.rowCount ?? 0) === 0) {
        res.status(404).json({ success: false, error: 'Address not found' });
        return;
      }
      // Trilha SEM valor (lex C2.3): quem, qual endereço, quais campos e o tamanho de cada um.
      logger.info({
        msg: 'patient_address.logistics_updated',
        uid: AuthMiddleware.getAuthContext(req)?.principal.id ?? null,
        patientId: params.data.patientId,
        addressId: params.data.addressId,
        fields: Object.fromEntries(Object.keys(body.data).map((k) => [k, ((body.data as Record<string, string | null>)[k] ?? '').length])),
      });
      res.status(200).json({ success: true, data: { id: params.data.addressId } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      // C2.3: nada do corpo no reportError nem na resposta.
      reportError(e, { source: 'AdminPatientAddressesController:updatePatientAddress', patientId: params.data.patientId });
      res.status(500).json({ success: false, error: 'Failed to update patient address' });
    }
  }
}
