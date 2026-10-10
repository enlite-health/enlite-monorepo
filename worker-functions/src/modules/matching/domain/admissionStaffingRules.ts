/**
 * Regras de dotação do resumo da admissão (Gem). Fonte: Marcel, 10/10/2026 (não aplicadas no sistema; só informam o resumo).
 * As chaves são os marcadores `{{...}}` do Google Doc do prompt. Versionadas aqui: mudar uma regra é mudar este arquivo.
 */
export const ADMISSION_STAFFING_RULES: Readonly<Record<string, string>> = {
  MAX_HORAS_SEMANALES_POR_PRESTADOR: '60 horas semanales por prestador',
  MAX_HORAS_POR_TURNO: '12 horas por turno',
  REGLA_COBERTURA_SUPLENTE:
    'El suplente es el equipo de respuesta rápida. El paciente debe tener al menos 2 prestadores activos (aunque tengan pocas horas), para que puedan cubrirse entre ellos ante una falta; no son suplentes, ambos están activos. Máximo 8 prestadores activos por paciente.',
  REGLA_TURNOS_NOCTURNOS_Y_FINES_DE_SEMANA:
    'Noche: no se corta la guardia a la mitad con cambio de prestador en la madrugada. Fin de semana: evitar que el mismo equipo de la semana cubra el fin de semana, para que ambos tengan descanso.',
};
