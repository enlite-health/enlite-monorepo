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
    /**
     * % de grupo de resposta rápida armado (call 22/07). Percentual NUNCA viaja
     * sozinho: num/den/excluidos vêm junto (regra da casa). `pct` é null quando
     * den = 0 — nunca um 0% fabricado por divisão degenerada.
     */
    pctRespostaRapidaArmado: z.object({
      num: nonNegInt,
      den: nonNegInt,
      /** SEM_CONFIG + PENDENTE_CLASSIFICACAO — fora do denominador, mas visíveis. */
      excluidos: nonNegInt,
      pct: z.number().min(0).max(100).nullable(),
    }),
  }),
  /**
   * Estados de paciente nas duas linhas da call de 22/07, refinadas pelo Diego
   * (WhatsApp 30/07). São estados ATUAIS, não coortes por período. A linha
   * CHEGANDO tem precedência exclusiva (Em Busca > Em Admissão > Entrevista >
   * Solicitações); `enBusca` INCLUI pacientes ACTIVE — sobrepõe com `activos`
   * de propósito (o "193" antigo somava os dois; agora se expõem separados,
   * NUNCA somados — `sobrepoe` avisa qualquer consumidor).
   */
  pacientes: z.object({
    /** = bigNumbers.pacientesActivos (linha RODANDO). */
    activos: nonNegInt,
    /**
     * Ubicaciones (endereços) DISTINTAS de pacientes ativos — dedup por
     * (paciente, texto): a importação duplica linhas (566 cruas → 339 reais em
     * 31/07). É o multiplicador pacientes→vagas do Diego (call 02:02:35).
     */
    ubicacionesActivas: nonNegInt,
    /** SOLICITANTE sem entrevista de admissão futura. */
    solicitudes: nonNegInt,
    /** Entrevista de admissão marcada (admission_appointments booked, futura). */
    entrevistaAgendada: nonNegInt,
    /** ADMISSION/PENDING_ADMISSION sem vaga viva — "precisam gerar vacante". */
    enAdmision: nonNegInt,
    /**
     * ≥1 vaga viva de caso NÃO-armado, status não-terminal (DISCONTINUED/
     * DISCHARGED fora — vaga viva de paciente terminal é zumbi de dado, não fila).
     */
    enBusca: nonNegInt,
    /** enBusca sobrepõe activos (paciente 24/7 com turno descoberto está nos dois). */
    sobrepoe: z.literal(true),
  }),
  /**
   * Horas semanais calculadas do JSONB job_postings.schedule (soma por dia-turno,
   * trata virada de meia-noite). Cobertura = quantos casos têm schedule.
   */
  horas: z.object({
    /**
     * Horas/semana das vagas VIVAS (em busca) — na tela é o "a serem ativadas"
     * da linha CHEGANDO (semântica confirmada com dado em 31/07, design D2).
     */
    totais: nonNegNumber,
    /** Horas/semana ainda descobertas (soma dos casos POR_ARMAR). */
    aPreencher: nonNegNumber,
    /**
     * Horas/semana EM ATENDIMENTO: vagas `status='ACTIVE'` (fora do recorte
     * vivo, que é só busca) de pacientes não apagados. Linha RODANDO.
     */
    ativas: nonNegNumber,
    /** Vagas ACTIVE com/sem schedule estruturado (cobertura das horas ativas). */
    ativasConSchedule: nonNegInt,
    ativasSinSchedule: nonNegInt,
    /** Casos vivos COM schedule estruturado. */
    coberturaConSchedule: nonNegInt,
    /** Casos vivos SEM schedule estruturado. */
    coberturaSinSchedule: nonNegInt,
  }),
  /** Prioridades de contato para a recrutadora agir rápido. */
  prioridades: z.object({
    /** worker_job_applications.application_funnel_stage = 'QUALIFIED'. */
    completosEsperandoAgendamiento: nonNegInt,
    /** workers.status = 'INCOMPLETE_REGISTER' (deduped) — backlog de cadastro incompleto. */
    registrosIncompletos: nonNegInt,
    /**
     * COUNT(DISTINCT worker_id) de worker_blocked_applications (registration_incomplete):
     * pessoas que de fato tentaram se postular e foram barradas — 1 unidade por profissional,
     * mesmo que bloqueado em várias vagas. É a lista acionável de contato.
     */
    bloqueadosAlPostularse: nonNegInt,
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
     * Filtro por período aplicado (dias desde a ENTRADA da candidatura no funil;
     * `wja.created_at`), ecoado para a tela. null = sem filtro (tudo). NÃO é
     * data de movimentação — não existe timestamp de transição por etapa.
     */
    periodoDias: z.number().int().positive().nullable(),
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
    /**
     * % da capacidade semanal contratada de encuadres (call 22/07, "regra de
     * três" interina até plugar o Google Calendar). `capacidade` vem de config
     * (ENCUADRE_WEEKLY_CAPACITY — 30 desde a call de 12/08; era 80).
     * AUSENTE quando a config está zerada/inválida — nunca divisão por zero.
     * `pct` pode passar de 100 (semana com mais encuadres que o contratado).
     */
    pctCapacidadeSemana: z
      .object({
        agendados: nonNegInt,
        capacidade: z.number().int().positive(),
        pct: nonNegNumber,
      })
      .optional(),
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
