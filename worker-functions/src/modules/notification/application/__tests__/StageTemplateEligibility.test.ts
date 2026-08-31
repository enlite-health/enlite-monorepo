import {
  buildStageVariables,
  evaluateTemplateEligibility,
  extractPlaceholders,
  isDeniedSlug,
  DENIED_SLUG_PREFIXES,
  STAGE_MESSAGE_POLICY,
  type EligibilityPolicy, twilioSlotCount } from '../StageTemplateEligibility';

describe('extractPlaceholders', () => {
  it('lista os placeholders {{x}} sem duplicatas, na ordem; corpo vazio → []', () => {
    expect(extractPlaceholders('Hola {{worker_name}}, caso {{case_number}} — {{ worker_name }}')).toEqual(['worker_name', 'case_number']);
    expect(extractPlaceholders('Hola {{1}} y {{2}}')).toEqual(['1', '2']);
    expect(extractPlaceholders('')).toEqual([]);
    expect(extractPlaceholders(null)).toEqual([]);
    expect(extractPlaceholders(undefined)).toEqual([]);
  });
});

describe('isDeniedSlug (lex C6 — lembrete/cobrança nunca por etapa)', () => {
  it.each([
    'talentum_incomplete_reminder', 'talentum_incomplete_reminder_v2', 'ar_signup_pending_reminder', 'ar_signup_pending_reminder_v2',
    'complete_register_utility', 'complete_register_ofc', 'admission_reminder_es', 'qualified_reminder_confirm',
  ])('%s é negado', (slug) => expect(isDeniedSlug(slug)).toBe(true));
  it('outros passam', () => {
    expect(isDeniedSlug('qualified_reprogram_confirm')).toBe(false);
    expect(isDeniedSlug('qualified_worker')).toBe(false);
    expect(DENIED_SLUG_PREFIXES.length).toBeGreaterThanOrEqual(5);
  });
});

describe('evaluateTemplateEligibility', () => {
  const ok = { slug: 'qualified_reprogram_confirm', body: 'Caso {{case_number}} registrado', category: 'UTILITY', is_active: true };
  it('UTILITY + ativo + fora da deny-list + placeholders da allowlist → elegível', () => {
    expect(evaluateTemplateEligibility(ok)).toEqual({ eligible: true, reason: null, placeholders: ['case_number'], unsupported: [] });
    expect(evaluateTemplateEligibility({ ...ok, body: 'Hola {{worker_name}} y {{name}}' }).eligible).toBe(true);
    expect(evaluateTemplateEligibility({ ...ok, body: 'Sin variables' }).eligible).toBe(true);
    expect(evaluateTemplateEligibility({ ...ok, category: 'utility' }).eligible).toBe(true);
  });
  it('inativo → INACTIVE (antes de qualquer outra razão)', () => {
    expect(evaluateTemplateEligibility({ ...ok, is_active: false, category: 'MARKETING' }).reason).toBe('INACTIVE');
  });
  it('MARKETING ou sem categoria → CATEGORY (lex C5)', () => {
    expect(evaluateTemplateEligibility({ ...ok, category: 'MARKETING' }).reason).toBe('CATEGORY');
    expect(evaluateTemplateEligibility({ ...ok, category: null }).reason).toBe('CATEGORY');
    expect(evaluateTemplateEligibility({ ...ok, category: undefined }).reason).toBe('CATEGORY');
  });
  it('deny-list → DENY_LIST (lex C6)', () => {
    expect(evaluateTemplateEligibility({ ...ok, slug: 'complete_register_utility_v2', body: 'x' }).reason).toBe('DENY_LIST');
  });
  it('placeholder fora da allowlist (posicional, rejection_reason, campo de paciente) → PLACEHOLDERS (lex C4)', () => {
    for (const body of ['Hola {{1}}', '{{rejection_reason}}', '{{patient_zone}}', '{{diagnosis}}']) {
      const r = evaluateTemplateEligibility({ ...ok, body });
      expect(r.reason).toBe('PLACEHOLDERS');
      expect(r.unsupported.length).toBe(1);
    }
  });
});

describe('buildStageVariables (allowlist fechada)', () => {
  it('preenche só worker_name/name (token) e case_number; ignora o resto; sem token não põe nome', () => {
    expect(buildStageVariables(['worker_name', 'case_number', 'rejection_reason', '1'], { workerNameToken: 'tk_1', caseNumber: 42 }))
      .toEqual({ worker_name: 'tk_1', case_number: '42' });
    expect(buildStageVariables(['name'], { workerNameToken: 'tk_2', caseNumber: null })).toEqual({ name: 'tk_2' });
    expect(buildStageVariables(['worker_name', 'case_number'], { workerNameToken: null, caseNumber: null })).toEqual({ case_number: '—' });
    expect(buildStageVariables([], { workerNameToken: 'x', caseNumber: 1 })).toEqual({});
  });
});

describe('evaluateTemplateEligibility com política própria (o que muda entre etapa e REQ-09)', () => {
  const t = { slug: 'complete_register_x', body: 'Hola {{meet_link}}', category: 'UTILITY', is_active: false };
  const custom: EligibilityPolicy = { supportedPlaceholders: new Set(['meet_link']), deniedSlugPrefixes: [], optOutClauseRe: /baja/i, inactiveLast: true };

  it('a política padrão é a das mensagens por etapa — chamada sem política = STAGE_MESSAGE_POLICY', () => {
    expect(evaluateTemplateEligibility({ ...t, is_active: true, body: 'x {{case_number}}' })).toEqual(evaluateTemplateEligibility({ ...t, is_active: true, body: 'x {{case_number}}' }, STAGE_MESSAGE_POLICY));
    expect(STAGE_MESSAGE_POLICY).toMatchObject({ optOutClauseRe: null, inactiveLast: false, deniedSlugPrefixes: DENIED_SLUG_PREFIXES });
  });
  it('inactiveLast: as outras razões vêm ANTES de INACTIVE; inativo sem outra razão → INACTIVE por último', () => {
    expect(evaluateTemplateEligibility({ ...t, category: 'MARKETING' }, custom).reason).toBe('CATEGORY');
    expect(evaluateTemplateEligibility({ ...t, body: 'Hola {{1}} baja' }, custom).reason).toBe('PLACEHOLDERS');
    expect(evaluateTemplateEligibility(t, custom).reason).toBe('OPT_OUT_CLAUSE');
    expect(evaluateTemplateEligibility({ ...t, body: 'Hola {{meet_link}} BAJA' }, custom).reason).toBe('INACTIVE');
    expect(evaluateTemplateEligibility({ ...t, body: 'Hola {{meet_link}} BAJA', is_active: true }, custom)).toEqual({ eligible: true, reason: null, placeholders: ['meet_link'], unsupported: [] });
  });
  it('optOutClauseRe: corpo null/undefined sem cláusula → OPT_OUT_CLAUSE; allowlist e deny-list vêm da política (deny vazia deixa o slug de lembrete passar)', () => {
    expect(evaluateTemplateEligibility({ ...t, body: null, is_active: true }, custom).reason).toBe('OPT_OUT_CLAUSE');
    expect(evaluateTemplateEligibility({ ...t, body: undefined, is_active: true }, custom).reason).toBe('OPT_OUT_CLAUSE');
    expect(evaluateTemplateEligibility({ ...t, body: 'x {{meet_link}} baja', is_active: true }, { ...custom, deniedSlugPrefixes: DENIED_SLUG_PREFIXES }).reason).toBe('DENY_LIST');
    expect(isDeniedSlug('complete_register_x', [])).toBe(false);
  });
});

describe('SLOT_MISMATCH — o corpo aprovado é quem diz quantos slots a Meta exige', () => {
  const base = { slug: 'ar_finalize_signup_luz', category: 'UTILITY', is_active: true };

  it('corpo-ponteiro sem variável × template Twilio com 2 slots → INELEGÍVEL (envio quebraria)', () => {
    const r = evaluateTemplateEligibility({ ...base, body: '(ver Twilio Content Builder: HX54d6)', body_twilio: 'Hola {{1}}, entrá en {{2}}' });
    expect(r).toMatchObject({ eligible: false, reason: 'SLOT_MISMATCH' });
  });

  it('mesma quantidade de slots → elegível (1 nomeado ↔ 1 posicional)', () => {
    const r = evaluateTemplateEligibility({ slug: 'qualified_reprogram_confirm', category: 'UTILITY', is_active: true, body: 'Caso {{case_number}}', body_twilio: 'Caso {{1}}' });
    expect(r).toMatchObject({ eligible: true, reason: null });
  });

  it('sem corpo sincronizado (null) não há o que comparar — a regra antiga vale', () => {
    const r = evaluateTemplateEligibility({ ...base, body: 'Texto sem variável', body_twilio: null });
    expect(r).toMatchObject({ eligible: true, reason: null });
  });

  it('a razão mais forte vem antes: deny-list ganha de SLOT_MISMATCH', () => {
    const r = evaluateTemplateEligibility({ slug: 'admission_reminder_es', category: 'UTILITY', is_active: true, body: 'x', body_twilio: '{{1}}' });
    expect(r.reason).toBe('DENY_LIST');
  });

  it('twilioSlotCount conta slot distinto, tolera espaço e ignora corpo vazio', () => {
    expect(twilioSlotCount('{{1}} e {{ 2 }} e {{1}}')).toBe(2);
    expect(twilioSlotCount(null)).toBe(0);
    expect(twilioSlotCount('')).toBe(0);
  });
});
