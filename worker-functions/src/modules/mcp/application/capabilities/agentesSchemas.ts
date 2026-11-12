import { z } from 'zod';
import { isRealCivilDate } from '../../../../shared/locale/civilClock';

/**
 * Formato dos payloads das capabilities `agentes.*` (spec 078, M3a-2).
 *
 * Defesa em profundidade: o BANCO é a trava (CHECKs da migration 551); aqui o payload fora do
 * formato morre ANTES de abrir transação. Limites espelham a migration. Campo extra é recusado
 * (`.strict()`): é assim que "trecho de conversa" não entra por um campo que ninguém previu.
 *
 * Referências (operador, inbox, conversa, mensagem, regra) são SLUGS sem espaço: texto de conversa
 * não cabe nelas. Só os campos que a migration limita como texto curto aceitam frase.
 */

/** Referência opaca: letras, dígitos e `_ . : # / -`. Nenhum espaço, nenhuma frase. */
const REF = /^[A-Za-z0-9_.:#/-]+$/;

export const ref = (min: number, max: number) => z.string().min(min).max(max).regex(REF);
/** Texto curto/médio de campo que a migration admite como texto (com teto de tamanho). */
export const texto = (max: number) => z.string().trim().min(1).max(max);

/** Slug minúsculo (o Sol envia `luz`): "Luz" é recusado. Casa com o CHECK de 1..40 do banco. */
export const OPERADOR = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
export const AREA = ref(1, 40);
export const AUTOR = texto(80);
export const UUID = z.string().uuid();
export const ISO_DATA = z.string().datetime({ offset: true });

export const MOTIVOS_MEDICAO = ['linha_de_base', 'antes', 'depois'] as const;
/** Data de calendário `YYYY-MM-DD` (coluna `date`), existente de verdade (2026-02-30 é recusado). */
export const DATA_DIA = z
  .string()
  .refine(isRealCivilDate, { message: 'data inexistente' });

export const CASOS_REPORTE = ['leve', 'meta', 'reforco'] as const;
export const SENSORES = ['silente', 'handover_orfao', 'juiz', 'scrubber', 'notario', 'validador'] as const;
export const GRAVIDADES = ['baixa', 'media', 'alta'] as const;
export const GRAVE_GATILHOS = ['nenhum', 'nunca', 'dado', 'acao_fabricada'] as const;

export const AchadoShape = {
  tipo: z.enum(['violacao', 'acerto']),
  regra_ref: ref(3, 120),
  gravidade: z.enum(GRAVIDADES).optional(),
};
export const AchadoSchema = z
  .object(AchadoShape)
  .strict()
  .refine((a) => (a.tipo === 'violacao') === (a.gravidade !== undefined), {
    message: 'gravidade é obrigatória na violação e proibida no acerto',
  });

export type Achado = z.infer<typeof AchadoSchema>;
