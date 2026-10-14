import { ENQUADRE_SUMMARY_STATE_DRAFT } from '../../domain/enquadreSummaryShape';

/** JSON de resumo de encuentro 100% SINTÉTICO e válido (spec 052, T-36b): um bloco por `ref` dada (nenhuma = bloco sem vínculo). */
export function validEnquadreSummaryJson(code = 'ENC-AAAAAA', refs: readonly (string | null)[] = [null]): Record<string, any> {
  return {
    entrevista_id: code,
    fecha: '2026-10-14',
    encuentro: {
      resumen: 'sintetico', evidencias: [],
      temas_cubiertos: { horario: true, zona: true, modalidad: true, honorarios: false, proximos_pasos: true },
      acuerdos: [],
    },
    prestadores: refs.map((ref, i) => ({
      nombre_en_transcripcion: `Prestador Sintetico ${i + 1}`,
      convocado_ref: ref,
      desenvolvimiento: { texto: 'sintetico', evidencias: [] },
      interes: { valor: 'no_quedo_claro', cita: '' },
      disponibilidad: { texto: null, acepta_horario: 'no_se_hablo', evidencias: [] },
      zona_traslado: { texto: null, acepta_zona: 'no_se_hablo', evidencias: [] },
      experiencia_relevante: { texto: null, tipos: [], anios: null, evidencias: [] },
      honorarios: { objecion: 'no_se_hablo', cita: '' },
      dudas_condiciones: [],
      compromisos: [],
      conflicto: false,
      alertas: [],
    })),
    sin_atribuir: [],
    campos_faltantes: [],
    preguntas_sugeridas: [],
    estado: ENQUADRE_SUMMARY_STATE_DRAFT,
  };
}
