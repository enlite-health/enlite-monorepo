import { createHash } from 'crypto';
import { generateContentVertex } from '../../integration/infrastructure/vertex-gemini';
import { GoogleDocsPromptProvider } from '../../integration/infrastructure/GoogleDocsPromptProvider';
import { AdmissionRealAdapterInTestError } from '../application/ports/AdmissionMessagingPorts';
import { AdmissionSummaryError, type AdmissionSummaryInput, type AdmissionSummaryPort, type AdmissionSummaryResult } from '../application/ports/AdmissionImportPorts';
import { assertSummaryShape } from '../application/admissionSummaryGate';
import { TherapeuticCatalogRepository } from '@modules/case/infrastructure/TherapeuticCatalogRepository';
import { DEPENDENCY_LEVELS } from '@modules/case/domain/enums/DependencyLevel';
import { PROFESSIONS } from '@modules/worker/domain/enums/Profession';
import { ADMISSION_STAFFING_RULES } from '../domain/admissionStaffingRules';
import { DEPENDENCY_LABELS_ES, PROFESSION_LABELS_ES } from '../domain/admissionCatalogLabels';
import type { TerminologyPort } from '@modules/terminology/domain/TerminologyPort';
import { createTerminologyPort } from '@modules/terminology/infrastructure/TerminologyPortFactory';
import { TerminologyUnavailableError } from '@modules/terminology/domain/UnavailableTerminology';
import { VertexAuthError } from '../../integration/infrastructure/vertex-gemini';
import { GeminiApiError } from '../../integration/infrastructure/gemini-fetch';
import { buildInterviewInput, fillPrompt, findUnfilled, normalizeMarkdownEscapes } from '../application/admissionPromptFiller';
import { splitGemOutput } from '../application/admissionGemOutput';

/** Só o que o gerador usa do `GoogleDocsPromptProvider` (o mesmo da vacante): o teste injeta um dublê. */
export interface AdmissionPromptProvider {
  getPrompt(docId: string): Promise<string>;
}
/** Catálogos que vêm do banco/terminologia (rótulos prontos). Lista vazia = catálogo não carregado -> o resumo NÃO roda. */
/**
 * Teto de saída medido: o Vertex recusa `maxOutputTokens` >= 65537 para gemini-2.5-pro (400 INVALID_ARGUMENT, medido em 10/10/2026).
 * O teto conta o thinking: 8192 de thinking explícito + até 24576 de JSON + resumo (o JSON do Gem tem ~5-8 mil tokens).
 * `thinkingBudget` aceito pelo 2.5-pro (medido: STOP, thoughtsTokenCount 184).
 */
/**
 * Prazo TOTAL da chamada ao Vertex (inclui retries do helper). Cabe no `attempt_deadline` do Scheduler (300s) e no `--timeout=600s`
 * do Cloud Run; 2.5-pro com 8192 de thinking e até ~24k de saída leva dezenas de segundos. Estourou = `vertex_timeout` (conta no teto).
 */
export const VERTEX_TIMEOUT_MS = 180_000;
export const MAX_OUTPUT_TOKENS = 32768;
export const THINKING_BUDGET = 8192;

export interface AdmissionPromptCatalogs {
  segmentLabels(): Promise<string[]>;
  pathologyTypeLabels(): Promise<string[]>;
}

const joinLabels = (labels: readonly string[]): string => labels.join(' / ');

/**
 * Os 8 marcadores do Doc: enum/catálogo do app + regras do Marcel (`admissionStaffingRules`). Catálogo VAZIO não vira prompt
 * com lista vazia: `prompt_catalog_empty` com o nome do marcador (nunca mandar catálogo vazio ao modelo).
 */
export async function buildPromptValues(catalogs: AdmissionPromptCatalogs): Promise<Record<string, string>> {
  const values: Record<string, string> = { ...ADMISSION_STAFFING_RULES };
  const known = (Object.keys(DEPENDENCY_LABELS_ES) as Array<keyof typeof DEPENDENCY_LABELS_ES>).filter((k) => DEPENDENCY_LEVELS.includes(k));
  values.ESCALA_DEPENDENCIA_ENLITE = joinLabels(known.map((k) => DEPENDENCY_LABELS_ES[k]));
  values.CATALOGO_TIPOS_PRESTADOR = joinLabels(PROFESSIONS.map((p) => PROFESSION_LABELS_ES[p]));
  const fromDb: Array<[string, () => Promise<string[]>]> = [
    ['CATALOGO_SEGMENTOS_CLINICOS', () => catalogs.segmentLabels()],
    ['CATALOGO_TIPO_PATOLOGIA', () => catalogs.pathologyTypeLabels()],
  ];
  for (const [marker, load] of fromDb) {
    let labels: string[];
    try {
      labels = await load();
    } catch (err) {
      // falha de banco/terminologia (≠ TerminologyUnavailableError, que já virou lista vazia): só nome do catálogo e CLASSE do erro
      throw new AdmissionSummaryError('catalog_read_failed', [marker], err instanceof Error ? err.constructor.name : 'unknown');
    }
    if (!labels.length) throw new AdmissionSummaryError('prompt_catalog_empty', [marker]);
    values[marker] = joinLabels(labels);
  }
  return values;
}

/** Capítulos CID-11 pela terminologia do app: o MESMO rótulo (`título (código)`) que `derivePathologySegments()` grava no PT. */
export const pathologyLabelsFrom = (terminology: TerminologyPort) => async (): Promise<string[]> => {
  try {
    return (await terminology.listChapters()).map((c) => `${c.title} (${c.code})`);
  } catch (err) {
    if (err instanceof TerminologyUnavailableError) return []; // terminologia não carregada = catálogo vazio
    throw err;
  }
};

const defaultCatalogs = (env: NodeJS.ProcessEnv): AdmissionPromptCatalogs => {
  const repo = new TherapeuticCatalogRepository();
  return {
    segmentLabels: async () => (await repo.list('segments')).map((i) => i.label),
    pathologyTypeLabels: pathologyLabelsFrom(createTerminologyPort(env)),
  };
};

/**
 * O PERFIL do gerador (spec 052, T-36a): o que muda de uma instância para a outra. O código é UM só (esta classe); a admissão e o
 * enquadre diferem em quatro pontos, que entram por configuração do construtor, nunca por cópia da classe.
 */
export interface SummaryProfile {
  /** De onde vem o prompt: o Google Doc cujo id está na env `docIdEnv` (admissão), ou um texto fixo versionado no repositório (enquadre). */
  readonly prompt: { kind: 'doc'; docIdEnv: string } | { kind: 'text'; text: string };
  /** Os marcadores `{{NOME}}` do prompt. Sobrou algum sem valor = o resumo não roda (`prompt_unfilled_placeholder`). */
  markers(catalogs: AdmissionPromptCatalogs): Promise<Record<string, string>>;
  /** A mensagem do usuário: cabeçalho de metadados + a transcrição. */
  buildInput(input: AdmissionSummaryInput): string;
  /** O gate de forma do JSON do resumo (esquema desta instância). */
  assertShape(result: AdmissionSummaryResult, input: AdmissionSummaryInput): AdmissionSummaryResult;
}

/** O que a admissão usa HOJE: o Doc de `ADMISSION_SUMMARY_PROMPT_DOC_ID`, os 8 marcadores de catálogo, `entrevista_id`/`fecha` e o esquema de `admissionSummaryShape`. */
export const ADMISSION_SUMMARY_PROFILE: SummaryProfile = {
  prompt: { kind: 'doc', docIdEnv: 'ADMISSION_SUMMARY_PROMPT_DOC_ID' },
  markers: (catalogs) => buildPromptValues(catalogs),
  buildInput: (input) => buildInterviewInput(input, input.transcript),
  assertShape: (result) => assertSummaryShape(result),
};

export interface VertexAdmissionSummaryDeps {
  /** Perfil da instância. Ausente = o da admissão (a instância que já roda em produção). */
  profile?: SummaryProfile;
  timeoutMs?: number;
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
  private catalogsOrNull: AdmissionPromptCatalogs | null;
  private readonly timeoutMs: number;
  private readonly profile: SummaryProfile;
  /** O gate de forma desta instância: o serviço de importação o usa em vez de fixar o da admissão. */
  readonly assertShape: (result: AdmissionSummaryResult, input: AdmissionSummaryInput) => AdmissionSummaryResult;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, deps: VertexAdmissionSummaryDeps = {}) {
    if (env.NODE_ENV === 'test') throw new AdmissionRealAdapterInTestError('new VertexAdmissionSummaryGenerator()');
    this.model = env.ADMISSION_SUMMARY_MODEL ?? env.GEMINI_MODEL ?? 'gemini-2.5-pro';
    this.promptProvider = deps.promptProvider ?? new GoogleDocsPromptProvider();
    this.vertex = deps.vertex ?? generateContentVertex;
    this.catalogsOrNull = deps.catalogs ?? null; // o padrão (banco/terminologia) só é construído se o perfil pedir catálogo
    this.timeoutMs = deps.timeoutMs ?? VERTEX_TIMEOUT_MS;
    this.profile = deps.profile ?? ADMISSION_SUMMARY_PROFILE;
    this.assertShape = this.profile.assertShape;
  }

  private get catalogs(): AdmissionPromptCatalogs {
    this.catalogsOrNull ??= defaultCatalogs(this.env);
    return this.catalogsOrNull;
  }

  /** O prompt, pela fonte do perfil: texto fixo, ou o Doc (sem o id / Doc ilegível NÃO há resumo, nunca um prompt inventado). */
  private async loadPrompt(): Promise<string> {
    const source = this.profile.prompt;
    if (source.kind === 'text') return source.text;
    const docId = this.env[source.docIdEnv]?.trim();
    if (!docId) throw new AdmissionSummaryError('prompt_missing');
    try {
      return await this.promptProvider.getPrompt(docId);
    } catch {
      throw new AdmissionSummaryError('prompt_unavailable'); // a mensagem do Google pode citar o id do Doc: não sobe
    }
  }

  async generate(input: AdmissionSummaryInput): Promise<AdmissionSummaryResult> {
    const prompt = await this.loadPrompt();
    if (!prompt || !prompt.trim()) throw new AdmissionSummaryError('prompt_unavailable');

    // Escapes de Markdown (só aqui) e marcadores. Sobrou QUALQUER `{{NOME}}` -> não roda, só o NOME vai ao erro.
    let values: Record<string, string>;
    try {
      values = await this.profile.markers(this.catalogs);
    } catch (err) {
      if (err instanceof AdmissionSummaryError) throw err;
      throw new AdmissionSummaryError('prompt_unavailable');
    }
    const filled = fillPrompt(normalizeMarkdownEscapes(prompt), values);
    const unfilled = findUnfilled(filled);
    if (unfilled.length) throw new AdmissionSummaryError('prompt_unfilled_placeholder', unfilled);

    let text: string | undefined;
    let truncated = false;
    let blocked = false;
    let response: Response;
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      response = await this.vertex(
        this.model,
        {
          systemInstruction: { parts: [{ text: filled }] },
          contents: [{ role: 'user', parts: [{ text: this.profile.buildInput(input) }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingBudget: THINKING_BUDGET } },
        },
        'AdmissionSummary',
        { redactErrors: true, signal }, // a transcrição é texto clínico: o helper não pode logar corpo nem mensagem de erro
      );
    } catch (err) {
      if (signal.aborted) throw new AdmissionSummaryError('vertex_timeout'); // pedido enviado e sem resposta no prazo: conta
      if (err instanceof VertexAuthError) throw new AdmissionSummaryError('vertex_auth_failed'); // credencial, não conta
      // 429/5xx e falha antes do envio (rede): transitório, não conta. 400/401/403/404 e demais 4xx: configuração, conta.
      const transient = err instanceof GeminiApiError ? err.isTransient : true;
      throw new AdmissionSummaryError(transient ? 'vertex_transient' : 'vertex_failed');
    }
    try {
      const data = (await response.json()) as {
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
        promptFeedback?: { blockReason?: string };
      };
      const finish = data.candidates?.[0]?.finishReason;
      if (data.promptFeedback?.blockReason) blocked = true;
      else if (finish === 'MAX_TOKENS') truncated = true;
      else if (finish && finish !== 'STOP') blocked = true; // SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII, OTHER...
      text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
    } catch {
      if (signal.aborted) throw new AdmissionSummaryError('vertex_timeout');
      throw new AdmissionSummaryError('empty_response'); // corpo ilegível: a chamada foi paga
    }
    // Resposta cortada ou barrada NÃO vira documento: um JSON/resumo pela metade é pior que nenhum.
    if (truncated) throw new AdmissionSummaryError('output_truncated');
    if (blocked) throw new AdmissionSummaryError('blocked_by_model');
    if (!text || !text.trim()) throw new AdmissionSummaryError('empty_response');
    const out = splitGemOutput(text);
    if (!out.readable) throw new AdmissionSummaryError('empty_response');
    return { summary: out.readable, promptVersion: promptVersionOf(prompt), structured: out.json, jsonInvalid: out.jsonInvalid };
  }
}
