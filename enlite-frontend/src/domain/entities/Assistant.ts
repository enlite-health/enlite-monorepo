/** Asistentes no app (spec 080, fase A) — tipos do contrato `rota-mensagens.md`. */
export interface Assistente {
  slug: string;
  nome: string;
  papel: string;
  area: string;
  /** false = sem runtime na fase A (o seletor mostra "en breve"). */
  disponivel: boolean;
  nao_lidas: number;
}

export type AssistenteAutor = "pessoa" | "agente";
export type AssistenteValidador =
  "ok" | "cortado_clinico" | "cortado_pessoal" | null;

export interface AssistenteMensagem {
  id: string;
  autor: AssistenteAutor;
  texto: string;
  ferramentas: string[];
  validador: AssistenteValidador;
  criado_em: string;
}

export interface AssistenteMensagensPagina {
  conversa_id: string | null;
  mensagens: AssistenteMensagem[];
}

export interface AssistenteTurno {
  tokens_in: number;
  tokens_out: number;
  custo_usd: number;
}

export interface AssistenteRespostaEnvio {
  conversa_id: string;
  mensagem: AssistenteMensagem;
  turno: AssistenteTurno;
}

export type AssistenteErroCodigo =
  | "SEM_CELULA"
  | "AGENTE_DESCONHECIDO"
  | "AGENTE_INDISPONIVEL"
  | "FORMATO_INVALIDO"
  | "TETO_PESSOA_DIA"
  | "TETO_AGENTE_MES"
  | "ERRO_MODELO"
  | "DESCONHECIDO";

export class AssistenteErro extends Error {
  readonly code: AssistenteErroCodigo;
  readonly status: number;

  constructor(code: AssistenteErroCodigo, status: number, message?: string) {
    super(message ?? code);
    this.name = "AssistenteErro";
    this.code = code;
    this.status = status;
  }
}
