import { z } from 'zod';

/**
 * Contrato de saída do endpoint GET /analytics/dashboard/management
 * ("Dashboard para Gestão à Vista" — ClickUp 86ajb4qnw).
 *
 * Só métricas com fonte de dados REAL verificada entram aqui. Métricas sem
 * lastro (horas estruturadas por vaga, ubicaciones/zona normalizada) NÃO são
 * fabricadas — ficam de fora e são reportadas como GAP no dashboard.
 */

const nonNegInt = z.number().int().nonnegative();

export const managementDashboardSchema = z.object({
  /** Big numbers operacionais. */
  bigNumbers: z.object({
    /** job_postings.status = 'ACTIVE' — caso com equipe montada e operando. */
    equiposArmados: nonNegInt,
    /** status IN (SEARCHING, SEARCHING_REPLACEMENT, RAPID_RESPONSE) — vaga aberta sem equipe. */
    equiposPorArmar: nonNegInt,
    /** patients.status = 'ACTIVE'. */
    pacientesActivos: nonNegInt,
    /** status IN (SEARCHING, SEARCHING_REPLACEMENT, RAPID_RESPONSE, PENDING_ACTIVATION). */
    vacantesAbiertas: nonNegInt,
    /** job_postings.status = 'SUSPENDED'. */
    vacantesPausadas: nonNegInt,
  }),
  /** Prioridades de contato para a recrutadora agir rápido. */
  prioridades: z.object({
    /** worker_job_applications.application_funnel_stage = 'QUALIFIED'. */
    completosEsperandoAgendamiento: nonNegInt,
    /** workers.status = 'INCOMPLETE_REGISTER' (deduped). */
    profesionalesBloqueados: nonNegInt,
  }),
  /** Totalização do funil (postulações por etapa). */
  funnel: z.object({
    invitados: nonNegInt, // INVITED
    bloqueados: nonNegInt, // worker_blocked_applications (registration_incomplete)
    preScreening: nonNegInt, // PRE_SCREENING
    completos: nonNegInt, // COMPLETED
    agendados: nonNegInt, // CONFIRMED
    seleccionados: nonNegInt, // SELECTED
    rechazados: nonNegInt, // REJECTED
  }),
  /** Encuadres agendados na semana corrente (ISO week). */
  encuadres: z.object({
    agendadosEstaSemana: nonNegInt,
  }),
  /** Cadastros de prestadores. */
  cadastros: z.object({
    leads: nonNegInt, // total workers deduped
    completos: nonNegInt, // REGISTERED
    alocados: nonNegInt, // distinct workers com WJA SELECTED
    incompletos: nonNegInt, // INCOMPLETE_REGISTER
    nuevosCompletosMes: nonNegInt, // REGISTERED criados no mês corrente
  }),
});

export type ManagementDashboardData = z.infer<typeof managementDashboardSchema>;
