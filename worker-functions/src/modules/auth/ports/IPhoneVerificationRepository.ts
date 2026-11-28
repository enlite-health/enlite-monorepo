/**
 * Port do repositório do "celular verificado" (emenda 077). "Verificado" é DERIVADO no banco (`fn_worker_phone_is_verified`): este
 * port lê o estado pela função e grava a PROVA (as 4 colunas `phone_verified_*`); ninguém decide "verificado" por conta própria.
 */
export type PhoneVerificationState = 'no_phone' | 'verified' | 'unverified';

export type PhoneVerificationMethod = 'otp_whatsapp_template' | 'otp_verify_whatsapp';

/** Qualquer coisa que rode SQL: o pool ou o client de uma transação aberta por quem chama. */
export interface SqlRunner {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export interface PhoneVerificationReadModel {
  state: PhoneVerificationState;
  phone: string | null;
  /** Só em `verified`. */
  verifiedAt: Date | null;
}

export interface MarkPhoneVerifiedInput {
  workerId: string;
  /** Troca/grava o telefone da ficha no MESMO UPDATE da prova (só a rota `confirm` faz isso). Sem ele, prova o telefone já gravado. */
  phoneNormalized?: string;
  /** Desafio que provou a posse; NULL só no plano B (o código mora na Twilio). */
  challengeId: string | null;
  method: PhoneVerificationMethod;
}

export interface IPhoneVerificationRepository {
  /** Lê o estado pela função derivada; `null` se a ficha não existe. */
  readState(workerId: string): Promise<PhoneVerificationReadModel | null>;
  /**
   * Grava a prova (e, se vier, o telefone) num UPDATE só, no `db` recebido (a transação de quem chama).
   * `'PHONE_IN_USE'`: o número já pertence a outra conta (violação dos índices únicos de telefone); qualquer outro erro sobe.
   */
  markPhoneVerified(db: SqlRunner, input: MarkPhoneVerifiedInput): Promise<'ok' | 'PHONE_IN_USE'>;
  /** O `challengeId` existe como desafio próprio (`otp_challenges`)? Decide o método gravado (plano B não tem linha). */
  methodFor(challengeId: string): Promise<{ method: PhoneVerificationMethod; challengeId: string | null }>;
  /**
   * Telefone (E.164) gravado NO desafio de finalidade `claim` (`otp_challenges.phone_e164`), ou `null` se o id não é de um desafio
   * próprio de claim (plano B: o id é um `VE...` sem linha). D797: com ele o `confirm` dispensa o número vindo do cliente.
   */
  claimChallengePhone(challengeId: string): Promise<string | null>;
  /**
   * A prova que o vínculo de contas acabou de estabelecer para a ficha ABSORVIDA (lida ANTES do merge, que reparenta os
   * desafios): o número normalizado dela e o desafio de finalidade `link` consumido. Sem desafio próprio (plano B), sem id.
   */
  linkProof(absorbedId: string): Promise<{ phoneNormalized: string; method: PhoneVerificationMethod; challengeId: string | null } | null>;
}
