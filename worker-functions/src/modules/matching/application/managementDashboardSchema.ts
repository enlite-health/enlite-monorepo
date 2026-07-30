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
const nonNegNumber = z.number().nonnegative();

export const managementDashboardSchema = z.object({
  /** Big numbers operacionais. */
  bigNumbers: z.object({
    /** Casos ARMADOS (titulares + substitutos suficientes) — GetArmedCasesUseCase. */
    equiposArmados: nonNegInt,
    /** Casos POR_ARMAR (classificáveis e ainda sem equipe completa). */
    equiposPorArmar: nonNegInt,
    /** patients.status = 'ACTIVE'. */
    pacientesActivos: nonNegInt,
    /** status IN (SEARCHING, SEARCHING_REPLACEMENT, RAPID_RESPONSE, PENDING_ACTIVATION). */
    vacantesAbiertas: nonNegInt,
    /** job_postings.status = 'SUSPENDED'. */
    vacantesPausadas: nonNegInt,
  }),
  /**
   * Classificação honesta da "Equipe Armada" (nunca um 0 falso). armados/porArmar
   * espelham os big numbers; semConfig/pendenteClasificacao explicam os casos que
   * NÃO dá pra julgar (sem providers_needed numérico / selecionados sem papel).
   */
  equipoArmada: z.object({
    armados: nonNegInt,
    porArmar: nonNegInt,
    /** providers_needed não-numérico/NULL. */
    semConfig: nonNegInt,
    /** ≥1 SELECCIONADO mas nenhum com papel setado (rollout do papel). */
    pendenteClasificacao: nonNegInt,
  }),
  /**
   * Horas semanais calculadas do JSONB job_postings.schedule (soma por dia-turno,
   * trata virada de meia-noite). Cobertura = quantos casos ativos têm schedule.
   */
  horas: z.object({
    /** Soma das horas/semana dos casos ativos com schedule. */
    totais: nonNegNumber,
    /** Horas/semana ainda descobertas (soma dos casos POR_ARMAR). */
    aPreencher: nonNegNumber,
    /** Casos ativos COM schedule estruturado. */
    coberturaConSchedule: nonNegInt,
    /** Casos ativos SEM schedule estruturado. */
    coberturaSinSchedule: nonNegInt,
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
    alocados: nonNegInt, // EM UM CASO no Ana Care = Activo + Cubriendo guardias (NÃO o funil). Ver D53.
    alocadosActivos: nonNegInt, // ana_care_status = 'Activo' (ocupado, atendendo paciente)
    alocadosCubriendoGuardias: nonNegInt, // ana_care_status = 'Cubriendo guardias' (disponível, cobrindo plantão)
    incompletos: nonNegInt, // INCOMPLETE_REGISTER
    nuevosCompletosMes: nonNegInt, // REGISTERED criados no mês corrente
  }),
});

export type ManagementDashboardData = z.infer<typeof managementDashboardSchema>;
