/**
 * Spec 086 (Luz em prueba) — contrato da plataforma com o triage-service. A pessoa logada conversa com a Luz REAL no papel da
 * prestadora sintética; o triage devolve a resposta e NADA sai por canal real. Sem texto de conversa em log nem em banco.
 */
export interface PruebaMensagem {
  role: 'user' | 'assistant';
  content: string;
}

/** Corpo enviado ao triage: o mesmo da rota da plataforma MAIS o `uid` (quem testa). */
export interface PruebaTurnoEntrada {
  uid: string;
  sessao: string;
  mensagem: string;
  historico: PruebaMensagem[];
  /** Nº do turno da pessoa NO DIA (o contador por uid): sufixo `#turno-<N>` do gatilho de auditoria. */
  turno: number;
}

export interface PruebaFerramenta {
  nome: string;
  ok: boolean;
  prueba: boolean;
}

/** Resposta do triage, devolvida como está à tela (contrato §9.2 da spec 086). */
export interface PruebaTurnoSaida {
  tipo: 'reply' | 'handover_simulado' | 'skip';
  texto?: string;
  motivo?: string;
  ferramentas: PruebaFerramenta[];
  validadores: string[];
  prestadora: { nome: string };
}

export interface TriagePruebaPort {
  /** @throws TriageIndisponivel rede, timeout, 5xx, 401/403 do triage ou resposta fora do formato. */
  turno(entrada: PruebaTurnoEntrada): Promise<PruebaTurnoSaida>;
}

/** O triage não respondeu como devia. `causa` é só um código curto (nunca corpo de resposta, que carrega texto de conversa). */
export class TriageIndisponivel extends Error {
  constructor(readonly causa: string) {
    super(`triage indisponivel: ${causa}`);
    this.name = 'TriageIndisponivel';
  }
}

/** Contador de turnos da pessoa por dia (teto de custo da 080 §6.9). */
export interface TurnosPruebaPort {
  /** Consome 1 turno do dia da pessoa de forma atômica; `permitido=false` quando o teto já foi atingido (nada é consumido). */
  consumir(uid: string, limite: number): Promise<{ permitido: boolean; turnos: number }>;
  /** Devolve 1 turno (o triage não respondeu): a falha da plataforma não gasta a cota da pessoa. */
  devolver(uid: string): Promise<void>;
}
