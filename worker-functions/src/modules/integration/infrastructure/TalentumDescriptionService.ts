/**
 * TalentumDescriptionService
 *
 * Uses Gemini (default `gemini-2.5-pro`) to generate the formatted vacancy
 * description that Talentum expects when creating a prescreening project.
 *
 * The output has 3 sections:
 *   1. "Descripcion de la Propuesta:" — objective summary
 *   2. "Perfil Profesional Sugerido:" — ideal candidate profile
 *   3. "El Marco de Acompanamiento:" — fixed institutional text
 *
 * Uses an inline system prompt (not the Drive doc the parser uses): the doc
 * mixes prescreening/WordPress instructions and the "Regla #7" mutual-exclusion
 * filter that refuses generation on AT/CUIDADOR mismatches — both irrelevant
 * (and harmful) for the programmatic description flow.
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { fetchGeminiWithRetry } from './gemini-fetch';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface GenerateDescriptionInput {
  caseNumber: string;
  title: string;
  requiredProfessions: string[];
  requiredSex?: string;
  requiredExperience?: string;
  workerAttributes?: string;
  ageRangeMin?: number;
  ageRangeMax?: number;
  providersNeeded?: number;
  schedule?: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
  workSchedule?: string;
  city?: string;
  state?: string;
  serviceDeviceTypes?: string[];
  pathologyTypes?: string;
  dependencyLevel?: string;
  salaryText?: string;
  paymentDay?: string;
}

export interface GeneratedDescription {
  title: string;
  description: string;
}

// ─────────────────────────────────────────────────────────────────
// Fixed text for section 3 (always appended verbatim)
// ─────────────────────────────────────────────────────────────────

const MARCO_TEXT =
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

const DESCRIPTION_SYSTEM_PROMPT = `Sos un especialista en redacción de propuestas de prestación de servicios terapéuticos para EnLite Health Solutions.

Tu tarea: generar la descripción de una vacante para publicar en Talentum, en formato JSON con dos campos.

Reglas obligatorias:
1. Privacidad absoluta: NUNCA incluyas datos personales identificables del paciente (nombres, DNI, direcciones exactas). Usá descripciones generales.
2. Lenguaje profesional: NUNCA uses lenguaje laboral ("contratar", "equipo", "trabajo"). La relación es de "prestación de servicios" o "profesional independiente".
3. Flexibilidad de horarios: Si el caso tiene múltiples turnos posibles, presentá la propuesta aclarando que el profesional puede postularse para un solo turno o jornada completa.
4. Voseo argentino: usá "vos" en lugar de "tú". Tono cercano, amable, humano y profesional.
5. Terminología correcta: usar "Certificado de AT", "Certificación", "Formación en Acompañamiento Terapéutico". NUNCA "Título", "Matrícula", "Habilitante".
6. Texto plano sin markdown, sin asteriscos, sin encabezados. SIN saludos, introducciones ni despedidas.
7. NO incluyas el texto del "Marco de Acompañamiento" institucional — el sistema lo agrega automáticamente al final.

Estructura del output:
- "propuesta": resumen objetivo del caso (tipo de profesional, zona, dispositivo, jornada, días/horarios disponibles, cantidad de prestadores, objetivo del acompañamiento basado en patologías y dependencia). 60-250 palabras.
- "perfilProfesional": perfil ideal (sexo si excluyente, formación requerida, experiencia, atributos valorados). 60-250 palabras.`;

// Substring that appears in the "Regla #7" refusal text in the Drive prompt
// docs. Defense-in-depth: if a future code path or doc edit leaks the rule
// into this service, we reject the response instead of silently saving the
// refusal as a vacancy description on Talentum.
const REFUSAL_MARKER = 'generar una vacante para cuidador en otro chat';

const DESCRIPTION_RESPONSE_SCHEMA = {
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

// ─────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────

export class TalentumDescriptionService {
  private db: Pool;
  private apiKey: string;
  private model: string;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.apiKey = process.env.GEMINI_API_KEY ?? '';
    this.model = process.env.GEMINI_MODEL ?? 'gemini-2.5-pro';
    if (!this.apiKey) throw new Error('GEMINI_API_KEY não configurado');
  }

  /**
   * Loads vacancy + patient data needed to build the Talentum prompt.
   * city/state/service_device_types/pathology_types/dependency_level were
   * dropped from job_postings in migration 152 — sourced from
   * patient_addresses (pa) and patients (p) via FKs.
   */
  private async loadInput(jobPostingId: string): Promise<GenerateDescriptionInput> {
    const result = await this.db.query(
      `SELECT
         jp.case_number, jp.title,
         jp.required_professions, jp.required_sex,
         jp.required_experience, jp.worker_attributes,
         jp.age_range_min, jp.age_range_max,
         jp.providers_needed, jp.schedule, jp.work_schedule,
         jp.salary_text, jp.payment_day,
         pa.city, pa.state,
         p.diagnosis AS pathology_types,
         p.dependency_level,
         p.service_type AS service_device_types
       FROM job_postings jp
       LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
       LEFT JOIN patients p ON jp.patient_id = p.id
       WHERE jp.id = $1`,
      [jobPostingId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Job posting ${jobPostingId} not found`);
    }

    const row = result.rows[0];
    const input: GenerateDescriptionInput = {
      caseNumber: row.case_number?.toString() ?? '',
      title: row.title ?? `Caso ${row.case_number}`,
      requiredProfessions: row.required_professions ?? [],
      requiredSex: row.required_sex ?? undefined,
      requiredExperience: row.required_experience ?? undefined,
      workerAttributes: row.worker_attributes ?? undefined,
      ageRangeMin: row.age_range_min ?? undefined,
      ageRangeMax: row.age_range_max ?? undefined,
      providersNeeded: row.providers_needed ?? undefined,
      schedule: row.schedule ?? undefined,
      workSchedule: row.work_schedule ?? undefined,
      city: row.city ?? undefined,
      state: row.state ?? undefined,
      serviceDeviceTypes: row.service_device_types ? [row.service_device_types] : undefined,
      pathologyTypes: row.pathology_types ?? undefined,
      dependencyLevel: row.dependency_level ?? undefined,
      salaryText: row.salary_text ?? undefined,
      paymentDay: row.payment_day ?? undefined,
    };

    return input;
  }

  /**
   * Generates a Talentum-ready description for a job posting WITHOUT persisting.
   * Used by the AI content preview endpoint.
   */
  async generateDescriptionPreview(jobPostingId: string): Promise<GeneratedDescription> {
    console.log(`[TalentumDesc] Generating description preview for job_posting ${jobPostingId}`);
    const input = await this.loadInput(jobPostingId);
    const llmText = await this.callGemini(input);
    const fullDescription = `${llmText.trim()}\n\n${MARCO_TEXT}`;
    return { title: input.title, description: fullDescription };
  }

  /**
   * Generates a Talentum-ready description for a job posting.
   * Calls Gemini, appends the fixed "Marco de Acompañamiento" section,
   * and saves to job_postings.talentum_description.
   */
  async generateDescription(jobPostingId: string): Promise<GeneratedDescription> {
    console.log(`[TalentumDesc] Generating description for job_posting ${jobPostingId}`);
    const input = await this.loadInput(jobPostingId);
    const llmText = await this.callGemini(input);
    const fullDescription = `${llmText.trim()}\n\n${MARCO_TEXT}`;

    // CA-3.6: persist in job_postings.talentum_description
    await this.db.query(
      `UPDATE job_postings SET talentum_description = $1, updated_at = NOW() WHERE id = $2`,
      [fullDescription, jobPostingId]
    );
    console.log(`[TalentumDesc] Description saved for job_posting ${jobPostingId}`);

    return { title: input.title, description: fullDescription };
  }

  private formatSchedule(schedule?: Array<{ dayOfWeek: number; startTime: string; endTime: string }>): string {
    if (!schedule || schedule.length === 0) return 'No especificado';
    const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    return schedule
      .map(s => `${days[s.dayOfWeek] ?? '?'}: ${s.startTime}-${s.endTime}`)
      .join(', ');
  }

  private formatAgeRange(min?: number, max?: number): string {
    if (min && max) return `De ${min} a ${max} años`;
    if (min) return `Desde ${min} años`;
    if (max) return `Hasta ${max} años`;
    return 'No especificado';
  }

  private async callGemini(input: GenerateDescriptionInput): Promise<string> {
    const profession = input.requiredProfessions.length > 0
      ? input.requiredProfessions.join(', ')
      : 'No especificado';
    const devices = input.serviceDeviceTypes && input.serviceDeviceTypes.length > 0
      ? input.serviceDeviceTypes.join(', ')
      : 'No especificado';

    const userPrompt = `Generá la descripción de la vacante para Talentum, retornando JSON con dos campos:
- "propuesta": texto del resumen objetivo del caso.
- "perfilProfesional": texto del perfil profesional sugerido.

Reglas:
- Texto plano en español argentino. SIN markdown, SIN asteriscos, SIN encabezados.
- NO incluyas saludos, introducciones, despedidas ni meta-comentarios.
- NO menciones nombre del paciente, datos de contacto ni IDs internos.
- NO inventes datos fuera de los proporcionados abajo.
- Cada campo entre 60 y 250 palabras.

Datos de la vacante:
- N° de Caso: ${input.caseNumber || 'No especificado'}
- Tipo de Profesional: ${profession}
- Sexo requerido: ${input.requiredSex || 'Indistinto'}
- Rango etario del prestador: ${this.formatAgeRange(input.ageRangeMin, input.ageRangeMax)}
- Experiencia requerida: ${input.requiredExperience || 'No especificado'}
- Atributos del prestador: ${input.workerAttributes || 'No especificado'}
- Cantidad de prestadores: ${input.providersNeeded ?? 1}
- Zona: ${[input.city, input.state].filter(Boolean).join(', ') || 'No especificado'}
- Dispositivo de servicio: ${devices}
- Jornada: ${input.workSchedule || 'No especificado'}
- Horarios: ${this.formatSchedule(input.schedule)}
- Patologías: ${input.pathologyTypes || 'No especificado'}
- Nivel de dependencia: ${input.dependencyLevel || 'No especificado'}
- Salario: ${input.salaryText || 'A convenir'}
- Día de pago: ${input.paymentDay || 'No especificado'}`;

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    // 2.5-pro spends thinking tokens within maxOutputTokens; 4096 leaves
    // ~3.5k for thinking and still fits ~500 tokens of JSON output.
    const response = await fetchGeminiWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: DESCRIPTION_SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
            responseSchema: DESCRIPTION_RESPONSE_SCHEMA,
          },
        }),
      },
      'TalentumDesc',
    );

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        thoughtsTokenCount?: number;
      };
    };

    const finishReason = data.candidates?.[0]?.finishReason;
    if (data.usageMetadata) {
      console.log(
        `[TalentumDesc] Gemini tokens: prompt=${data.usageMetadata.promptTokenCount} ` +
          `thoughts=${data.usageMetadata.thoughtsTokenCount ?? 0} ` +
          `completion=${data.usageMetadata.candidatesTokenCount} ` +
          `finishReason=${finishReason}`
      );
    }

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) {
      // MAX_TOKENS with thinking-overflow used to surface here. Keep the
      // explicit cause in the error so logs stay diagnosable.
      throw new Error(
        `Empty response from Gemini API (finishReason=${finishReason ?? 'unknown'})`,
      );
    }

    // Log JSON-stringified to survive Docker log multiline truncation
    console.log(
      `[TalentumDesc] Raw LLM content (${content.length} chars):`,
      JSON.stringify(content),
    );

    // Strip markdown code fences if the model wrapped the JSON despite
    // responseMimeType being application/json
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '');

    let parsed: { propuesta?: string; perfilProfesional?: string };
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('[TalentumDesc] Failed to parse Gemini JSON:', JSON.stringify(cleaned));
      throw new Error('Gemini returned non-JSON content for description');
    }

    const propuesta = (parsed.propuesta ?? '').trim();
    const perfil = (parsed.perfilProfesional ?? '').trim();
    if (!propuesta || !perfil) {
      throw new Error('Gemini JSON missing required fields (propuesta/perfilProfesional)');
    }

    if (
      propuesta.toLowerCase().includes(REFUSAL_MARKER) ||
      perfil.toLowerCase().includes(REFUSAL_MARKER)
    ) {
      throw new Error(
        'Gemini returned a refusal instead of a description. ' +
          'Likely cause: the vacancy required_professions and the patient service_type ' +
          'are incompatible (multi-type vacancy hitting a doc Regla #7 filter). ' +
          'Edit the vacancy or the patient before retrying.',
      );
    }

    // Assemble the final description with the canonical headers we control.
    return (
      `Descripción de la Propuesta:\n${propuesta}\n\n` +
      `Perfil Profesional Sugerido:\n${perfil}`
    );
  }
}
