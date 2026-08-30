/**
 * StageTemplateEligibility — quais templates da Twilio podem sair "por etapa"
 * (DEC-12) e como as variáveis deles são preenchidas.
 *
 * Um template aprovado na Meta rejeita variável vazia ("Content Variables
 * parameter is invalid"). Então só é ELEGÍVEL o template que:
 *   1. tem categoria UTILITY (transacional; MARKETING sai da base pré-contratual
 *      do art. 5º.2.d e exigiria consentimento próprio — lex 29/08 C5);
 *   2. NÃO é lembrete/cobrança de cadastro (deny-list — ligar cobrança a um
 *      estado que o staff altera à mão recria o incidente de 10/07: o mesmo
 *      template 7× à mesma pessoa — lex C6);
 *   3. só tem placeholders que o sistema preenche sozinho no momento em que a
 *      tarjeta é movida (allowlist FECHADA — lex C4):
 *        `{{worker_name}}` / `{{name}}` → token PII do nome (nunca o valor);
 *        `{{case_number}}`             → nº do caso da vaga;
 *      Placeholders posicionais (`{{1}}`…) não são elegíveis: cada template dá
 *      um significado diferente à posição, e o objetivo de cada mensagem por
 *      etapa ainda é do Javier (PEND-21). Nada de `rejection_reason`, nada de
 *      campo de paciente.
 */

export const SUPPORTED_PLACEHOLDERS: ReadonlySet<string> = new Set(['worker_name', 'name', 'case_number']);

/** Categoria aceita (vem da aprovação Meta via sync da Twilio). */
export const ALLOWED_TEMPLATE_CATEGORY = 'UTILITY';

/** Lembrete/cobrança de cadastro ou de entrevista: NUNCA por etapa (lex C6). Prefixos. */
export const DENIED_SLUG_PREFIXES: readonly string[] = [
  'talentum_incomplete_reminder',
  'ar_signup_pending_reminder',
  'complete_register_',
  'admission_reminder_',
  'qualified_reminder_',
];

export type IneligibilityReason = 'INACTIVE' | 'CATEGORY' | 'DENY_LIST' | 'PLACEHOLDERS' | 'OPT_OUT_CLAUSE';

/**
 * O que muda entre um uso e outro da mesma triagem (mensagem por etapa × convite à
 * reunión de presentación — REQ-09). O que NÃO muda: categoria UTILITY e a allowlist fechada.
 */
export interface EligibilityPolicy {
  /** Placeholders que o sistema preenche sozinho neste uso. */
  supportedPlaceholders: ReadonlySet<string>;
  /** Prefixos de slug negados (lex C6). Vazio = não aplica. */
  deniedSlugPrefixes: readonly string[];
  /** Cláusula de saída obrigatória no corpo (lex C3, Decreto 1558/2001 art. 27). null = não exige. */
  optOutClauseRe: RegExp | null;
  /**
   * false → INACTIVE é a PRIMEIRA razão (etapa: inativo não se configura).
   * true  → INACTIVE é a ÚLTIMA (REQ-09: template inativo pode ser escolhido como placeholder
   *          até a Meta aprovar; só o envio espera) — e as outras razões aparecem antes dele.
   */
  inactiveLast: boolean;
}

/** Política das mensagens por etapa (DEC-12) — a de sempre. */
export const STAGE_MESSAGE_POLICY: EligibilityPolicy = {
  supportedPlaceholders: SUPPORTED_PLACEHOLDERS,
  deniedSlugPrefixes: DENIED_SLUG_PREFIXES,
  optOutClauseRe: null,
  inactiveLast: false,
};

export interface TemplateLike {
  slug: string;
  body: string | null | undefined;
  category?: string | null;
  is_active?: boolean | null;
}

/**
 * Placeholders `{{x}}` do corpo, sem duplicatas, na ordem em que aparecem.
 * Fonte ÚNICA do parser — o TwilioMessagingService (posicional `{{1}}`…) usa
 * este mesmo; `{{ x }}` com espaço é tolerado (superconjunto do `\w+` antigo,
 * provado no teste do Twilio).
 */
export function extractPlaceholders(body: string | null | undefined): string[] {
  if (!body) return [];
  const out: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function isDeniedSlug(slug: string, prefixes: readonly string[] = DENIED_SLUG_PREFIXES): boolean {
  return prefixes.some((p) => slug.startsWith(p));
}

export interface EligibilityResult {
  eligible: boolean;
  reason: IneligibilityReason | null;
  placeholders: string[];
  /** Placeholders que o sistema NÃO sabe preencher (vazio quando elegível). */
  unsupported: string[];
}

export function evaluateTemplateEligibility(t: TemplateLike, policy: EligibilityPolicy = STAGE_MESSAGE_POLICY): EligibilityResult {
  const placeholders = extractPlaceholders(t.body);
  const unsupported = placeholders.filter((p) => !policy.supportedPlaceholders.has(p));
  const inactive: IneligibilityReason | null = t.is_active === false ? 'INACTIVE' : null;
  let reason: IneligibilityReason | null = null;
  if (!policy.inactiveLast && inactive) reason = inactive;
  else if ((t.category ?? '').toUpperCase() !== ALLOWED_TEMPLATE_CATEGORY) reason = 'CATEGORY';
  else if (isDeniedSlug(t.slug, policy.deniedSlugPrefixes)) reason = 'DENY_LIST';
  else if (unsupported.length > 0) reason = 'PLACEHOLDERS';
  else if (policy.optOutClauseRe && !policy.optOutClauseRe.test(t.body ?? '')) reason = 'OPT_OUT_CLAUSE';
  else if (policy.inactiveLast && inactive) reason = inactive;
  return { eligible: reason === null, reason, placeholders, unsupported };
}

export interface StageVariableContext {
  /** Token PII do nome (TokenService.generate(workerId, 'worker_name')). */
  workerNameToken: string | null;
  caseNumber: number | string | null;
}

/** Monta as variáveis do outbox SÓ para os placeholders da allowlist. */
export function buildStageVariables(placeholders: string[], ctx: StageVariableContext): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const p of placeholders) {
    if (!SUPPORTED_PLACEHOLDERS.has(p)) continue;
    if ((p === 'worker_name' || p === 'name') && ctx.workerNameToken) vars[p] = ctx.workerNameToken;
    if (p === 'case_number') vars[p] = String(ctx.caseNumber ?? '—');
  }
  return vars;
}
