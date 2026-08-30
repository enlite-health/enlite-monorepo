import {
  buildStageVariables,
  evaluateTemplateEligibility,
  extractPlaceholders,
  isDeniedSlug,
  DENIED_SLUG_PREFIXES,
} from '../StageTemplateEligibility';

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
