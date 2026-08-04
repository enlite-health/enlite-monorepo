/**
 * Chaves de ajuda da Gestión a la Vista — uma por indicador da tela.
 *
 * Cada chave corresponde a um bloco em `admin.managementDashboard.help.<chave>`
 * nos locales (es/pt-BR), com os campos: title, que, origen, cambia e ojo
 * (opcional). O conteúdo é a versão para gestão dos documentos de auditoria
 * do ebrain (`docs/gestao-a-vista/*`), verificados contra produção.
 *
 * O teste de cobertura (`__tests__/helpContent.test.ts`) trava a existência de
 * TODAS estas chaves nos DOIS locales — chave sem conteúdo quebra o build de CI.
 */
export const MANAGEMENT_HELP_KEYS = [
  // Números clave
  'pctRespostaRapida',
  'pctCapacidadEncuadres',
  'pacientesActivos',
  'ubicacionesActivas',
  'horasActivas',
  'solicitudes',
  'entrevistaAgendada',
  'enAdmision',
  'enBusca',
  'equiposArmados',
  'equiposPorArmar',
  'vacantesAbiertas',
  'vacantesPausadas',
  // Equipo armado y horas
  'horasTotais',
  'horasAPreencher',
  'casosSinMedir',
  // Prioridades de contacto
  'esperandoAgendamiento',
  'profesionalesBloqueados',
  // Registros de prestadores
  'leads',
  'completosRegistros',
  'alocados',
  'incompletos',
  'nuevosMes',
  // Totalización del embudo
  'totalPrestadores',
  'bloqueadosFunil',
  'agendadosSemana',
  'stage_INVITED',
  'stage_INICIADO',
  'stage_PRE_SCREENING',
  'stage_IN_PROGRESS',
  'stage_COMPLETED',
  'stage_CONFIRMED',
  'stage_SELECTED',
  'stage_REJECTED',
  // Analytics por zona
  'zona',
  // Pacientes (stats + embudo de admissão — endpoints próprios)
  'pacTotal',
  'pacCompletos',
  'pacAtencion',
  'embudoSolicitantes',
  'embudoAdmision',
  'embudoAgendadas',
  'embudoVacantes',
] as const;

export type ManagementHelpKey = (typeof MANAGEMENT_HELP_KEYS)[number];
