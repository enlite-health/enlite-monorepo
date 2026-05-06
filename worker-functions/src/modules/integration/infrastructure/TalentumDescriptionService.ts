/**
 * TalentumDescriptionService
 *
 * Uses Gemini (default `gemini-2.5-flash`) to generate the formatted vacancy
 * description that Talentum expects when creating a prescreening project.
 *
 * The output has 3 sections:
 *   1. "Descripcion de la Propuesta:" — objective summary
 *   2. "Perfil Profesional Sugerido:" — ideal candidate profile
 *   3. "El Marco de Acompanamiento:" — fixed institutional text
 *
 * Same provider as `GeminiVacancyParserService` so we don't carry a second
 * LLM credential in dev/prod just for description generation.
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { GoogleDocsPromptProvider } from './GoogleDocsPromptProvider';

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
// System prompt — loaded from Google Drive at runtime via
// `GoogleDocsPromptProvider`. The doc is picked by worker type
// (PROMPT_DOC_ID_AT or PROMPT_DOC_ID_CUIDADOR) — same pattern as
// `GeminiVacancyParserService.buildSystemPrompt`.
//
// The doc may contain instructions for several flows (parsing,
// prescreening, description). To force the LLM to return ONLY the
// description content we use Gemini's `responseSchema` with two named
// fields. This way we don't depend on the doc's structure and we get
// no introductory greetings or stray section headers.
// ─────────────────────────────────────────────────────────────────

export type WorkerType = 'AT' | 'CUIDADOR';

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
  private promptProvider: GoogleDocsPromptProvider;

  constructor(promptProvider?: GoogleDocsPromptProvider) {
    this.db = DatabaseConnection.getInstance().getPool();
    this.apiKey = process.env.GEMINI_API_KEY ?? '';
    this.model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    if (!this.apiKey) throw new Error('GEMINI_API_KEY não configurado');
    this.promptProvider = promptProvider ?? new GoogleDocsPromptProvider();
  }

  /**
   * Loads the system prompt from the Google Doc that matches the worker
   * type. Reuses the same docs the parser/prescreening flow already uses
   * (`PROMPT_DOC_ID_AT` / `PROMPT_DOC_ID_CUIDADOR`).
   */
  private async loadSystemPrompt(workerType: WorkerType): Promise<string> {
    const docId =
      workerType === 'AT'
        ? process.env.PROMPT_DOC_ID_AT ?? ''
        : process.env.PROMPT_DOC_ID_CUIDADOR ?? '';
    return this.promptProvider.getPrompt(docId);
  }

  /** Maps `required_professions` from the vacancy to the prompt worker type. */
  private resolveWorkerType(professions: string[] | null | undefined): WorkerType {
    return Array.isArray(professions) && professions.includes('CAREGIVER')
      ? 'CUIDADOR'
      : 'AT';
  }

  /**
   * Generates a Talentum-ready description for a job posting WITHOUT persisting.
   * Same logic as generateDescription but skips the DB update.
   * Used by the AI content preview endpoint.
   */
  async generateDescriptionPreview(jobPostingId: string): Promise<GeneratedDescription> {
    console.log(`[TalentumDesc] Generating description preview for job_posting ${jobPostingId}`);

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

    const workerType = this.resolveWorkerType(row.required_professions);
    const llmText = await this.callGemini(input, workerType);
    const fullDescription = `${llmText.trim()}\n\n${MARCO_TEXT}`;

    return { title: input.title, description: fullDescription };
  }

  /**
   * Generates a Talentum-ready description for a job posting.
   * Fetches vacancy + patient data from DB, calls Gemini, appends the fixed
   * "Marco de Acompañamiento" section, and saves to job_postings.talentum_description.
   */
  async generateDescription(jobPostingId: string): Promise<GeneratedDescription> {
    console.log(`[TalentumDesc] Generating description for job_posting ${jobPostingId}`);

    // city/state/service_device_types/pathology_types/dependency_level dropped in migration 152.
    // Sourced from patient_addresses (pa) and patients (p) via FKs.
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

    const workerType = this.resolveWorkerType(row.required_professions);
    const llmText = await this.callGemini(input, workerType);

    // Append the fixed institutional section 3
    const fullDescription = `${llmText.trim()}\n\n${MARCO_TEXT}`;

    // Persist in job_postings.talentum_description (CA-3.6)
    await this.db.query(
      `UPDATE job_postings SET talentum_description = $1, updated_at = NOW() WHERE id = $2`,
      [fullDescription, jobPostingId]
    );

    console.log(`[TalentumDesc] Description saved for job_posting ${jobPostingId}`);

    return {
      title: input.title,
      description: fullDescription,
    };
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

  private async callGemini(input: GenerateDescriptionInput, workerType: WorkerType): Promise<string> {
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

    const systemPrompt = await this.loadSystemPrompt(workerType);
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
          responseSchema: DESCRIPTION_RESPONSE_SCHEMA,
        },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[TalentumDesc] Gemini API error HTTP ${response.status}: ${errBody}`);
      throw new Error(`Gemini API error ${response.status}: ${errBody}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
    };

    if (data.usageMetadata) {
      console.log(
        `[TalentumDesc] Gemini tokens: prompt=${data.usageMetadata.promptTokenCount} ` +
          `completion=${data.usageMetadata.candidatesTokenCount}`
      );
    }

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error('Empty response from Gemini API');

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

    // Assemble the final description with the canonical headers we control.
    return (
      `Descripción de la Propuesta:\n${propuesta}\n\n` +
      `Perfil Profesional Sugerido:\n${perfil}`
    );
  }
}
