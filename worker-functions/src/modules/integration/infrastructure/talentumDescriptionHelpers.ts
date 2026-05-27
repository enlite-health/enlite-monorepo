/**
 * talentumDescriptionHelpers
 *
 * Pure helpers + static prompt constants for TalentumDescriptionService.
 * Extracted to keep the service file within the 400-line limit and to make
 * the prompt-construction logic unit-testable in isolation.
 */

/**
 * Builds the "Zona" line of the Gemini prompt from neighborhood/city/state.
 * Drops case-insensitive duplicates so the LLM never sees patterns like
 * "Córdoba, Córdoba" (city == state on the Argentine province ⇒ Gemini
 * infers "Córdoba capital" — the bug detected on vacancy 776).
 *
 * Order honored: neighborhood (most specific) → city → state.
 */
export function formatZoneForPrompt(parts: {
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
}): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [parts.neighborhood, parts.city, parts.state]) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (!trimmed) continue;
    const norm = trimmed.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(trimmed);
  }
  return out.length > 0 ? out.join(', ') : 'No especificado';
}

// ─────────────────────────────────────────────────────────────────
// Fixed text for section 3 (always appended verbatim)
// ─────────────────────────────────────────────────────────────────

export const MARCO_TEXT =
  'El Marco de Acompañamiento:\n' +
  'EnLite Health Solutions ofrece a los prestadores un marco de trabajo ' +
  'profesional y organizado, donde cada acompañamiento o cuidado se ' +
  'realiza dentro de un proyecto terapéutico claro, con supervisión ' +
  'clínica y soporte continuo del equipo de Coordinación Clínica ' +
  'formado por psicólogas. Nuestra propuesta de valor es brindarles ' +
  'casos acordes a su perfil y formación, con respaldo administrativo ' +
  'y clínico, para que puedan enfocarse en lo más importante: el ' +
  'bienestar del paciente.';

// ─────────────────────────────────────────────────────────────────
// System prompt — inline, focused on description generation only.
// Pulls the rules from the Drive doc that are actually relevant for
// this task (privacy, professional language, voseo, terminology) and
// drops everything else (prescreening tables, WordPress fields, the
// Regla #7 mutual-exclusion filter that breaks multi-type vacancies).
// ─────────────────────────────────────────────────────────────────

export const DESCRIPTION_SYSTEM_PROMPT = `Sos un especialista en redacción de propuestas de prestación de servicios terapéuticos para EnLite Health Solutions.

Tu tarea: generar la descripción de una vacante para publicar en Talentum, en formato JSON con dos campos.

Reglas obligatorias:
1. Privacidad absoluta: NUNCA incluyas datos personales identificables del paciente (nombres, DNI, direcciones exactas). Usá descripciones generales.
2. Lenguaje profesional: NUNCA uses lenguaje laboral ("contratar", "equipo", "trabajo"). La relación es de "prestación de servicios" o "profesional independiente".
3. Flexibilidad de horarios: Si el caso tiene múltiples turnos posibles, presentá la propuesta aclarando que el profesional puede postularse para un solo turno o jornada completa.
4. Voseo argentino: usá "vos" en lugar de "tú". Tono cercano, amable, humano y profesional.
5. Terminología correcta: usar "Certificado de AT", "Certificación", "Formación en Acompañamiento Terapéutico". NUNCA "Título", "Matrícula", "Habilitante".
6. Texto plano sin markdown, sin asteriscos, sin encabezados. SIN saludos, introducciones ni despedidas.
7. NO incluyas el texto del "Marco de Acompañamiento" institucional — el sistema lo agrega automáticamente al final.
8. La "Zona" se entrega como una lista deduplicada (barrio, ciudad y/o provincia). NO infieras "capital" ni el centro de una provincia solo porque la zona menciona el nombre de la provincia. Usá literalmente el texto provisto.

Estructura del output:
- "propuesta": resumen objetivo del caso (tipo de profesional, zona, dispositivo, jornada, días/horarios disponibles, cantidad de prestadores, objetivo del acompañamiento basado en patologías y dependencia). 60-250 palabras.
- "perfilProfesional": perfil ideal (sexo si excluyente, formación requerida, experiencia, atributos valorados). 60-250 palabras.`;

// Substring that appears in the "Regla #7" refusal text in the Drive prompt
// docs. Defense-in-depth: if a future code path or doc edit leaks the rule
// into this service, we reject the response instead of silently saving the
// refusal as a vacancy description on Talentum.
export const REFUSAL_MARKER = 'generar una vacante para cuidador en otro chat';

export const DESCRIPTION_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    propuesta: {
      type: 'STRING',
      description:
        'Resumen objetivo del caso: tipo de profesional, zona y localidad, ' +
        'dispositivo de servicio, días y horarios disponibles, jornada, ' +
        'cantidad de prestadores necesarios y objetivo general del ' +
        'acompañamiento basado en patologías y nivel de dependencia. ' +
        'Texto plano sin encabezados ni markdown.',
    },
    perfilProfesional: {
      type: 'STRING',
      description:
        'Descripción del perfil ideal: sexo si excluyente, rango etario, ' +
        'formación requerida, experiencia necesaria, atributos valorados. ' +
        'Texto plano sin encabezados ni markdown.',
    },
  },
  required: ['propuesta', 'perfilProfesional'],
} as const;
