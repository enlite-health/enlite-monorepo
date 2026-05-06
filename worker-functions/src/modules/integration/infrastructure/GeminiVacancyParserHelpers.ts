/**
 * GeminiVacancyParserHelpers
 *
 * Extracted helpers for GeminiVacancyParserService to keep the main file ≤ 400 lines.
 * Contains: Talentum description parsing, missing-field detection, and retry logic.
 */

import {
  TALENTUM_VACANCY_ONLY_INSTRUCTIONS,
  TALENTUM_VACANCY_RESPONSE_SCHEMA,
} from './gemini-vacancy-constants';
import type { ParsedVacancyResult } from './GeminiVacancyParserService';

// ── parseFromTalentumDescription ─────────────────────────────────────────────

export async function parseFromTalentumDescriptionHelper(
  apiKey: string,
  model: string,
  description: string,
  title: string,
): Promise<ParsedVacancyResult['vacancy']> {
  console.log(
    `[GeminiParser] Parsing Talentum description, title="${title}", len=${description.length}`,
  );

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: TALENTUM_VACANCY_ONLY_INSTRUCTIONS }] },
      contents: [{ role: 'user', parts: [{ text: `Título del proyecto: ${title}\n\n${description}` }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema: TALENTUM_VACANCY_RESPONSE_SCHEMA,
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
      `[GeminiParser] Talentum tokens: prompt=${data.usageMetadata.promptTokenCount} ` +
        `completion=${data.usageMetadata.candidatesTokenCount}`,
    );
  }

  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Empty response from Gemini API');

  const parsed = JSON.parse(content) as Omit<ParsedVacancyResult['vacancy'], 'case_number' | 'title'>;

  // Extract case_number from title (source of truth)
  const match = title.match(/CASO\s+(\d+)/i);
  const caseNumber = match ? parseInt(match[1], 10) : null;

  const vacancy: ParsedVacancyResult['vacancy'] = {
    ...parsed,
    case_number: caseNumber,
    title: caseNumber ? `CASO ${caseNumber}` : title,
    status: 'SEARCHING',
    providers_needed: parsed.providers_needed || 1,
    required_professions:
      parsed.required_professions?.length > 0
        ? parsed.required_professions
        : ['AT'],
  };

  console.log(
    `[GeminiParser] Talentum OK: case=${vacancy.case_number}, professions=${vacancy.required_professions}`,
  );

  return vacancy;
}

// ── detectMissingFields ───────────────────────────────────────────────────────

export function detectMissingFields(
  vacancy: ParsedVacancyResult['vacancy'],
): string[] {
  const critical: Array<{ key: keyof ParsedVacancyResult['vacancy']; label: string }> = [
    { key: 'age_range_min', label: 'age_range_min' },
    { key: 'age_range_max', label: 'age_range_max' },
    { key: 'required_sex', label: 'required_sex' },
    { key: 'required_experience', label: 'required_experience' },
    { key: 'salary_text', label: 'salary_text' },
    { key: 'work_schedule', label: 'work_schedule' },
  ];
  const missing: string[] = [];
  for (const { key, label } of critical) {
    if (vacancy[key] === null || vacancy[key] === undefined) {
      missing.push(label);
    }
  }
  if (!vacancy.schedule || vacancy.schedule.length === 0) {
    missing.push('schedule');
  }
  return missing;
}

// ── retryMissingFields ────────────────────────────────────────────────────────

export async function retryMissingFields(
  apiKey: string,
  model: string,
  vacancy: ParsedVacancyResult['vacancy'],
  originalText: string,
  missingFields: string[],
): Promise<ParsedVacancyResult['vacancy']> {
  const fieldList = missingFields.join(', ');
  const prompt =
    `El siguiente texto fue analizado pero estos campos quedaron vacíos: ${fieldList}.\n` +
    `Revisá el texto nuevamente y extraé SOLO los campos faltantes.\n` +
    `Respondé ÚNICAMENTE con un JSON que contenga solo los campos que pudiste extraer.\n` +
    `Si realmente no hay información para un campo, omitilo del JSON.\n\n` +
    `Texto original:\n${originalText}`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      console.warn(`[GeminiParser] Retry call failed HTTP ${response.status}, keeping original`);
      return vacancy;
    }

    const data = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) return vacancy;

    const patch = JSON.parse(content) as Record<string, unknown>;
    let patched = 0;
    for (const field of missingFields) {
      if (patch[field] !== undefined && patch[field] !== null) {
        (vacancy as Record<string, unknown>)[field] = patch[field];
        patched++;
      }
    }
    console.log(
      `[GeminiParser] Retry patched ${patched}/${missingFields.length} fields`,
    );
  } catch (err) {
    console.warn(`[GeminiParser] Retry failed, keeping original:`, err);
  }
  return vacancy;
}
