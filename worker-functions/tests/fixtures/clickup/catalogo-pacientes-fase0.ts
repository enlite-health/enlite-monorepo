/**
 * FOTO do catálogo de custom fields da lista de pacientes do ClickUp — listId 901304883903
 * ("Estado de Pacientes"), rota `/list/<id>/field` (SÓ definições de campo; nenhuma tarefa,
 * nenhum paciente, nenhum valor).
 *
 * FONTE, literal e rastreável:
 *   ebrain/medicoes/campos-admissao/fase0/campos-vivos.txt  (task 0.4 / F15, 23/08/2026)
 * Esta é a MESMA medição que o F15 e a task 1.12 usam. Copiada, não re-consultada: papel não
 * chama a API do ClickUp (C1 do parecer do `lex`; o dado de teste é sintético).
 *
 * É METADADO DE ESQUEMA — nome e tipo de campo. Nenhum valor de paciente, nenhum orderindex,
 * nenhum uuid de opção, nenhum rótulo. É o que a C1 permite registrar.
 *
 * ⚠️ É FOTO, NÃO TRAVA. O Javier edita o catálogo quando quiser. Quando a medição da fase 0 for
 * refeita, esta foto tem de ser refeita junto — hoje nada cruza as duas automaticamente (é a
 * mesma dívida de duas fontes que o QA registrou para os 17 rótulos do Javier).
 *
 * ⚠️ `'Cobertura Informada '` tem ESPAÇO NO FIM. Não é erro de transcrição: é o nome vivo.
 */

export interface ClickUpCatalogField {
  /** Nome exato como o ClickUp devolve — espaços nas pontas INCLUSIVE. */
  name: string;
  /** Tipo declarado pelo ClickUp: drop_down, labels, short_text, text, location, … */
  type: string;
}

/** 74 campos, na ordem em que a rota /field os devolveu em 23/08/2026. */
export const CATALOGO_PACIENTES_FASE0: readonly ClickUpCatalogField[] = [
  { name: "Número ID Afiliado Paciente", type: "short_text" },
  { name: "Zona o Barrio Paciente", type: "short_text" },
  { name: "Tel Profesional Tratante Principal", type: "phone" },
  { name: "Email Paciente", type: "email" },
  { name: "Email Responsable", type: "email" },
  { name: "Comentarios Adicionales Paciente", type: "text" },
  { name: "Cobertura Informada ", type: "short_text" },
  { name: "Diagnóstico (si lo conoce)", type: "text" },
  { name: "Corredor Logístico", type: "short_text" },
  { name: "Ciudad / Localidad del Paciente", type: "location" },
  { name: "Nombre de Paciente", type: "short_text" },
  { name: "Tipo de Contratación", type: "drop_down" },
  { name: "Equipo Tratante Multidisciplinario", type: "drop_down" },
  { name: "Número do Documento Responsable", type: "short_text" },
  { name: "Email Profesional Tratante Principal", type: "email" },
  { name: "Apellido del Responsable", type: "short_text" },
  { name: "Número de Documento Paciente", type: "short_text" },
  { name: "Frecuencia de Supervisión", type: "drop_down" },
  { name: "Horas Semanales", type: "number" },
  { name: "Tipo de Patología", type: "drop_down" },
  { name: "Cobertura Verificada", type: "labels" },
  { name: "Posee CUD", type: "checkbox" },
  { name: "Servicio", type: "drop_down" },
  { name: "Chat ID Familia", type: "short_text" },
  { name: "Q Prestadores Necesarios", type: "short_text" },
  { name: "Tipo de Documento Responsable", type: "drop_down" },
  { name: "Tipo de Documento Paciente", type: "drop_down" },
  { name: "Franja Etaria Solicitada Prestador", type: "drop_down" },
  { name: "Q Prestadores Activos", type: "number" },
  { name: "Domicilio 1 Principal Paciente", type: "location" },
  { name: "Email Profesional Tratante 2", type: "email" },
  { name: "Perfil del Prestador Buscado", type: "text" },
  { name: "Sexo Asignado al Nacer (Uso Clínico)", type: "drop_down" },
  { name: "Número de WhatsApp Responsable", type: "phone" },
  { name: "Fin Búsqueda", type: "date" },
  { name: "Tel Profesional Tratante 3", type: "phone" },
  { name: "Canales de Marketing", type: "drop_down" },
  { name: "Numero Whatsapp Paciente", type: "phone" },
  { name: "Numero Whatsapp Prestador Brasil", type: "phone" },
  { name: "Domicilio 2 Paciente", type: "location" },
  { name: "Domicilio Informado Paciente 1", type: "short_text" },
  { name: "Fecha de Baja", type: "date" },
  { name: "Domicilio Informado Paciente 3", type: "short_text" },
  { name: "Profesional Tratante Principal", type: "short_text" },
  { name: "Dependencia", type: "drop_down" },
  { name: "Amparo Judicial", type: "checkbox" },
  { name: "Profesional Tratante 2", type: "short_text" },
  { name: "Apellido del Paciente", type: "short_text" },
  { name: "Profesional Tratante 3", type: "short_text" },
  { name: "Período Autorizado", type: "date" },
  { name: "Numero Whatsapp Responsável", type: "phone" },
  { name: "Fecha de Nacimiento", type: "date" },
  { name: "Turno de Guardia", type: "drop_down" },
  { name: "Número de WhatsApp Paciente", type: "phone" },
  { name: "Sexo Solicitado del Prestador", type: "drop_down" },
  { name: "Días y Horarios de Acompañamiento", type: "text" },
  { name: "Email Profesional Tratante 3", type: "email" },
  { name: "Tel Profesional Tratante 2", type: "phone" },
  { name: "Inicio Búsqueda", type: "date" },
  { name: "Caso Número", type: "number" },
  { name: "Relación con el Paciente", type: "drop_down" },
  { name: "Domicilio 3 Paciente", type: "location" },
  { name: "Tipo de Profesional", type: "drop_down" },
  { name: "Franja Etaria Paciente", type: "drop_down" },
  { name: "Chat ID Equipo", type: "short_text" },
  { name: "Fecha Suspensión", type: "date" },
  { name: "Consentimiento", type: "checkbox" },
  { name: "Nombre de Responsable", type: "short_text" },
  { name: "Logística y Acceso", type: "text" },
  { name: "Condición IVA", type: "drop_down" },
  { name: "Segmentos Clínicos", type: "drop_down" },
  { name: "Provincia del Paciente", type: "location" },
  { name: "Tipo de Dispositivo", type: "labels" },
  { name: "Domicilio Informado Paciente 2", type: "short_text" },
] as const;
