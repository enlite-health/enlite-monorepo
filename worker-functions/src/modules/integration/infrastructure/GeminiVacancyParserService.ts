/**
 * GeminiVacancyParserService
 *
 * Calls Google Gemini to parse free-text vacancy data into structured JSON.
 * Replaces the manual Gem workflow where recruiters would paste case data
 * into Google AI Studio and manually copy results.
 *
 * Input:  free text with case details + worker type (AT or CUIDADOR)
 * Output: structured JSON with vacancy fields, prescreening questions,
 *         FAQ, and Talentum description sections.
 *
 * Heavy helpers (Talentum description parsing, retry logic) live in
 * GeminiVacancyParserHelpers.ts to keep this file ≤ 400 lines.
 */

import {
  VACANCY_RESPONSE_SCHEMA,
  JSON_OUTPUT_INSTRUCTIONS,
} from './gemini-vacancy-constants';
import { GoogleDocsPromptProvider } from './GoogleDocsPromptProvider';
import {
  parseFromTalentumDescriptionHelper,
  detectMissingFields,
  retryMissingFields,
} from './GeminiVacancyParserHelpers';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface ParsedVacancyResult {
  vacancy: {
    case_number: number | null;
    title: string;
    required_professions: string[];
    required_sex: string | null;
    age_range_min: number | null;
    age_range_max: number | null;
    required_experience: string | null;
    worker_attributes: string | null;
    schedule: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
    work_schedule: string | null;
    /** Transit field: passed to patients.diagnosis via createWithPatientUpdate. Not persisted in job_postings. */
    pathology_types?: string | null;
    /** Transit field: passed to patients.dependency_level via createWithPatientUpdate. Not persisted in job_postings. */
    dependency_level?: string | null;
    providers_needed: number;
    salary_text: string | null;
    payment_day: string | null;
    daily_obs: string | null;
    status: string;
  };
  prescreening: {
    questions: Array<{
      question: string;
      responseType: string[];
      desiredResponse: string;
      weight: number;
      required: boolean;
      analyzed: boolean;
      earlyStoppage: boolean;
    }>;
    faq: Array<{
      question: string;
      answer: string;
    }>;
  };
  description: {
    titulo_propuesta: string;
    descripcion_propuesta: string;
    perfil_profesional: string;
  };
}

export type WorkerType = 'AT' | 'CUIDADOR';

// ─────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────

export class GeminiVacancyParserService {
  private apiKey: string;
  private model: string;
  private promptProvider: GoogleDocsPromptProvider;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY ?? '';
    this.model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    this.promptProvider = new GoogleDocsPromptProvider();
  }

  async parseFromText(
    text: string,
    workerType: WorkerType,
  ): Promise<ParsedVacancyResult> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY não configurado');
    }

    console.log(
      `[GeminiParser] Parsing vacancy text, workerType=${workerType}, len=${text.length}`,
    );

    const userParts = [{ text }];
    return this.callGeminiAndParse(userParts, workerType);
  }

  async parseFromPdf(
    pdfBase64: string,
    workerType: WorkerType,
  ): Promise<ParsedVacancyResult> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY não configurado');
    }

    const sizeKB = Math.round((pdfBase64.length * 3) / 4 / 1024);
    console.log(
      `[GeminiParser] Parsing PDF, workerType=${workerType}, sizeKB=${sizeKB}`,
    );

    const userParts = [
      { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
    ];
    return this.callGeminiAndParse(userParts, workerType);
  }

  /**
   * Generates prescreening questions + FAQ from structured vacancy data
   * without requiring a PDF or raw text. Builds a plain-text summary and
   * delegates to parseFromText.
   */
  async generateFromVacancyData(
    vacancy: {
      title?: string;
      case_number?: number | string | null;
      required_professions?: string[];
      required_sex?: string | null;
      age_range_min?: number | null;
      age_range_max?: number | null;
      required_experience?: string | null;
      worker_attributes?: string | null;
      schedule?: Array<{ dayOfWeek: number; startTime: string; endTime: string }> | null;
      work_schedule?: string | null;
      providers_needed?: number | null;
      salary_text?: string | null;
      payment_day?: string | null;
      daily_obs?: string | null;
    },
    patient: {
      diagnosis?: string | null;
      dependency_level?: string | null;
      service_type?: string[] | null;
    },
    address: {
      address_formatted?: string | null;
      city?: string | null;
      state?: string | null;
    },
    workerType: WorkerType = 'AT',
  ): Promise<ParsedVacancyResult> {
    const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const scheduleText =
      vacancy.schedule && vacancy.schedule.length > 0
        ? vacancy.schedule
            .map((s) => `${days[s.dayOfWeek] ?? '?'}: ${s.startTime}-${s.endTime}`)
            .join(', ')
        : 'No especificado';

    const text = [
      `Título: ${vacancy.title ?? 'Sin título'}`,
      `Caso N°: ${vacancy.case_number ?? 'No especificado'}`,
      `Tipo de profesional: ${(vacancy.required_professions ?? []).join(', ') || 'No especificado'}`,
      `Sexo requerido: ${vacancy.required_sex || 'Indistinto'}`,
      `Rango etario del AT: ${vacancy.age_range_min ?? '?'} a ${vacancy.age_range_max ?? '?'} años`,
      `Experiencia requerida: ${vacancy.required_experience || 'No especificada'}`,
      `Atributos del AT: ${vacancy.worker_attributes || 'No especificados'}`,
      `Horarios: ${scheduleText}`,
      `Jornada: ${vacancy.work_schedule || 'No especificada'}`,
      `Prestadores necesarios: ${vacancy.providers_needed ?? 1}`,
      `Salario: ${vacancy.salary_text || 'A convenir'}`,
      `Día de pago: ${vacancy.payment_day || 'No especificado'}`,
      `Patologías: ${patient.diagnosis || 'No especificadas'}`,
      `Nivel de dependencia: ${patient.dependency_level || 'No especificado'}`,
      `Tipo de servicio: ${(patient.service_type ?? []).join(', ') || 'No especificado'}`,
      `Zona: ${[address.city, address.state].filter(Boolean).join(', ') || address.address_formatted || 'No especificada'}`,
      vacancy.daily_obs ? `Observaciones: ${vacancy.daily_obs}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return this.parseFromText(text, workerType);
  }

  async parseFromTalentumDescription(
    description: string,
    title: string,
  ): Promise<ParsedVacancyResult['vacancy']> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY não configurado');
    }
    return parseFromTalentumDescriptionHelper(this.apiKey, this.model, description, title);
  }

  private async callGeminiAndParse(
    userParts: Array<Record<string, any>>,
    workerType: WorkerType,
  ): Promise<ParsedVacancyResult> {
    const systemPrompt = await this.buildSystemPrompt(workerType);
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
          responseSchema: VACANCY_RESPONSE_SCHEMA,
        },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(
        `[GeminiParser] Gemini API error HTTP ${response.status}: ${errBody}`,
      );
      throw new Error(`Gemini API error ${response.status}: ${errBody}`);
    }

    const data = (await response.json()) as {
      candidates: Array<{
        content: { parts: Array<{ text: string }> };
      }>;
      usageMetadata?: {
        promptTokenCount: number;
        candidatesTokenCount: number;
      };
    };

    if (data.usageMetadata) {
      console.log(
        `[GeminiParser] Tokens: prompt=${data.usageMetadata.promptTokenCount} ` +
          `completion=${data.usageMetadata.candidatesTokenCount}`,
      );
    }

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error('Empty response from Gemini API');

    let parsed = JSON.parse(content) as ParsedVacancyResult;

    // Ensure sane defaults
    parsed.vacancy.status = parsed.vacancy.status || 'SEARCHING';
    parsed.vacancy.providers_needed = parsed.vacancy.providers_needed || 1;
    parsed.vacancy.required_professions =
      parsed.vacancy.required_professions?.length > 0
        ? parsed.vacancy.required_professions
        : [workerType === 'AT' ? 'AT' : 'CAREGIVER'];

    // Retry missing critical fields with a focused second call
    const originalText = userParts
      .filter((p) => 'text' in p)
      .map((p) => (p as { text: string }).text)
      .join('\n');
    if (originalText) {
      const missing = detectMissingFields(parsed.vacancy);
      if (missing.length > 0) {
        console.log(
          `[GeminiParser] Missing fields detected: ${missing.join(', ')}. Retrying...`,
        );
        parsed.vacancy = await retryMissingFields(
          this.apiKey,
          this.model,
          parsed.vacancy,
          originalText,
          missing,
        );
      }
    }

    console.log(
      `[GeminiParser] OK: case=${parsed.vacancy.case_number}, ` +
        `questions=${parsed.prescreening.questions.length}, ` +
        `faq=${parsed.prescreening.faq.length}`,
    );

    return parsed;
  }

  private async buildSystemPrompt(workerType: WorkerType): Promise<string> {
    const docId =
      workerType === 'AT'
        ? process.env.PROMPT_DOC_ID_AT ?? ''
        : process.env.PROMPT_DOC_ID_CUIDADOR ?? '';

    const fileContent = await this.promptProvider.getPrompt(docId);

    return fileContent + '\n\n' + JSON_OUTPUT_INSTRUCTIONS;
  }
}
