/**
 * Portas do Tactiq (spec 049, F4): OAuth e MCP. Tudo que fala com o Tactiq passa por aqui; em teste entra dublê e o
 * adapter real LANÇA se for instanciado com NODE_ENV=test (ver `admissionExternals.ts`).
 *
 * Regra transversal: NENHUM erro desta camada carrega token, código de autorização, verifier nem corpo de resposta
 * do Tactiq — só um `reason` fechado. Quem captura loga o `reason`, nunca a mensagem de terceiros.
 */

/** O adapter real foi pedido com NODE_ENV=test: teste nunca toca o Tactiq. */
export class TactiqRealClientInTestError extends Error {
  readonly code = 'TACTIQ_REAL_CLIENT_IN_TEST';
  constructor(what: string) {
    super(`${what}: o cliente REAL do Tactiq não pode ser instanciado com NODE_ENV=test`);
    this.name = 'TactiqRealClientInTestError';
  }
}

/** Faltou env (client id, URL do MCP, redirect). Lançado na CHAMADA, não no boot. */
export class TactiqNotConfiguredError extends Error {
  readonly code = 'TACTIQ_NOT_CONFIGURED';
  constructor(missing: string) {
    super(`Tactiq não configurado: falta ${missing}`);
    this.name = 'TactiqNotConfiguredError';
  }
}

/** O refresh token não vale mais (`invalid_grant`): o vínculo caiu e só o operador conserta (vincular de novo). */
export class TactiqInvalidGrantError extends Error {
  readonly code = 'TACTIQ_INVALID_GRANT';
  constructor() {
    super('tactiq_invalid_grant');
    this.name = 'TactiqInvalidGrantError';
  }
}

/** O Tactiq recusou o token (401/403): o vínculo caiu. */
export class TactiqUnauthorizedError extends Error {
  readonly code = 'TACTIQ_UNAUTHORIZED';
  constructor() {
    super('tactiq_unauthorized');
    this.name = 'TactiqUnauthorizedError';
  }
}

/** Falha que NÃO prova vínculo quebrado (rede, 5xx, timeout): o teste diário registra e tenta de novo amanhã. */
export class TactiqTransientError extends Error {
  readonly code = 'TACTIQ_TRANSIENT';
  constructor(readonly reason: string) {
    super(`tactiq_transient:${reason}`);
    this.name = 'TactiqTransientError';
  }
}

export interface TactiqTokenSet {
  accessToken: string;
  /** Presente quando o Tactiq ROTACIONA o refresh token: o novo SEMPRE substitui o antigo. */
  refreshToken?: string;
}

export interface TactiqOAuthPort {
  /** URL de autorização (PKCE S256, cliente público). O `state` e o desafio vêm de quem chama. */
  buildAuthorizeUrl(input: { state: string; codeChallenge: string }): Promise<string>;
  /** Troca o código pelo par de tokens. Sem `refreshToken` na resposta o vínculo não existe — lança. */
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<TactiqTokenSet & { refreshToken: string }>;
  /** `invalid_grant` → `TactiqInvalidGrantError`; rede/5xx → `TactiqTransientError`. */
  refresh(refreshToken: string): Promise<TactiqTokenSet>;
}

export interface TactiqMeetingItem {
  id: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
}

export interface TactiqTranscriptPage {
  page: number;
  totalPages: number;
  totalChars: number;
  hasMore: boolean;
  entries: Array<{ text: string; speaker: string; startSeconds: number; endSeconds: number }>;
}

/** Cliente do MCP do Tactiq. Nunca loga conteúdo. Respeita 10 reuniões/h/usuário (spec §3.3) — quem chama conta. */
export interface TactiqMcpPort {
  /** Chamada barata do teste diário. 401/403 → `TactiqUnauthorizedError`; rede/5xx → `TactiqTransientError`. */
  ping(accessToken: string): Promise<void>;
  searchMeetings(accessToken: string, input: { query: string; dateFrom: string; dateTo: string }): Promise<TactiqMeetingItem[]>;
  getTranscriptPage(accessToken: string, meetingId: string, page: number): Promise<TactiqTranscriptPage>;
}

export type TactiqLinkState = 'missing' | 'linked' | 'broken' | 'wrong_account' | 'revoked';

/** Quem agenda pergunta aqui se o responsável tem o vínculo vivo (a trava do servidor). */
export interface TactiqLinkGate {
  statesFor(emails: string[]): Promise<Map<string, TactiqLinkState>>;
}

/** O responsável escolhido não tem Tactiq vinculado: 409 `TACTIQ_LINK_REQUIRED` (servidor, não só tela). */
export class TactiqLinkRequiredError extends Error {
  readonly code = 'TACTIQ_LINK_REQUIRED';
  constructor(readonly reason: TactiqLinkState) {
    super('Host has no live Tactiq link');
    this.name = 'TactiqLinkRequiredError';
  }
}

export type TactiqAccessResult =
  | { ok: true; accessToken: string }
  /** `no_link`: sem vínculo vivo. `broken`: o Tactiq recusou o token agora (o vínculo caiu). `transient`: rede/KMS — tenta depois. */
  | { ok: false; reason: 'no_link' | 'broken' | 'transient' };

/** O que a importação (F6) precisa do vínculo: um token de acesso do RESPONSÁVEL e os dois rebaixamentos de estado. */
export interface TactiqTokenProvider {
  accessTokenFor(email: string): Promise<TactiqAccessResult>;
  markBroken(email: string): Promise<boolean>;
  markWrongAccount(email: string): Promise<boolean>;
}
