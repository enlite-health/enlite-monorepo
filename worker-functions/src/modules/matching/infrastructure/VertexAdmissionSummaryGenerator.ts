import { createHash } from 'crypto';
import { generateContentVertex } from '../../integration/infrastructure/vertex-gemini';
import { GoogleDocsPromptProvider } from '../../integration/infrastructure/GoogleDocsPromptProvider';
import { AdmissionRealAdapterInTestError } from '../application/ports/AdmissionMessagingPorts';
import { AdmissionSummaryError, type AdmissionSummaryPort, type AdmissionSummaryResult } from '../application/ports/AdmissionImportPorts';
import { TherapeuticCatalogRepository } from '@modules/case/infrastructure/TherapeuticCatalogRepository';
import { DEPENDENCY_LEVELS } from '@modules/case/domain/enums/DependencyLevel';
import { PROFESSIONS } from '@modules/worker/domain/enums/Profession';
import { ADMISSION_STAFFING_RULES } from '../domain/admissionStaffingRules';
import { DEPENDENCY_LABELS_ES, PROFESSION_LABELS_ES } from '../domain/admissionCatalogLabels';
import { buildInterviewInput, fillPrompt, findUnfilled, normalizeMarkdownEscapes } from '../application/admissionPromptFiller';
import { splitGemOutput } from '../application/admissionGemOutput';

/** Só o que o gerador usa do `GoogleDocsPromptProvider` (o mesmo da vacante): o teste injeta um dublê. */
export interface AdmissionPromptProvider {
  getPrompt(docId: string): Promise<string>;
}
/**
 * Catálogos que vêm do banco/terminologia. `pathologyTypeLabels` NÃO tem fonte enumerável hoje (a `TerminologyPort` só resolve
 * por URI/busca; não lista capítulos CID-11): sem ele o marcador `CATALOGO_TIPO_PATOLOGIA` fica sem preencher e a trava barra o resumo.
 */
export interface AdmissionPromptCatalogs {
  segmentLabels(): Promise<string[]>;
  pathologyTypeLabels?(): Promise<string[]>;
}

const joinLabels = (labels: readonly string[]): string => labels.join(' / ');

/** Os 8 marcadores do Doc: enum/catálogo do app + regras do Marcel (`admissionStaffingRules`). Valor vazio = não preenche (a trava pega). */
export async function buildPromptValues(catalogs: AdmissionPromptCatalogs): Promise<Record<string, string>> {
  const values: Record<string, string> = { ...ADMISSION_STAFFING_RULES };
  const known = (Object.keys(DEPENDENCY_LABELS_ES) as Array<keyof typeof DEPENDENCY_LABELS_ES>).filter((k) => DEPENDENCY_LEVELS.includes(k));
  values.ESCALA_DEPENDENCIA_ENLITE = joinLabels(known.map((k) => DEPENDENCY_LABELS_ES[k]));
  values.CATALOGO_TIPOS_PRESTADOR = joinLabels(PROFESSIONS.map((p) => PROFESSION_LABELS_ES[p]));
  const segments = await catalogs.segmentLabels();
  if (segments.length) values.CATALOGO_SEGMENTOS_CLINICOS = joinLabels(segments);
  const pathology = catalogs.pathologyTypeLabels ? await catalogs.pathologyTypeLabels() : [];
  if (pathology.length) values.CATALOGO_TIPO_PATOLOGIA = joinLabels(pathology);
  return values;
}

const defaultCatalogs = (): AdmissionPromptCatalogs => {
  const repo = new TherapeuticCatalogRepository();
  return { segmentLabels: async () => (await repo.list('segments')).map((i) => i.label) };
};

export interface VertexAdmissionSummaryDeps {
  catalogs?: AdmissionPromptCatalogs;
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
  private readonly catalogs: AdmissionPromptCatalogs;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, deps: VertexAdmissionSummaryDeps = {}) {
    if (env.NODE_ENV === 'test') throw new AdmissionRealAdapterInTestError('new VertexAdmissionSummaryGenerator()');
    this.model = env.ADMISSION_SUMMARY_MODEL ?? env.GEMINI_MODEL ?? 'gemini-2.5-pro';
    this.promptProvider = deps.promptProvider ?? new GoogleDocsPromptProvider();
    this.vertex = deps.vertex ?? generateContentVertex;
    this.catalogs = deps.catalogs ?? defaultCatalogs();
  }

  async generate(input: { transcript: string; entrevistaId?: string; fecha?: string }): Promise<AdmissionSummaryResult> {
    const docId = this.env.ADMISSION_SUMMARY_PROMPT_DOC_ID?.trim();
    if (!docId) throw new AdmissionSummaryError('prompt_missing');
    let prompt: string;
    try {
      prompt = await this.promptProvider.getPrompt(docId);
    } catch {
      throw new AdmissionSummaryError('prompt_unavailable'); // a mensagem do Google pode citar o id do Doc: não sobe
    }
    if (!prompt || !prompt.trim()) throw new AdmissionSummaryError('prompt_unavailable');

    // Escapes de Markdown (só aqui) e marcadores. Sobrou QUALQUER `{{NOME}}` -> não roda, só o NOME vai ao erro.
    let values: Record<string, string>;
    try {
      values = await buildPromptValues(this.catalogs);
    } catch {
      throw new AdmissionSummaryError('prompt_unavailable');
    }
    const filled = fillPrompt(normalizeMarkdownEscapes(prompt), values);
    const unfilled = findUnfilled(filled);
    if (unfilled.length) throw new AdmissionSummaryError('prompt_unfilled_placeholder', unfilled);

    let text: string | undefined;
    try {
      const response = await this.vertex(
        this.model,
        {
          systemInstruction: { parts: [{ text: filled }] },
          contents: [{ role: 'user', parts: [{ text: buildInterviewInput(input, input.transcript) }] }],
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
    const out = splitGemOutput(text);
    if (!out.readable) throw new AdmissionSummaryError('empty_response');
    return { summary: out.readable, promptVersion: promptVersionOf(prompt), structured: out.json, jsonInvalid: out.jsonInvalid };
  }
}
