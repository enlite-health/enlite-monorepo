import { z } from 'zod';
import { ACAO_NAMES } from '../../domain/acoesDeEstado';
import { ON_HOLD_REASONS } from '../../domain/enums/OnHoldReason';
import { SUSPENSION_EXIT_REASONS } from '../../domain/enums/SuspensionExitReason';
import { ON_HOLD_NOTE_MAX } from './patientSectionSchemas';

/**
 * Body de `POST /api/admin/patients/:id/status-actions` (F3). `.strict()` de propósito: o corpo NÃO tem `destino`, `status` nem
 * `changeSource` — o destino sai da tabela de ações (e, em retomar/reativar, da regra de horas do itinerário) e a origem é a da tabela;
 * qualquer chave a mais (inclusive um `destino` que o cliente tente impor) é 400 e nada é gravado (D9: o cliente não escolhe).
 */
export const patientStatusActionSchema = z
  .object({
    action: z.enum(ACAO_NAMES as unknown as [string, ...string[]]),
    /** Só `pausar` o exige (validado no escritor, que conhece o estado). */
    onHoldReason: z.enum(ON_HOLD_REASONS as unknown as [string, ...string[]]).nullable().optional(),
    onHoldNote: z.string().max(ON_HOLD_NOTE_MAX).nullable().optional(),
    /** Obrigatório ao sair de SUSPENDED (validado no escritor). */
    suspensionExitReason: z.enum(SUSPENSION_EXIT_REASONS as unknown as [string, ...string[]]).nullable().optional(),
  })
  .strict();
