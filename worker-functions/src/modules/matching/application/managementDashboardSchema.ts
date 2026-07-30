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

/**
 * Contagem por coluna do Kanban. As chaves são os ids de coluna de
 * `deriveKanbanColumn` (domain/kanbanColumn.ts) — deliberadamente NÃO rótulos
 * traduzidos: o id é o contrato, a tradução é da tela. BLOQUEADO fica de fora
 * (vem de worker_blocked_applications, não tem WJA).
 */
const funnelColumnCountsSchema = z.object({
  INVITED: nonNegInt,
  INICIADO: nonNegInt,
  PRE_SCREENING: nonNegInt,
  IN_PROGRESS: nonNegInt,
  COMPLETED: nonNegInt,
  CONFIRMED: nonNegInt,
  SELECTED: nonNegInt,
  REJECTED: nonNegInt,
});

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
  /**
   * Funil contado por PRESTADOR (pedido do Diego, 30/07/2026) e recortado à
   * operação viva. Chaves = colunas do Kanban (mesmo SSOT `deriveKanbanColumn`),
   * pra que painel e board não possam divergir.
   *
   * `somavel` viaja no PAYLOAD, não só no texto da tela: o Greenhouse documenta a
   * não-somabilidade em página de ajuda e quem exporta soma assim mesmo. Aqui todo
   * consumidor (tela, export, Sol) herda o aviso junto com o número.
   */
  funnelPorPrestador: z.object({
    /** Prestadores distintos no recorte. */
    total: nonNegInt,
    /** Recorte aplicado — explícito para quem consome o número fora da tela. */
    recorte: z.literal('vagas-vivas'),
    /**
     * Pessoas com TENTATIVA barrada pelo gate de cadastro incompleto, em vaga viva.
     * Fica FORA das colunas de propósito: tentativa bloqueada não tem candidatura
     * (`worker_blocked_applications`), então somá-la às colunas quebraria a invariante
     * "consolidado soma == total". É a coluna BLOQUEADO do Kanban.
     */
    bloqueados: nonNegInt,
    /** Prestadores distintos por coluna; um prestador pode estar em várias. */
    porEtapa: z.object({
      somavel: z.literal(false),
      colunas: funnelColumnCountsSchema,
    }),
    /** Cada prestador uma vez, na coluna mais avançada. Soma == total. */
    consolidado: z.object({
      somavel: z.literal(true),
      colunas: funnelColumnCountsSchema,
    }),
  }),
  /**
   * Totalização do funil por CANDIDATURA, sem recorte de vaga.
   * @deprecated LEGADO — conta card (não pessoa) e inclui vaga apagada/rascunho.
   * Mantido por uma release para comparação lado a lado; a tela já usa
   * `funnelPorPrestador`. Remover na change seguinte.
   */
  funnel: z.object({
    invitados: nonNegInt, // INVITED
    bloqueados: nonNegInt, // worker_blocked_applications (registration_incomplete)
    preScreening: nonNegInt, // PRE_SCREENING
    completos: nonNegInt, // COMPLETED
    agendados: nonNegInt, // CONFIRMED
    seleccionados: nonNegInt, // SELECTED
    rechazados: nonNegInt, // REJECTED
  }),
  /**
   * Entrevistas da semana corrente, no fuso da operação (segunda→domingo em Buenos Aires).
   * A data é resolvida das duas fontes (`wja.interview_datetime` atual + `encuadres.interview_date`
   * legado) pelo helper único em `domain/interviewSchedule`.
   */
  encuadres: z.object({
    agendadosEstaSemana: nonNegInt,
    /**
     * Cards em "Agendados" SEM data registrada — medida de adoção da captura.
     * Enquanto for alto, `agendadosEstaSemana` subestima; exibir os dois juntos evita que a
     * lacuna vire um zero mudo (design D4).
     */
    semDataRegistrada: nonNegInt,
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
