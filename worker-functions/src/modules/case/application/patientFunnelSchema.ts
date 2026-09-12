import { z } from 'zod';

/**
 * Contrato do endpoint GET /api/admin/patients/funnel (Fase 4 — rastreabilidade
 * do funil de PACIENTES). Só métricas com fonte de dados REAL entram aqui:
 * patients, patient_status_history (migration 254), admission_appointments
 * (migration 252) e job_postings.patient_id. Nada é fabricado.
 */

const nonNegInt = z.number().int().nonnegative();

/**
 * Query params. Sem from/to → default últimos 30 dias (resolvido no use-case).
 *
 * `country` NÃO entra aqui (PR-9, `lex` #9): validá-lo com `z.enum(['AR','BR'])`
 * rejeitaria `?country=ALL` antes mesmo de chegar no resolvedor. Quem valida e
 * resolve o país agora é `resolveCountryScope` (AR|BR|ALL, interseção com o
 * escopo do ator) — o controller lê `req.query.country` cru para ele, à parte
 * deste schema.
 */
export const patientFunnelQuerySchema = z.object({
  from: z.string().datetime({ message: 'from must be an ISO datetime' }).optional(),
  to: z.string().datetime({ message: 'to must be an ISO datetime' }).optional(),
});

export type PatientFunnelQuery = z.infer<typeof patientFunnelQuerySchema>;

/** Contrato de saída, validado antes de retornar. */
export const patientFunnelSchema = z.object({
  /** Janela efetivamente usada (útil quando caiu no default de 30 dias). */
  period: z.object({
    from: z.string(),
    to: z.string(),
  }),
  /** País aplicado, ou null quando não filtrado. */
  country: z.enum(['AR', 'BR']).nullable(),
  /** Pacientes criados no período (todos os origins). Topo do funil. */
  solicitantes: nonNegInt,
  /** Distintos que chegaram a ADMISSION+ (histórico OU status atual). */
  admision: nonNegInt,
  /** Distintos patient_id com entrevista de admissão agendada no período. */
  agendadas: nonNegInt,
  /** Distintos patient_id com vaga (não-draft/não-deletada) de paciente criado no período. */
  vacantes: nonNegInt,
  /** Snapshot atual: contagem por status (para as colunas do kanban). */
  byStatus: z.record(z.string(), nonNegInt),
});

export type PatientFunnelData = z.infer<typeof patientFunnelSchema>;
