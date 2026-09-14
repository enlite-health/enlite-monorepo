import { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { reportError, logger } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';

/**
 * AdminPatientAddressesController — edição da LOGÍSTICA + PRINCIPAL + TIPO por endereço
 * (spec 012, US-B2; spec 019, D310 item c).
 *
 *   PATCH /api/admin/patients/:patientId/addresses/:addressId
 *     body: { neighborhood?, logistics_corridor?, access_notes?, is_default?, address_type?,
 *             address_type_other? } — só estes campos; `null` limpa (exceto `is_default`, que só
 *             aceita `true`; `false` é 400 — ver abaixo).
 *
 * Zona/bairro é a coluna `neighborhood` que já existia (lex C2.7). `access_notes` é texto livre
 * sobre o domicílio de um paciente — lex C2.3: o valor NUNCA vai para log nem para a mensagem de
 * erro; sai `{patientId, addressId, campo, tamanho}`. Teto 2000 no servidor (C2.6; CHECK na 316).
 *
 * Spec 019 (override do lex 12/09/2026, D310 item c — Caminho B, reaproveita `address_type`):
 *   - `is_default`: só aceita `true` (`z.literal(true)`) — `false` é 400. Marcar como principal
 *     desmarca o anterior NA MESMA TRANSAÇÃO (troca atômica; nunca existe instante observável com
 *     0 ou 2 principais para o mesmo paciente). Desmarcar o PRÓPRIO endereço só acontece marcando
 *     OUTRO como principal — não existe "desmarcar sem substituir" (deixaria 0 principais).
 *   - `address_type`: lista fechada por parentesco (migration 434); `null` = "sin especificar".
 *     ÚNICO escritor de VALOR autorizado depois da B4 (ver tasks.md §2, prova do grep).
 *   - `address_type_other`: texto livre do "Otro" (≤40), só aceito quando `address_type === 'otro'`
 *     na MESMA requisição — fora disso, 400 (não deixamos o CHECK do banco decidir isso: erro do
 *     cliente vira 400, não 500). Log/trilha NUNCA registra o valor — nem do enum fechado, nem do
 *     texto livre (lex, spec 019 "Segurança e perímetro").
 */
export const ACCESS_NOTES_MAX = 2000;

export const PATIENT_ADDRESS_TYPES = [
  'domicilio_propio', 'casa_madre', 'casa_padre', 'casa_abuela',
  'casa_abuelo', 'escuela', 'trabajo', 'otro',
] as const;

export const updatePatientAddressSchema = z
  .object({
    neighborhood: z.string().trim().min(1).max(120).nullable().optional(),
    logistics_corridor: z.string().trim().min(1).max(200).nullable().optional(),
    access_notes: z.string().trim().min(1).max(ACCESS_NOTES_MAX).nullable().optional(),
    // Só aceita `true` (spec 019, override 12/09): desmarcar um principal só acontece marcando
    // OUTRO endereço como principal (troca atômica) — nunca desmarcando o próprio com `false`.
    // `false` explícito é 400 (mesmo formato de erro dos demais campos, nunca ecoa o valor).
    is_default: z.literal(true).optional(),
    address_type: z.enum(PATIENT_ADDRESS_TYPES).nullable().optional(),
    address_type_other: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .strict()
  .refine(
    (data) => data.address_type_other == null || data.address_type === 'otro',
    {
      message: 'address_type_other só é aceito junto de address_type: "otro" na mesma requisição',
      path: ['address_type_other'],
    },
  );

const paramsSchema = z.object({
  patientId: z.string().uuid(),
  addressId: z.string().uuid(),
});

/** Sentinela interna: desfaz a transação do PATCH quando o endereço não existe (nunca sai do controller). */
const ADDRESS_ROW_MISSING = Symbol('patient_addresses: linha inexistente');

const COLUMN_BY_KEY: Record<string, string> = {
  neighborhood: 'neighborhood',
  logistics_corridor: 'logistics_corridor',
  access_notes: 'access_notes',
  address_type: 'address_type',
  address_type_other: 'address_type_other',
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
      // aqui — um teto estourado ou o enum fechado não precisam devolver nada além do campo.
      const fields = Object.keys(body.error.flatten().fieldErrors);
      res.status(400).json({ success: false, error: 'Invalid body', details: { fields } });
      return;
    }

    const bodyData = body.data as Record<string, unknown>;
    const sets: string[] = [];
    const values: unknown[] = [params.data.addressId, params.data.patientId];
    for (const [key, column] of Object.entries(COLUMN_BY_KEY)) {
      if (Object.prototype.hasOwnProperty.call(bodyData, key)) {
        values.push(bodyData[key] ?? null);
        sets.push(`${column} = $${values.length}`);
      }
    }
    // K4: texto do "Otro" órfão — quando o PATCH define address_type para qualquer valor
    // diferente de 'otro' (inclusive `null`), o mesmo UPDATE já limpa address_type_other na
    // MESMA transação. Sem isto, um endereço que já tinha address_type='otro' com texto livre e
    // depois muda de tipo (ex.: para 'casa_madre') ficava com o texto velho órfão no banco — a
    // zod já impede o cliente de mandar os dois juntos fora de 'otro' (refine acima), mas não
    // limpa o que já estava persistido de uma requisição anterior.
    const addressTypeProvided = Object.prototype.hasOwnProperty.call(bodyData, 'address_type');
    const addressTypeOtherProvided = Object.prototype.hasOwnProperty.call(bodyData, 'address_type_other');
    if (addressTypeProvided && bodyData.address_type !== 'otro' && !addressTypeOtherProvided) {
      values.push(null);
      sets.push(`address_type_other = $${values.length}`);
    }
    // Schema (z.literal(true)) já garante que, se presente, `is_default` só pode ser `true` —
    // não há mais ramo de `false` (morto desde o override de 12/09; ver comentário do schema).
    const markingDefault = Object.prototype.hasOwnProperty.call(bodyData, 'is_default');
    if (markingDefault) {
      sets.push('is_default = true');
    }
    if (sets.length === 0) {
      res.status(400).json({ success: false, error: 'Nothing to update' });
      return;
    }

    try {
      // `withActorContext` (D95), não `this.db.connect()` cru: abre a transação e carimba o
      // ator (`app.current_uid`/`app.change_source`) para os triggers de histórico — hoje é só
      // isso, sem RLS de país (a policy da migration 411 ainda não chegou a este ambiente).
      // Quando ela chegar, este mesmo helper passa a aplicar o país via `SET LOCAL`.
      // BEGIN/COMMIT/ROLLBACK são dele.
      const rowMissing = await withActorContext(this.db, async (client) => {
        // Troca atômica (spec 019): desmarca o principal anterior NA MESMA transação, antes do
        // UPDATE deste endereço — nunca existe instante observável com 0 ou 2 principais.
        if (markingDefault) {
          await client.query(
            `UPDATE patient_addresses SET is_default = false
              WHERE patient_id = $1 AND is_default AND archived_at IS NULL AND id <> $2`,
            [params.data.patientId, params.data.addressId],
          );
        }
        const result = await client.query<{ id: string }>(
          `UPDATE patient_addresses SET ${sets.join(', ')}, updated_at = NOW()
            WHERE id = $1 AND patient_id = $2 AND archived_at IS NULL
            RETURNING id`,
          values,
        );
        if ((result.rowCount ?? 0) === 0) throw ADDRESS_ROW_MISSING;
        return false;
      }).catch((err) => {
        if (err === ADDRESS_ROW_MISSING) return true;
        throw err;
      });

      if (rowMissing) {
        res.status(404).json({ success: false, error: 'Address not found' });
        return;
      }

      // Trilha SEM valor (lex C2.3; spec 019): quem, qual endereço, quais campos e o tamanho de
      // cada um — nunca o enum fechado, nunca o texto do "Otro". `is_default` é booleano
      // operacional (não é texto/PII), sai como valor.
      logger.info({
        msg: 'patient_address.logistics_updated',
        uid: AuthMiddleware.getAuthContext(req)?.principal.id ?? null,
        patientId: params.data.patientId,
        addressId: params.data.addressId,
        fields: Object.fromEntries(Object.keys(bodyData).map((k) => {
          // K1: `address_type`/`address_type_other` NUNCA saem como tamanho — mesmo o enum
          // fechado permite deduzir o valor pelo `.length` (ex.: 4 caracteres só bate com
          // 'otro'). Sai só `true` ("o campo mudou"), igual ao booleano de `is_default`.
          if (k === 'address_type' || k === 'address_type_other') return [k, true];
          const v = bodyData[k];
          if (typeof v === 'boolean') return [k, v];
          return [k, ((v ?? '') as string).length];
        })),
      });
      res.status(200).json({ success: true, data: { id: params.data.addressId } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      // Concorrência (spec 019): duas requisições de "marcar principal" ao mesmo tempo — o
      // índice único parcial (`patient_addresses_one_default_per_patient`) rejeita a que perde
      // a corrida; ela recebe 409 tratado, nunca 500.
      const pgCode = (err as { code?: string } | null)?.code;
      if (pgCode === '23505') {
        res.status(409).json({ success: false, error: 'Concurrent update — try again' });
        return;
      }
      // C2.3: nada do corpo no reportError nem na resposta.
      reportError(e, { source: 'AdminPatientAddressesController:updatePatientAddress', patientId: params.data.patientId });
      res.status(500).json({ success: false, error: 'Failed to update patient address' });
    }
  }
}
