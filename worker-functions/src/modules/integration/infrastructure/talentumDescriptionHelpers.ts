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
