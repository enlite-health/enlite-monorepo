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
    completos: number;
    alocados: number;
    incompletos: number;
    nuevosCompletosMes: number;
  };
}
