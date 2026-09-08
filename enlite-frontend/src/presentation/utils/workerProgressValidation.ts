import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import { destinationFor, KNOWN_TOKENS, type TabId } from '@presentation/utils/incompleteFieldDestinations';

/**
 * Completude do cadastro do prestador — DERIVADA do backend, nunca recalculada.
 *
 * ─── Por que este arquivo foi reescrito (incidente 08/09/2026) ───────────────
 * Este módulo mantinha a PRÓPRIA lista de campos obrigatórios. Ela omitia dois
 * que o portão de REGISTERED exige: `phone` e `title_certificate`. Resultado:
 * `isStep1Complete` devolvia `true` para quem o backend recusava, a home exibia
 * o cadastro como concluído e a postulação era barrada com "registro
 * incompleto". Medido em produção: 23 prestadoras nesse estado exato — 21 delas
 * por `title_certificate`, campo que esta lista nunca conferiu.
 *
 * A causa não foi a lista estar errada: foi EXISTIR uma lista aqui. Havia sete
 * definições concorrentes de "cadastro completo" no sistema. Agora o backend
 * devolve `missingFields` (de `fn_worker_missing_fields`, o SSOT no banco, a
 * MESMA função que decide a postulação) e este módulo só o traduz em etapas.
 *
 * ─── Regra de ouro ao mexer aqui ────────────────────────────────────────────
 * Se você sentir vontade de escrever `data.algumCampo &&` neste arquivo, PARE:
 * é a oitava cópia nascendo. Campo novo obrigatório muda a função PL/pgSQL; o
 * mapa token→aba (`incompleteFieldDestinations`) já cuida do resto, e o teste
 * de contrato acusa se um token do backend não tiver destino aqui.
 */

/**
 * Traduz `missingFields` do backend em "que abas ainda têm pendência".
 *
 * Token desconhecido cai em 'general' (`destinationFor` tem fallback), o que é
 * FAIL-CLOSED de propósito: um campo novo no portão que ninguém mapeou trava a
 * etapa em vez de liberá-la em silêncio.
 */
function pendingTabs(missingFields: string[]): Set<TabId> {
  return new Set(missingFields.map((token) => destinationFor(token).tab));
}

/**
 * `true` só quando o backend informou a completude nesta resposta.
 *
 * `missingFields` ausente/`null` é "não consegui apurar" — NÃO é "está tudo
 * certo". Confundir as duas coisas é exatamente a causa raiz que este conserto
 * ataca, então a distinção fica explícita e disponível para quem renderiza.
 */
export function isCompletenessKnown(data: WorkerProgressResponse): boolean {
  return Array.isArray(data.missingFields);
}

/**
 * Uma etapa está completa quando o backend NÃO reportou nenhuma pendência na
 * aba correspondente.
 *
 * Sem `missingFields`, devolve `false` (fail-closed): melhor mandar a pessoa
 * conferir um cadastro que já está pronto do que dizer "completo" e ela levar
 * um "registro incompleto" na cara ao tentar se postular.
 */
function isTabComplete(data: WorkerProgressResponse, tab: TabId): boolean {
  if (!isCompletenessKnown(data)) return false;
  return !pendingTabs(data.missingFields as string[]).has(tab);
}

/** Etapa 1 — Informações Gerais. */
export function isStep1Complete(data: WorkerProgressResponse): boolean {
  return isTabComplete(data, 'general');
}

/** Etapa 2 — Endereço de Atendimento. */
export function isStep2Complete(data: WorkerProgressResponse): boolean {
  return isTabComplete(data, 'address');
}

/** Etapa 3 — Disponibilidade. */
export function isStep3Complete(data: WorkerProgressResponse): boolean {
  return isTabComplete(data, 'availability');
}

/**
 * Representa o progresso parcial de uma etapa com base nos campos preenchidos.
 */
export interface StepProgress {
  completedFields: number;
  totalFields: number;
  percentage: number;
}

/**
 * Quantos campos do portão pertencem a cada aba.
 *
 * Derivado do MESMO mapa que traduz token→aba, então acrescentar um campo ao
 * portão e mapeá-lo já corrige o denominador — sem uma segunda lista para
 * esquecer de atualizar.
 */
const TOKENS_BY_TAB: Record<TabId, string[]> = (() => {
  const acc: Record<TabId, string[]> = { general: [], address: [], availability: [], documents: [] };
  for (const token of KNOWN_TOKENS) acc[destinationFor(token).tab].push(token);
  return acc;
})();

function tabProgress(data: WorkerProgressResponse, tab: TabId): StepProgress {
  const totalFields = TOKENS_BY_TAB[tab].length;

  // Sem informação do backend não há progresso apurável. 0% é a leitura honesta:
  // "não sei", e não "você não preencheu nada".
  if (!isCompletenessKnown(data)) {
    return { completedFields: 0, totalFields, percentage: 0 };
  }

  const missingInTab = (data.missingFields as string[]).filter(
    (token) => destinationFor(token).tab === tab,
  ).length;
  const completedFields = Math.max(0, totalFields - missingInTab);

  return {
    completedFields,
    totalFields,
    percentage: totalFields === 0 ? 100 : Math.round((completedFields / totalFields) * 100),
  };
}

/** Progresso granular da etapa 1 (Informações Gerais). */
export function getStep1Progress(data: WorkerProgressResponse): StepProgress {
  return tabProgress(data, 'general');
}

/** Progresso granular da etapa 2 (Endereço de Atendimento). */
export function getStep2Progress(data: WorkerProgressResponse): StepProgress {
  return tabProgress(data, 'address');
}

/** Progresso granular da etapa 3 (Disponibilidade). */
export function getStep3Progress(data: WorkerProgressResponse): StepProgress {
  return tabProgress(data, 'availability');
}

/** Valida todas as etapas do cadastro básico. */
export function validateRegistrationSteps(data: WorkerProgressResponse): {
  step1: boolean;
  step2: boolean;
  step3: boolean;
} {
  return {
    step1: isStep1Complete(data),
    step2: isStep2Complete(data),
    step3: isStep3Complete(data),
  };
}
