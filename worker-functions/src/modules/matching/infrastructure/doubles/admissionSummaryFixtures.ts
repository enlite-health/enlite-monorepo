import { SUMMARY_REQUIRED_FIELDS, SUMMARY_STATE_DRAFT } from '../../domain/admissionSummaryShape';

/** JSON de resumo 100% SINTÉTICO e válido (spec 050 F6): todos os obrigatórios com `valor` não nulo, listas vazias. */
export function validSummaryJson(): Record<string, any> {
  const datos: Record<string, unknown> = {};
  for (const k of SUMMARY_REQUIRED_FIELDS) datos[k] = { valor: `sintetico-${k}`, fuente: [], conflicto: false, historial: [] };
  return {
    entrevistas_procesadas: [], datos_administrativos: datos, analisis_caso: {}, cie11_diagnosticos_informados: [],
    sintomas_sin_diagnostico_informado: [], insumos_pt: {}, perfil_prestador: {}, dotacion: {}, campos_faltantes: [],
    preguntas_sugeridas: [], alertas_riesgo: [], estado: SUMMARY_STATE_DRAFT,
  };
}
