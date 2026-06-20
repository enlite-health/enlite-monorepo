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
import { generateContentVertex } from './vertex-gemini';
import {
  DESCRIPTION_RESPONSE_SCHEMA,
  DESCRIPTION_SYSTEM_PROMPT,
  formatZoneForPrompt,
  MARCO_TEXT,
  REFUSAL_MARKER,
} from './talentumDescriptionHelpers';
import {
  JobPostingAuditRepository,
  type AuditActorType,
} from '../../matching/infrastructure/JobPostingAuditRepository';

export interface DescriptionAuditActor {
  actorUserId: string | null;
  actorType: AuditActorType;
  actorLabel: string;
  traceId?: string | null;
}

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
  neighborhood?: string;
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
// Service
// ─────────────────────────────────────────────────────────────────

export class TalentumDescriptionService {
  private db: Pool;
  private model: string;
  private auditRepo: JobPostingAuditRepository;

  constructor(modelOverride?: string) {
    this.db = DatabaseConnection.getInstance().getPool();
    this.model = modelOverride ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-pro';
    this.auditRepo = new JobPostingAuditRepository();
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
         pa.city, pa.state, pa.neighborhood,
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
      neighborhood: row.neighborhood ?? undefined,
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
   *
   * @param actor - Optional audit actor. When provided, an UPDATED audit row
   *   is inserted inside the same UPDATE transaction (best-effort: audit
   *   failure is logged but does NOT rollback the description save).
   */
  async generateDescription(
    jobPostingId: string,
    actor?: DescriptionAuditActor,
  ): Promise<GeneratedDescription> {
    console.log(`[TalentumDesc] Generating description for job_posting ${jobPostingId}`);
    const input = await this.loadInput(jobPostingId);
    const llmText = await this.callGemini(input);
    const fullDescription = `${llmText.trim()}\n\n${MARCO_TEXT}`;

    // CA-3.6: persist in job_postings.talentum_description + audit UPDATED
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE job_postings SET talentum_description = $1, updated_at = NOW() WHERE id = $2`,
        [fullDescription, jobPostingId],
      );
      // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
      // leaving the surrounding transaction (and the UPDATE above) intact.
      if (actor) {
        await this.auditRepo.logEventSafe(client, {
          jobPostingId,
          eventType: 'UPDATED',
          fieldName: 'talentum_description',
          changes: { before: null, after: '[generated]' },
          actorUserId: actor.actorUserId,
          actorType: actor.actorType,
          actorLabel: actor.actorLabel,
          traceId: actor.traceId ?? null,
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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
- Zona: ${formatZoneForPrompt({ neighborhood: input.neighborhood, city: input.city, state: input.state })}
- Dispositivo de servicio: ${devices}
- Jornada: ${input.workSchedule || 'No especificado'}
- Horarios: ${this.formatSchedule(input.schedule)}
- Patologías: ${input.pathologyTypes || 'No especificado'}
- Nivel de dependencia: ${input.dependencyLevel || 'No especificado'}
- Salario: ${input.salaryText || 'A convenir'}
- Día de pago: ${input.paymentDay || 'No especificado'}`;

    // 2.5-pro spends thinking tokens within maxOutputTokens; 4096 leaves
    // ~3.5k for thinking and still fits ~500 tokens of JSON output.
    const response = await generateContentVertex(
      this.model,
      {
        systemInstruction: { parts: [{ text: DESCRIPTION_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseSchema: DESCRIPTION_RESPONSE_SCHEMA,
        },
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
