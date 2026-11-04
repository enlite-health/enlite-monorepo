/** Luz (prueba) in the app (spec 086) — types of `POST /api/admin/luz-prueba/turn` (contract §9.2). */

export type LuzPruebaRole = "user" | "assistant";

export interface LuzPruebaHistoryTurn {
  role: LuzPruebaRole;
  content: string;
}

export interface LuzPruebaTurnRequest {
  /** `[A-Za-z0-9_-]{1,40}`. */
  sessao: string;
  /** 1..1000 chars. */
  mensagem: string;
  /** At most 10 turns, without the current message. */
  historico: LuzPruebaHistoryTurn[];
}

export interface LuzPruebaTool {
  nome: string;
  ok: boolean;
  /** true = write tool answered as a dry run ("ok simulado"). */
  prueba: boolean;
}

export type LuzPruebaTurnKind = "reply" | "handover_simulado" | "skip";

export interface LuzPruebaTurnResponse {
  tipo: LuzPruebaTurnKind;
  texto?: string;
  motivo?: string;
  ferramentas: LuzPruebaTool[];
  validadores: string[];
  prestadora: { nome: string };
}

export type LuzPruebaErrorCode =
  | "REQUISICAO_INVALIDA"
  | "TETO_DIARIO"
  | "TRIAGE_INDISPONIVEL"
  | "CONTADOR_FALHOU"
  | "NO_ACCESS"
  | "UNAUTHENTICATED"
  | "UNKNOWN";

export class LuzPruebaError extends Error {
  constructor(
    public readonly codigo: LuzPruebaErrorCode,
    public readonly status: number,
    public readonly limite?: number,
  ) {
    super(codigo);
    this.name = "LuzPruebaError";
  }
}

/** A message on the tab's screen. Only `user` and `reply` ones go back to the server as history. */
export interface LuzPruebaMessage {
  id: string;
  role: LuzPruebaRole;
  /** Reply text (role `assistant`) or what the person typed. */
  content: string;
  kind: LuzPruebaTurnKind;
  motivo?: string;
  ferramentas: LuzPruebaTool[];
  validadores: string[];
}
