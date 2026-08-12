/**
 * Contrato do "Dashboard para Gestão à Vista" (ClickUp 86ajb4qnw).
 * Espelha managementDashboardSchema do worker-functions.
 * Só métricas com fonte de dados real. Horas e Ubicaciones/Zona são GAPs
 * conhecidos (sem coluna estruturada / normalização de zona em outra task).
 */
/** Colunas do funil, na ordem de avanço do Kanban (BLOQUEADO não entra: não tem WJA). */
export const FUNNEL_COLUMN_ORDER = [
  'INVITED',
  'INICIADO',
  'PRE_SCREENING',
  'IN_PROGRESS',
  'COMPLETED',
  'CONFIRMED',
  'SELECTED',
  'REJECTED',
] as const;

export type FunnelColumnId = (typeof FUNNEL_COLUMN_ORDER)[number];

export type FunnelColumnCounts = Record<FunnelColumnId, number>;

export interface ManagementDashboardData {
  bigNumbers: {
    equiposArmados: number;
    equiposPorArmar: number;
    pacientesActivos: number;
    vacantesAbiertas: number;
    vacantesPausadas: number;
  };
  /**
   * Classificação honesta da "Equipe Armada" (nunca 0 falso). armados/porArmar
   * espelham os big numbers; semConfig/pendenteClasificacao explicam os casos
   * que não dá pra julgar (sem providers_needed numérico / selecionados sem papel).
   */
  equipoArmada: {
    armados: number;
    porArmar: number;
    semConfig: number;
    pendenteClasificacao: number;
    /**
     * % de grupo de resposta rápida armado (call 22/07). Percentual nunca viaja
     * sozinho: num/den/excluidos vêm junto. pct null = denominador zerado.
     */
    pctRespostaRapidaArmado: { num: number; den: number; excluidos: number; pct: number | null };
  };
  /**
   * Duas linhas de estado de paciente (call 22/07, refinadas pelo Diego 30/07).
   * Estados ATUAIS; CHEGANDO é exclusiva por precedência (Busca > Admissão >
   * Entrevista > Solicitações). `enBusca` SOBREPÕE `activos` de propósito —
   * nunca somar linhas (era a origem do "193" falso).
   */
  pacientes: {
    activos: number;
    /** Ubicaciones (endereços) DISTINTAS de pacientes ativos — dedup por (paciente, texto). */
    ubicacionesActivas: number;
    solicitudes: number;
    entrevistaAgendada: number;
    enAdmision: number;
    enBusca: number;
    sobrepoe: true;
  };
  /** Horas semanais calculadas do schedule JSONB. */
  horas: {
    /** Vagas VIVAS (em busca) — na tela: "a serem ativadas" (linha CHEGANDO). */
    totais: number;
    aPreencher: number;
    /** Vagas status='ACTIVE' (em atendimento) — linha RODANDO. */
    ativas: number;
    ativasConSchedule: number;
    ativasSinSchedule: number;
    coberturaConSchedule: number;
    coberturaSinSchedule: number;
  };
  prioridades: {
    completosEsperandoAgendamiento: number;
    profesionalesBloqueados: number;
  };
  /**
   * Contagem por coluna do Kanban. As chaves são os ids de coluna do backend
   * (deriveKanbanColumn) — a tradução é da tela, o id é o contrato.
   */
  funnelPorPrestador: {
    /** Prestadores distintos no recorte. */
    total: number;
    recorte: 'vagas-vivas';
    /**
     * Filtro por período aplicado (dias desde a ENTRADA no funil; null = tudo).
     * Não é data de movimentação — não existe timestamp de transição por etapa.
     */
    periodoDias: number | null;
    /**
     * Pessoas com tentativa de candidatura barrada (cadastro incompleto), em vaga viva.
     * Fora das colunas: não tem candidatura, e somá-la quebraria a invariante do total.
     */
    bloqueados: number;
    /** Prestadores por coluna; um prestador pode estar em várias → não soma. */
    porEtapa: { somavel: false; colunas: FunnelColumnCounts };
    /** Cada prestador uma vez, na coluna mais avançada → soma === total. */
    consolidado: { somavel: true; colunas: FunnelColumnCounts };
  };
  /**
   * @deprecated LEGADO — conta card (não pessoa) e inclui vaga apagada/rascunho.
   * A tela usa `funnelPorPrestador`; sai na change seguinte.
   */
  funnel: {
    invitados: number;
    bloqueados: number;
    preScreening: number;
    completos: number;
    agendados: number;
    seleccionados: number;
    rechazados: number;
  };
  encuadres: {
    agendadosEstaSemana: number;
    /** Cards em "Agendados" sem data registrada — medida de adoção da captura. */
    semDataRegistrada: number;
    /**
     * % da capacidade semanal contratada (config ENCUADRE_WEEKLY_CAPACITY; 80).
     * AUSENTE quando a config está zerada — nunca 0% fabricado. pct pode passar de 100.
     */
    pctCapacidadeSemana?: { agendados: number; capacidade: number; pct: number };
  };
  cadastros: {
    leads: number;
    /** EM UM CASO no Ana Care = Activo + Cubriendo guardias (não o funil). */
    alocados: number;
    alocadosActivos: number;
    alocadosCubriendoGuardias: number;
    completos: number;
    incompletos: number;
    nuevosCompletosMes: number;
  };
}
