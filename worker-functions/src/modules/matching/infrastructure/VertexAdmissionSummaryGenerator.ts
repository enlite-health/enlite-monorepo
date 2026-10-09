import { generateContentVertex } from '../../integration/infrastructure/vertex-gemini';
import { AdmissionRealAdapterInTestError } from '../application/ports/AdmissionMessagingPorts';
import { AdmissionSummaryError, type AdmissionSummaryPort } from '../application/ports/AdmissionImportPorts';
import { ADMISSION_SUMMARY_PROMPT_VERSION, ADMISSION_SUMMARY_SYSTEM_INSTRUCTION } from './admissionSummaryPrompt';

/**
 * O resumo da admissão via Vertex (D482), no molde de `TalentumDescriptionService.ts`: `generateContentVertex` com ADC no
 * projeto GCP da Enlite (dentro do perímetro). As instruções vivem em `admissionSummaryPrompt.ts`, versionadas.
 *
 * Sem log do conteúdo (diferente do Talentum): a transcrição e o resumo são dado clínico. Falha vira `AdmissionSummaryError`
 * com `reason` fechado — a mensagem do Google/`fetch` pode ecoar trecho do pedido e não sobe.
 *
 * ⚠️ Lança no construtor com NODE_ENV=test: teste nunca toca o Vertex.
 */
export class VertexAdmissionSummaryGenerator implements AdmissionSummaryPort {
  private readonly model: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (env.NODE_ENV === 'test') throw new AdmissionRealAdapterInTestError('new VertexAdmissionSummaryGenerator()');
    this.model = env.ADMISSION_SUMMARY_MODEL ?? env.GEMINI_MODEL ?? 'gemini-2.5-pro';
  }

  async generate(input: { transcript: string }): Promise<{ summary: string; promptVersion: string }> {
    let text: string | undefined;
    try {
      const response = await generateContentVertex(
        this.model,
        {
          systemInstruction: { parts: [{ text: ADMISSION_SUMMARY_SYSTEM_INSTRUCTION }] },
          contents: [{ role: 'user', parts: [{ text: input.transcript }] }],
          // 2.5-pro gasta parte do teto em "thinking"; 8192 deixa folga para um resumo longo.
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
        },
        'AdmissionSummary',
      );
      const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
    } catch {
      throw new AdmissionSummaryError('vertex_failed');
    }
    if (!text || !text.trim()) throw new AdmissionSummaryError('empty_response');
    return { summary: text.trim(), promptVersion: ADMISSION_SUMMARY_PROMPT_VERSION };
  }
}
