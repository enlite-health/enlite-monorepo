/**
 * Contrato do "Dashboard para Gestão à Vista" (ClickUp 86ajb4qnw).
 * Espelha managementDashboardSchema do worker-functions.
 * Só métricas com fonte de dados real. Horas e Ubicaciones/Zona são GAPs
 * conhecidos (sem coluna estruturada / normalização de zona em outra task).
 */
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
