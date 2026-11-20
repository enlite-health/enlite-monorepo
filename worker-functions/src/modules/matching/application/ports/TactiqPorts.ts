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

/**
 * Por que o Tactiq recusou (tipado, sem texto livre). `access_action.action` já vem SANITIZADO (`sanitizeAccessAction`).
 * `unspecified` = quem lança não disse (importação, leitor, dublês): continua compilando com `new TactiqUnauthorizedError()`.
 */
export type DenyCause =
  | { kind: 'token_endpoint' }
  | { kind: 'mcp_transport' }
  | { kind: 'access_action'; action: string }
  | { kind: 'scope_without_details' }
  | { kind: 'unspecified' };

/** A ÚNICA função que vira `reason` de evento/log. Nunca recebe token, e-mail nem corpo: só a causa tipada. */
export function denyReason(cause: DenyCause): string {
  switch (cause.kind) {
    case 'token_endpoint':
      return 'token_endpoint_401_403';
    case 'mcp_transport':
      return 'mcp_transport_401_403';
    case 'access_action':
      return `access_action:${sanitizeAccessAction(cause.action)}`;
    case 'scope_without_details':
      return 'scope_without_details';
    default:
      return 'unspecified';
  }
}

const ACTION_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** `access.action` do Tactiq: só passa se casa o enum esperado; senão `unrecognized_value` (F13: o enum não é fechado nem confiável). */
export function sanitizeAccessAction(raw: unknown): string {
  return typeof raw === 'string' && ACTION_RE.test(raw) ? raw : 'unrecognized_value';
}

const TITLE_DISALLOWED = /[^\p{L}\p{N} .,'’:!?¿¡-]/gu;
/** `title` do Tactiq (texto livre): ≤ 80 caracteres, só letras/números/espaço e `.,'’:!?¿¡-`; o resto é descartado. Vazio → `null`. */
export function sanitizeAccessTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(TITLE_DISALLOWED, '').replace(/ {2,}/g, ' ').trim().slice(0, 80).trim();
  return clean || null;
}

const SCOPE_TOKEN_RE = /^[a-z:_]+$/;
/** `scope` do token (separado por espaço) → lista de tokens `^[a-z:_]+$`, no máximo 8. Ausente/não-string → `null` ("não apurado"). */
export function sanitizeScopeList(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  return raw.split(/\s+/).filter((t) => SCOPE_TOKEN_RE.test(t)).slice(0, 8);
}

/** O Tactiq recusou o token (401/403) ou o acesso: o vínculo caiu. A causa é opcional (default `unspecified`). */
export class TactiqUnauthorizedError extends Error {
  readonly code = 'TACTIQ_UNAUTHORIZED';
  constructor(readonly cause: DenyCause = { kind: 'unspecified' }) {
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
  /** Escopos concedidos, como o Tactiq devolveu (string separada por espaço). Ausente = "não apurado": nunca presumir `details`. */
  scope?: string;
}

/** Veredito do `get_access_options` (dono único: `pingVerdict`). `unrecognized` = sem `action` string. `title` já sanitizado. */
export type AccessVerdict =
  | { kind: 'ready' }
  | { kind: 'denied'; action: string; title: string | null }
  | { kind: 'unrecognized' };

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
  /** Chamada barata do teste diário e do vínculo: DEVOLVE o veredito do acesso. Só lança 401/403 do transporte (`TactiqUnauthorizedError`, causa `mcp_transport`) e transitório (`TactiqTransientError`). */
  ping(accessToken: string): Promise<AccessVerdict>;
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

/** `no_link`: sem vínculo vivo. `broken`: o Tactiq recusou o token agora (o vínculo caiu). `transient`: rede/KMS — tenta depois. */
export type TactiqAccessFailure = 'no_link' | 'broken' | 'transient';

/**
 * Resultado de `withHostAccess`. `busy`: outra leitura do MESMO responsável está em curso (R-53): nada foi lido, nada mudou de
 * estado, nenhuma tentativa conta; tenta na rodada seguinte.
 */
export type HostAccessResult<T> = { ok: true; value: T } | { ok: false; reason: TactiqAccessFailure | 'busy' };

/**
 * O que a importação precisa do vínculo: a ÚNICA porta para um token do RESPONSÁVEL (a troca com rotação e todo o uso do token
 * acontecem dentro de `withHostAccess`, uma leitura por vez por responsável) e os dois rebaixamentos de estado.
 */
export interface TactiqTokenProvider {
  withHostAccess<T>(email: string, fn: (accessToken: string) => Promise<T>): Promise<HostAccessResult<T>>;
  markBroken(email: string): Promise<boolean>;
  markWrongAccount(email: string): Promise<boolean>;
  /** O responsável tem ao menos uma reunião importada com sucesso (`done`), de QUALQUER fonte (admissão ou enquadre), desde que o vínculo foi criado? */
  hasImportedSinceLinked(email: string): Promise<boolean>;
  /** O PRIMEIRO vínculo da conta (`tactiq_links.created_at`, que o revínculo não muda) é POSTERIOR a `at`? Reunião que terminou antes dele não prova conta errada. */
  linkCreatedAfter(email: string, at: Date): Promise<boolean>;
  /** O responsável tem vínculo `linked` cuja última mudança de estado é MAIS NOVA que `since` (o bloqueio)? É a "causa mudou" da spec 083 (DF-1). */
  hasLinkedSince(email: string, since: Date): Promise<boolean>;
}
