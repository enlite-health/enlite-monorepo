/**
 * UnavailableTerminology — Null Object (spec 016, "Contrato de arquitetura", US-4: "se o
 * container/catálogo cair, a busca falha VISÍVEL, nunca cai em texto livre silencioso").
 *
 * Inverte o uso costumeiro de Null Object (devolver um valor neutro "para não quebrar a tela").
 * Aqui o valor neutro SERIA o bug: `search()` devolvendo `[]` quando o catálogo está fora do ar
 * é indistinguível de "não achei nada", e o CLAUDE.md do projeto proíbe essa ambiguidade
 * ("contagem zero é falha, nunca sucesso"). Por isso todo método REJEITA com um erro tipado e
 * com mensagem em espanhol apta para tela — quem chama decide o que fazer (mostrar erro, log),
 * mas nunca finge sucesso.
 */
import type {
  TerminologyPort,
  DiagnosisCandidate,
  DiagnosisEntity,
  Chapter,
  Block,
  SearchOptions,
} from './TerminologyPort';

export class TerminologyUnavailableError extends Error {
  constructor(reason?: string) {
    super(
      reason
        ? `El catálogo de diagnósticos no está disponible en este momento. Intente nuevamente en unos minutos. (${reason})`
        : 'El catálogo de diagnósticos no está disponible en este momento. Intente nuevamente en unos minutos.',
    );
    this.name = 'TerminologyUnavailableError';
  }
}

export class UnavailableTerminology implements TerminologyPort {
  constructor(private readonly reason?: string) {}

  async search(_query: string, _opts?: SearchOptions): Promise<DiagnosisCandidate[]> {
    throw new TerminologyUnavailableError(this.reason);
  }

  async getByUri(_uri: string): Promise<DiagnosisEntity | null> {
    throw new TerminologyUnavailableError(this.reason);
  }

  async ancestorsOf(_uri: string): Promise<{ chapter: Chapter; block?: Block }> {
    throw new TerminologyUnavailableError(this.reason);
  }
}
