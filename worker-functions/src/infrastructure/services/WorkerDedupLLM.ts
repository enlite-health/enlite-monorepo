/**
 * WorkerDedupLLM
 *
 * Groq/LLM logic for WorkerDeduplicationService — extracted to keep the
 * main service under the 400-line limit.
 *
 * Exports:
 *   DuplicateAnalysis    (re-exported from WorkerDeduplicationService)
 *   LLMDedupResponse     (internal shape returned by Groq)
 *   analyzeWithLLM()     (standalone function — no class, no DI)
 *   parseLLMResponse()   (exported for tests that access it via (service as any))
 */

import type { DuplicateCandidate } from '../repositories/AnalyticsRepository';
import type { DuplicateAnalysis } from './WorkerDeduplicationService';

export interface LLMDedupResponse {
  is_same_person: boolean;
  confidence: number;
  explanation: string;
  preferred_phone: 1 | 2 | null;
  preferred_email: 1 | 2 | null;
  preferred_first_name: 1 | 2 | null;
  preferred_last_name: 1 | 2 | null;
  preferred_cuit: 1 | 2 | null;
  merged_phone: string | null;
  merged_email: string;
  merged_first_name: string | null;
  merged_last_name: string | null;
  merged_cuit: string | null;
}

export function parseLLMResponse(raw: Partial<LLMDedupResponse>): DuplicateAnalysis {
  return {
    isSamePerson:       typeof raw.is_same_person === 'boolean' ? raw.is_same_person : false,
    confidence:         typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0,
    explanation:        typeof raw.explanation === 'string' ? raw.explanation : '',
    preferredPhone:     [1, 2].includes(raw.preferred_phone as number) ? raw.preferred_phone as 1 | 2 : null,
    preferredEmail:     [1, 2].includes(raw.preferred_email as number) ? raw.preferred_email as 1 | 2 : null,
    preferredFirstName: [1, 2].includes(raw.preferred_first_name as number) ? raw.preferred_first_name as 1 | 2 : null,
    preferredLastName:  [1, 2].includes(raw.preferred_last_name as number) ? raw.preferred_last_name as 1 | 2 : null,
    preferredCuit:      [1, 2].includes(raw.preferred_cuit as number) ? raw.preferred_cuit as 1 | 2 : null,
    mergedPhone:        typeof raw.merged_phone === 'string' ? raw.merged_phone : null,
    mergedEmail:        typeof raw.merged_email === 'string' ? raw.merged_email : '',
    mergedFirstName:    typeof raw.merged_first_name === 'string' ? raw.merged_first_name : null,
    mergedLastName:     typeof raw.merged_last_name === 'string' ? raw.merged_last_name : null,
    mergedCuit:         typeof raw.merged_cuit === 'string' ? raw.merged_cuit : null,
  };
}

export async function analyzeWithLLM(
  pair: DuplicateCandidate,
  apiKey: string,
  model: string,
): Promise<DuplicateAnalysis> {
  const systemPrompt = `Eres un asistente experto en gestión de datos de trabajadores de salud en Argentina.
Tu tarea es analizar dos perfiles de worker y determinar si son la misma persona, considerando que los datos pueden provenir de diferentes fuentes (Ana Care, Talentum, Planilla Operativa, Talent Search CSV) y pueden tener errores tipográficos, truncaciones o formatos distintos.
Responde ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown.`;

  const userPrompt = `Analiza si estos dos perfiles corresponden a la misma persona:

WORKER 1 (fuentes: ${pair.worker1Sources.join(', ') || 'desconocida'}):
- Nombre: ${pair.worker1FirstName ?? '?'} ${pair.worker1LastName ?? '?'}
- Teléfono: ${pair.worker1Phone ?? 'sin teléfono'}
- Email: ${pair.worker1Email}
- CUIT/CUIL: ${pair.worker1Cuit ?? 'no registrado'}

WORKER 2 (fuentes: ${pair.worker2Sources.join(', ') || 'desconocida'}):
- Nombre: ${pair.worker2FirstName ?? '?'} ${pair.worker2LastName ?? '?'}
- Teléfono: ${pair.worker2Phone ?? 'sin teléfono'}
- Email: ${pair.worker2Email}
- CUIT/CUIL: ${pair.worker2Cuit ?? 'no registrado'}

Motivo de detección: ${pair.matchReason}

REGLAS DE COMPLEMENTACIÓN:
- Teléfonos argentinos: 10 dígitos (ej: 1151265663) equivalen a 13 dígitos con prefixo (ej: 5491151265663). Son el mismo número si coinciden los últimos dígitos.
- Diferencia de 1-2 caracteres en teléfono puede ser truncación o typo (ej: 549115126566**3** vs 549115126566**0**).
- El CUIT/CUIL es el identificador más confiable de identidad.
- Emails con dominio idéntico y nombres similares sugieren duplicata.
- Para datos complementarios: elige el más completo y mejor formateado.

Responde exactamente con este JSON:
{
  "is_same_person": true/false,
  "confidence": 0.0-1.0,
  "explanation": "motivo en 1-2 oraciones",
  "preferred_phone": 1 o 2 o null,
  "preferred_email": 1 o 2 o null,
  "preferred_first_name": 1 o 2 o null,
  "preferred_last_name": 1 o 2 o null,
  "preferred_cuit": 1 o 2 o null,
  "merged_phone": "teléfono canónico (13 dígitos con 549 si AR) o null",
  "merged_email": "email canónico",
  "merged_first_name": "nombre canónico o null",
  "merged_last_name": "apellido canónico o null",
  "merged_cuit": "CUIT canônico (11 dígitos) o null"
}`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error('Resposta vazia da Groq API');

  return parseLLMResponse(JSON.parse(content) as Partial<LLMDedupResponse>);
}
