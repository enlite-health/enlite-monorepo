import {
  computePatientCompleteness,
  isMinor,
  PATIENT_COMPLETENESS_CODES,
  ACTIVATION_BLOCKING_CODES,
  ACTIVATABLE_STATUSES,
  INCOMPLETE_ADMISSION_REASON,
  patientIncompleteAdmissionSql,
  patientNeedsAttentionSql,
  patientHasAttentionReasonSql,
  type PatientCompletenessCode,
} from '../PatientCompleteness';

const NOW = new Date('2026-09-03T12:00:00Z');

const baseInput = {
  birthDate: '1980-01-01', // adulto — RESPONSIBLE nunca exigido
  hasConsent: true,
  insuranceInformed: 'OSDE',
  activeAddressCount: 1,
  activeResponsibleCount: 0,
  activeContractedServiceCount: 1,
  activeContractedServicesWithoutAddressCount: 0,
  now: NOW,
};

describe('PATIENT_COMPLETENESS_CODES (lex D1.2)', () => {
  it('é exatamente os 6 códigos administrativos — sem item clínico', () => {
    expect(PATIENT_COMPLETENESS_CODES).toEqual([
      'ADDRESS',
      'RESPONSIBLE',
      'COVERAGE',
      'CONTRACTED_SERVICE',
      'SERVICE_ADDRESS',
      'CONSENT',
    ]);
  });

  it('nenhum código nomeia conteúdo clínico (diagnóstico, patología, instrucciones)', () => {
    const clinicalWords = /diagn|patol|clinic|instruc|emerg/i;
    for (const code of PATIENT_COMPLETENESS_CODES as readonly string[]) {
      expect(clinicalWords.test(code)).toBe(false);
    }
  });
});

describe('isMinor', () => {
  it('menor de 18 → true', () => {
    expect(isMinor('2015-01-01', NOW)).toBe(true);
  });

  it('exatamente 18 anos (aniversário já passou este ano) → false', () => {
    expect(isMinor('2008-01-01', NOW)).toBe(false);
  });

  it('17 anos e 364 dias (aniversário É HOJE, mês/dia igual) → false (limite)', () => {
    expect(isMinor('2008-09-03', NOW)).toBe(false);
  });

  it('aniversário é AMANHÃ (ainda não fez 18) → true', () => {
    expect(isMinor('2008-09-04', NOW)).toBe(true);
  });

  it('birthDate null → false (não bloqueia por dado fora do escopo desta spec)', () => {
    expect(isMinor(null, NOW)).toBe(false);
  });

  it('birthDate inválida (string não-parseável) → false', () => {
    expect(isMinor('não é uma data', NOW)).toBe(false);
  });

  it('aceita Date além de string ISO', () => {
    expect(isMinor(new Date('2015-01-01'), NOW)).toBe(true);
  });

  it('sem `now` explícito, usa a data corrente real (default param) — paciente de 1900 é sempre maior', () => {
    expect(isMinor('1900-01-01')).toBe(false);
  });
});

describe('ACTIVATION_BLOCKING_CODES (D255, decisão 03/09 + migration 330, decisão 05/09)', () => {
  it('é ADDRESS e SERVICE_ADDRESS (os dois pela mesma razão: a vaga precisa de endereço) — os demais códigos são checklist informativo, não bloqueio do activate', () => {
    expect(ACTIVATION_BLOCKING_CODES).toEqual(['ADDRESS', 'SERVICE_ADDRESS']);
  });

  it('todo código de ACTIVATION_BLOCKING_CODES pertence a PATIENT_COMPLETENESS_CODES (sem código órfão)', () => {
    for (const code of ACTIVATION_BLOCKING_CODES) {
      expect(PATIENT_COMPLETENESS_CODES as readonly string[]).toContain(code);
    }
  });
});

describe('ACTIVATABLE_STATUSES', () => {
  it('é exatamente ADMISSION e PENDING_ADMISSION — os únicos status onde o checklist/botão de ativar aparecem', () => {
    expect(ACTIVATABLE_STATUSES).toEqual(['ADMISSION', 'PENDING_ADMISSION']);
  });
});

describe('computePatientCompleteness (SUP-D1 / D255)', () => {
  it('todos os critérios satisfeitos → ready true, missing [], blocking [], canActivate true', () => {
    expect(computePatientCompleteness(baseInput)).toEqual({
      missing: [],
      blocking: [],
      ready: true,
      canActivate: true,
    });
  });

  it('sem endereço ativo → ADDRESS em missing E em blocking; canActivate false', () => {
    const r = computePatientCompleteness({ ...baseInput, activeAddressCount: 0 });
    expect(r.missing).toContain('ADDRESS');
    expect(r.blocking).toEqual(['ADDRESS']);
    expect(r.ready).toBe(false);
    expect(r.canActivate).toBe(false);
  });

  it('blocking = missing ∩ ACTIVATION_BLOCKING_CODES — falta COVERAGE (não-bloqueante) não entra em blocking, canActivate continua true', () => {
    const r = computePatientCompleteness({ ...baseInput, insuranceInformed: null });
    expect(r.missing).toContain('COVERAGE');
    expect(r.blocking).toEqual([]);
    expect(r.ready).toBe(false);
    expect(r.canActivate).toBe(true);
  });

  it('TODOS os 4 códigos não-ADDRESS faltando ao mesmo tempo → nenhum entra em blocking, canActivate true (D255)', () => {
    const r = computePatientCompleteness({
      birthDate: '2015-01-01',
      hasConsent: false,
      insuranceInformed: null,
      activeAddressCount: 1,
      activeResponsibleCount: 0,
      activeContractedServiceCount: 0,
      activeContractedServicesWithoutAddressCount: 0,
      now: NOW,
    });
    expect(r.missing).toEqual(['RESPONSIBLE', 'COVERAGE', 'CONTRACTED_SERVICE', 'CONSENT']);
    expect(r.blocking).toEqual([]);
    expect(r.canActivate).toBe(true);
    expect(r.ready).toBe(false);
  });

  it('paciente MENOR sem responsável → RESPONSIBLE em missing', () => {
    const r = computePatientCompleteness({
      ...baseInput,
      birthDate: '2015-01-01',
      activeResponsibleCount: 0,
    });
    expect(r.missing).toContain('RESPONSIBLE');
  });

  it('paciente MENOR com ≥1 responsável → RESPONSIBLE não entra em missing', () => {
    const r = computePatientCompleteness({
      ...baseInput,
      birthDate: '2015-01-01',
      activeResponsibleCount: 1,
    });
    expect(r.missing).not.toContain('RESPONSIBLE');
  });

  it('paciente ADULTO sem responsável NÃO exige RESPONSIBLE', () => {
    const r = computePatientCompleteness({ ...baseInput, activeResponsibleCount: 0 });
    expect(r.missing).not.toContain('RESPONSIBLE');
  });

  it('sem cobertura informada (null) → COVERAGE em missing', () => {
    const r = computePatientCompleteness({ ...baseInput, insuranceInformed: null });
    expect(r.missing).toContain('COVERAGE');
  });

  it('cobertura string vazia/whitespace → COVERAGE em missing (não conta como preenchido)', () => {
    const r = computePatientCompleteness({ ...baseInput, insuranceInformed: '   ' });
    expect(r.missing).toContain('COVERAGE');
  });

  it('sem serviço contratado ativo → CONTRACTED_SERVICE em missing', () => {
    const r = computePatientCompleteness({ ...baseInput, activeContractedServiceCount: 0 });
    expect(r.missing).toContain('CONTRACTED_SERVICE');
  });

  // Migration 330 (decisão do Gabriel 05/09: "um serviço é um endereço")
  it('serviço ativo sem endereço → SERVICE_ADDRESS em missing E em blocking; canActivate false', () => {
    const r = computePatientCompleteness({ ...baseInput, activeContractedServicesWithoutAddressCount: 1 });
    expect(r.missing).toContain('SERVICE_ADDRESS');
    expect(r.blocking).toEqual(['SERVICE_ADDRESS']);
    expect(r.canActivate).toBe(false);
    expect(r.ready).toBe(false);
  });

  it('sem serviço nenhum → SERVICE_ADDRESS NÃO acusa (é CONTRACTED_SERVICE que acusa); paciente continua ativável (fallback por endereço)', () => {
    const r = computePatientCompleteness({
      ...baseInput,
      activeContractedServiceCount: 0,
      activeContractedServicesWithoutAddressCount: 0,
    });
    expect(r.missing).toEqual(['CONTRACTED_SERVICE']);
    expect(r.blocking).toEqual([]);
    expect(r.canActivate).toBe(true);
  });

  it('sem endereço E serviço sem endereço → os dois códigos bloqueiam, nesta ordem', () => {
    const r = computePatientCompleteness({
      ...baseInput,
      activeAddressCount: 0,
      activeContractedServicesWithoutAddressCount: 1,
    });
    expect(r.blocking).toEqual(['ADDRESS', 'SERVICE_ADDRESS']);
  });

  it('hasConsent false → CONSENT em missing', () => {
    const r = computePatientCompleteness({ ...baseInput, hasConsent: false });
    expect(r.missing).toContain('CONSENT');
  });

  it('hasConsent null → CONSENT em missing (ausência de dado não é consentimento)', () => {
    const r = computePatientCompleteness({ ...baseInput, hasConsent: null });
    expect(r.missing).toContain('CONSENT');
  });

  it('vários faltando ao mesmo tempo → todos aparecem, ready false', () => {
    const r = computePatientCompleteness({
      birthDate: '2016-06-01',
      hasConsent: false,
      insuranceInformed: null,
      activeAddressCount: 0,
      activeResponsibleCount: 0,
      activeContractedServiceCount: 0,
      activeContractedServicesWithoutAddressCount: 0,
      now: NOW,
    });
    const expected: PatientCompletenessCode[] = [
      'ADDRESS',
      'RESPONSIBLE',
      'COVERAGE',
      'CONTRACTED_SERVICE',
      'CONSENT',
    ];
    expect(r.missing).toEqual(expected);
    expect(r.ready).toBe(false);
  });

  it('missing preserva a ordem de PATIENT_COMPLETENESS_CODES (contrato estável p/ front)', () => {
    const r = computePatientCompleteness({
      birthDate: '2016-06-01',
      hasConsent: false,
      insuranceInformed: null,
      activeAddressCount: 0,
      activeResponsibleCount: 0,
      activeContractedServiceCount: 0,
      activeContractedServicesWithoutAddressCount: 0,
      now: NOW,
    });
    const indices = r.missing.map((code) => PATIENT_COMPLETENESS_CODES.indexOf(code));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

/**
 * As três funções que dão a MESMA regra ao filtro/contador da listagem (que rodam no banco).
 * A equivalência com `computePatientCompleteness` linha a linha é medida contra Postgres real em
 * `tests/e2e/c1b-patient-list-attention-agreement.e2e.test.ts`; aqui garantimos a FORMA: que toda
 * cláusula existe, que o alias é respeitado e que os três-valores do SQL estão fechados.
 */
describe('a regra em SQL (filtro/contadores da listagem)', () => {
  it('tem UMA cláusula por código do checklist — código novo sem SQL não passa daqui', () => {
    const sql = patientIncompleteAdmissionSql();
    const clausulaDe: Record<PatientCompletenessCode, RegExp> = {
      ADDRESS: /NOT EXISTS \(SELECT 1 FROM patient_addresses/,
      RESPONSIBLE: /NOT EXISTS \(SELECT 1 FROM patient_responsibles/,
      COVERAGE: /BTRIM\(COALESCE\(p\.insurance_informed, p\.health_insurance_name, ''\)\) = ''/,
      CONTRACTED_SERVICE: /NOT EXISTS \(SELECT 1 FROM patient_contracted_services/,
      SERVICE_ADDRESS: /EXISTS \(SELECT 1 FROM patient_contracted_services pcs\s+LEFT JOIN patient_addresses pa ON pa\.id = pcs\.address_id AND pa\.archived_at IS NULL/,
      CONSENT: /p\.has_consent IS NOT TRUE/,
    };
    for (const code of PATIENT_COMPLETENESS_CODES) expect(sql).toMatch(clausulaDe[code]);
    expect(Object.keys(clausulaDe).sort()).toEqual([...PATIENT_COMPLETENESS_CODES].sort());
  });

  it('só considera os status em que o checklist faz sentido, e fecha o NULL de `status`', () => {
    const sql = patientIncompleteAdmissionSql();
    for (const s of ACTIVATABLE_STATUSES) expect(sql).toContain(`'${s}'`);
    expect(sql).not.toContain("'ACTIVE'");
    // `NULL IN (…)` é NULL, não FALSE — sem o COALESCE o filtro devolveria "nem sim nem não".
    expect(sql).toMatch(/COALESCE\(p\.status, ''\) IN \(/);
  });

  it('a idade usa o MESMO corte de `isMinor` (18 anos, UTC, estritamente maior)', () => {
    const sql = patientIncompleteAdmissionSql();
    expect(sql).toMatch(/p\.birth_date > \(\(\(NOW\(\) AT TIME ZONE 'UTC'\)::date - INTERVAL '18 years'\)::date\)/);
    expect(isMinor('2008-09-03', new Date('2026-09-03T12:00:00Z'))).toBe(false); // fez 18 hoje
    expect(isMinor('2008-09-04', new Date('2026-09-03T12:00:00Z'))).toBe(true);
  });

  it('`needsAttention` é o legado OU o derivado — e o legado usa IS TRUE (a coluna aceita NULL)', () => {
    const sql = patientNeedsAttentionSql();
    expect(sql).toMatch(/p\.needs_attention IS TRUE OR/);
    expect(sql).not.toMatch(/needs_attention = true/);
    expect(sql).toContain(patientIncompleteAdmissionSql());
  });

  it('o filtro por motivo casa o legado GUARDADO e o derivado, e nomeia o código publicado', () => {
    const sql = patientHasAttentionReasonSql('$3');
    expect(sql).toMatch(/\$3 = ANY\(p\.attention_reasons\)/);
    expect(sql).toContain(`$3 = '${INCOMPLETE_ADMISSION_REASON}'`);
    expect(INCOMPLETE_ADMISSION_REASON).toBe('INCOMPLETE_ADMISSION');
  });

  it('o alias da tabela é injetável (default `p`) — as três funções o respeitam em TODA cláusula', () => {
    for (const sql of [patientIncompleteAdmissionSql('pac'), patientNeedsAttentionSql('pac'), patientHasAttentionReasonSql('$1', 'pac')]) {
      expect(sql).toContain('pac.');
      expect(sql).not.toMatch(/(?<![a-z_])p\.(status|needs_attention|has_consent|birth_date|attention_reasons|insurance_informed|id)/);
    }
    expect(patientNeedsAttentionSql()).toContain('p.needs_attention');
  });
});
