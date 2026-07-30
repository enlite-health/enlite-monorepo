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
  };
  /** Horas semanais calculadas do schedule JSONB dos casos ativos. */
  horas: {
    totais: number;
    aPreencher: number;
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
