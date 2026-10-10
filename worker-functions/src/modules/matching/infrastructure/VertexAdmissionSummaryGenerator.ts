import { createHash } from 'crypto';
import { generateContentVertex } from '../../integration/infrastructure/vertex-gemini';
import { GoogleDocsPromptProvider } from '../../integration/infrastructure/GoogleDocsPromptProvider';
import { AdmissionRealAdapterInTestError } from '../application/ports/AdmissionMessagingPorts';
import { AdmissionSummaryError, type AdmissionSummaryPort } from '../application/ports/AdmissionImportPorts';

/** Só o que o gerador usa do `GoogleDocsPromptProvider` (o mesmo da vacante): o teste injeta um dublê. */
export interface AdmissionPromptProvider {
  getPrompt(docId: string): Promise<string>;
}
export interface VertexAdmissionSummaryDeps {
  promptProvider?: AdmissionPromptProvider;
  /** Fronteira do Vertex; o teste injeta um dublê (o real é `generateContentVertex`). */
  vertex?: typeof generateContentVertex;
}

/** Versão do prompt que vai para a trilha: sha256 curto do TEXTO (muda quando o Doc muda). */
export const promptVersionOf = (promptText: string): string => `sha256:${createHash('sha256').update(promptText).digest('hex').slice(0, 12)}`;

/**
 * O resumo da admissão via Vertex (D482), no molde de `TalentumDescriptionService.ts`: `generateContentVertex` com ADC no
 * projeto GCP da Enlite (dentro do perímetro). As instruções vêm de um Google Doc (H4) lido por `GoogleDocsPromptProvider` (o mesmo da vacante, cache de 10 min), id em
 * `ADMISSION_SUMMARY_PROMPT_DOC_ID`. SEM o id, ou com o Doc ilegível, NÃO há resumo (`prompt_missing`/`prompt_unavailable`):
 * nunca um prompt inventado. `promptVersion` = sha256 curto do texto lido.
 *
 * Sem log do conteúdo (diferente do Talentum): a transcrição e o resumo são dado clínico. Falha vira `AdmissionSummaryError`
 * com `reason` fechado — a mensagem do Google/`fetch` pode ecoar trecho do pedido e não sobe.
 *
 * ⚠️ Lança no construtor com NODE_ENV=test: teste nunca toca o Vertex.
 */
export class VertexAdmissionSummaryGenerator implements AdmissionSummaryPort {
  private readonly model: string;
  private readonly promptProvider: AdmissionPromptProvider;
  private readonly vertex: typeof generateContentVertex;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, deps: VertexAdmissionSummaryDeps = {}) {
    if (env.NODE_ENV === 'test') throw new AdmissionRealAdapterInTestError('new VertexAdmissionSummaryGenerator()');
    this.model = env.ADMISSION_SUMMARY_MODEL ?? env.GEMINI_MODEL ?? 'gemini-2.5-pro';
    this.promptProvider = deps.promptProvider ?? new GoogleDocsPromptProvider();
    this.vertex = deps.vertex ?? generateContentVertex;
  }

  async generate(input: { transcript: string }): Promise<{ summary: string; promptVersion: string }> {
    const docId = this.env.ADMISSION_SUMMARY_PROMPT_DOC_ID?.trim();
    if (!docId) throw new AdmissionSummaryError('prompt_missing');
    let prompt: string;
    try {
      prompt = await this.promptProvider.getPrompt(docId);
    } catch {
      throw new AdmissionSummaryError('prompt_unavailable'); // a mensagem do Google pode citar o id do Doc: não sobe
    }
    if (!prompt || !prompt.trim()) throw new AdmissionSummaryError('prompt_unavailable');

    let text: string | undefined;
    try {
      const response = await this.vertex(
        this.model,
        {
          systemInstruction: { parts: [{ text: prompt }] },
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
    return { summary: text.trim(), promptVersion: promptVersionOf(prompt) };
  }
}
