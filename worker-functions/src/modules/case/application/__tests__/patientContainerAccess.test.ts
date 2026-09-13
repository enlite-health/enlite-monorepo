/**
 * patientContainerAccess — o ponto único de decisão por CONTAINER da ficha do paciente (D286).
 *
 * As provas que o `lex` (06/09) pediu, uma por condição:
 *  · P1  — com `cells=['patient:read']` a LISTA não carrega diagnóstico nem documento;
 *  · C3  — o marcador `redacted.<container>` é CONSTANTE: paciente com e sem diagnóstico produzem
 *          a MESMA resposta para quem não tem a célula;
 *  · C4  — `completeness` não revela container que o ator não lê;
 *  · D113 — `cells = null` devolve o MESMO objeto (engine não decidiu), nunca `[]`.
 */
import {
  PATIENT_CONTAINERS,
  patientContainerCell,
  patientContainerReadsOf,
  projectCompletenessByContainers,
  projectPatientDetailByContainers,
  projectPatientListItemByContainers,
  servedPatientContainers,
  patientDetailTrailAction,
  patientDetailTrailOf,
} from '../patientContainerAccess';

const TODAS = PATIENT_CONTAINERS.map((c) => patientContainerCell(c, 'read'));

const ficha = {
  id: 'p1', status: 'ACTIVE', admissionStatus: 'DONE', country: 'AR', caseNumber: 12,
  firstName: 'Ana', lastName: 'G', documentNumber: '123', phoneWhatsapp: '+54', contactEmail: 'a@x',
  gender: 'FEMALE', languages: ['pt', 'es'], dischargedAt: '2026-08-01T12:00:00.000Z',
  diagnosis: 'TEA', diagnoses: [{ code: 'x' }], dependencyLevel: 'ALTA', emergencyInstructions: 'llamar', hasConsent: true,
  professionals: [{ name: 'Dr' }],
  responsibles: [{ name: 'Mãe' }], phoneMatchesResponsible: true,
  chatIds: { FAMILY: 'f@g.us' }, familyChatId: 'f@g.us', providersChatId: null,
  insuranceInformed: 'OSDE', affiliateId: 'A-1',
  addresses: [{ street: 'x' }], cityLocality: 'CABA',
  contractedServices: [{ id: 's1' }], serviceType: ['CAREGIVER'], serviceStartDate: '2026-01-01',
};

describe('patientContainerReadsOf', () => {
  it('null (engine não decidiu) → todos legíveis; [] → nenhum', () => {
    expect(Object.values(patientContainerReadsOf(null)).every(Boolean)).toBe(true);
    expect(Object.values(patientContainerReadsOf(undefined)).every(Boolean)).toBe(true);
    expect(Object.values(patientContainerReadsOf([])).some(Boolean)).toBe(false);
  });

  it('cada container responde só à SUA célula de leitura', () => {
    for (const c of PATIENT_CONTAINERS) {
      const reads = patientContainerReadsOf([patientContainerCell(c, 'read')]);
      expect(reads[c]).toBe(true);
      expect(PATIENT_CONTAINERS.filter((o) => o !== c).some((o) => reads[o])).toBe(false);
    }
    // escrita não dá leitura
    expect(patientContainerReadsOf(['patient_family:write']).family).toBe(false);
  });
});

describe('projectPatientDetailByContainers', () => {
  it('cells=null devolve o MESMO objeto (sem cópia, sem marcador)', () => {
    expect(projectPatientDetailByContainers(ficha, null)).toBe(ficha);
    expect(projectPatientDetailByContainers(ficha, TODAS)).toBe(ficha);
  });

  it('ator só operacional (patient:read): todo container vira null e o marcador aparece para todos', () => {
    const out = projectPatientDetailByContainers(ficha, ['patient:read']);
    expect(out).toMatchObject({ id: 'p1', status: 'ACTIVE', admissionStatus: 'DONE', country: 'AR', caseNumber: 12 });
    for (const f of ['firstName', 'documentNumber', 'contactEmail', 'gender', 'languages', 'dischargedAt', 'diagnosis', 'diagnoses', 'emergencyInstructions', 'professionals', 'responsibles', 'chatIds', 'familyChatId', 'insuranceInformed', 'affiliateId', 'addresses', 'cityLocality', 'contractedServices', 'serviceType']) {
      expect((out as Record<string, unknown>)[f]).toBeNull();
    }
    expect(out.redacted).toEqual({
      identity: true, clinical: true, careTeam: true, family: true, chat: true, coverage: true, address: true, services: true,
      // Spec 017: o container existe na ficha SÓ pelo marcador — nenhum campo (as versões têm rota própria).
      therapeuticProject: true,
    });
  });

  it('417 (D301) — coverageEmergencyContacts é campo do container de COBERTURA: sem a célula sai null; com ela, sai', () => {
    const comLista = { ...ficha, coverageEmergencyContacts: [{ id: 'c1', kind: 'AMBULANCE', name: 'A', phone: '1', sortOrder: 0 }], coverageDirectProfessionalRedacted: true } as typeof ficha;
    const sem = projectPatientDetailByContainers(comLista, ['patient:read', 'patient_identity:read']);
    expect((sem as Record<string, unknown>).coverageEmergencyContacts).toBeNull();
    expect((sem as Record<string, unknown>).coverageDirectProfessionalRedacted).toBeNull(); // o marcador também é do container
    expect(sem.redacted).toHaveProperty('coverage', true);
    const com = projectPatientDetailByContainers(comLista, ['patient:read', 'patient_coverage:read']);
    expect((com as Record<string, unknown>).coverageEmergencyContacts).toEqual([{ id: 'c1', kind: 'AMBULANCE', name: 'A', phone: '1', sortOrder: 0 }]);
    expect(com.redacted).not.toHaveProperty('coverage');
  });

  it('spec 017 — therapeuticProject: sem célula o marcador sai; com ela, nada muda na ficha (não há campo)', () => {
    const sem = projectPatientDetailByContainers(ficha, ['patient:read', 'patient_identity:read']);
    expect(sem.redacted).toHaveProperty('therapeuticProject', true);
    const com = projectPatientDetailByContainers(ficha, ['patient:read', 'patient_identity:read', 'patient_therapeutic_project:read']);
    expect(com.redacted).not.toHaveProperty('therapeuticProject');
    expect(Object.keys(com).sort()).toEqual(Object.keys(sem).sort());
  });

  it('spec 018 PR-3 (migration 425, lex CONDIÇÃO 5/6): gender/languages/dischargedAt vivem no container `identity`, nunca mais fracos que ele', () => {
    const semIdentidade = projectPatientDetailByContainers(ficha, ['patient:read', 'patient_family:read']);
    expect(semIdentidade.gender).toBeNull();
    expect(semIdentidade.languages).toBeNull();
    expect(semIdentidade.dischargedAt).toBeNull();
    expect(semIdentidade.redacted).toHaveProperty('identity', true);

    const comIdentidade = projectPatientDetailByContainers(ficha, ['patient:read', 'patient_identity:read']);
    expect(comIdentidade.gender).toBe('FEMALE');
    expect(comIdentidade.languages).toEqual(['pt', 'es']);
    expect(comIdentidade.dischargedAt).toBe('2026-08-01T12:00:00.000Z');
    expect(comIdentidade.redacted).not.toHaveProperty('identity');
  });

  // CONDIÇÃO 5 do lex (18-PR-3): telefone vive em `identity`, endereço vive em `address` — são
  // containers DIFERENTES. Um ator com SÓ `patient_identity:read` (sem `patient_address:read`)
  // recebe o telefone mas NUNCA o endereço — provando que o cabeçalho não usa uma célula mais
  // fraca que a origem do dado.
  it('spec 018 PR-3 CONDIÇÃO 5: ator SÓ patient_identity:read (sem patient_address:read) recebe phoneWhatsapp mas addresses/cityLocality/province/zoneNeighborhood saem null', () => {
    const soIdentidade = projectPatientDetailByContainers(ficha, ['patient:read', 'patient_identity:read']);
    expect(soIdentidade.phoneWhatsapp).toBe('+54'); // identity: sobrevive
    expect(soIdentidade.addresses).toBeNull();       // address: NÃO sobrevive
    expect(soIdentidade.cityLocality).toBeNull();
    expect(soIdentidade.redacted).toHaveProperty('address', true);
    expect(soIdentidade.redacted).not.toHaveProperty('identity');
  });

  it('só o container concedido sobrevive — familiares sem clínica', () => {
    const out = projectPatientDetailByContainers(ficha, ['patient:read', 'patient_family:read']);
    expect(out.responsibles).toEqual([{ name: 'Mãe' }]);
    expect(out.phoneMatchesResponsible).toBe(true);
    expect(out.diagnosis).toBeNull();
    expect(out.redacted).not.toHaveProperty('family');
    expect(out.redacted).toHaveProperty('clinical', true);
  });

  it('C3 — marcador CONSTANTE: ficha SEM diagnóstico e ficha COM diagnóstico saem IGUAIS para quem não lê a clínica', () => {
    const sem = { ...ficha, diagnosis: null, diagnoses: [], dependencyLevel: null, emergencyInstructions: null };
    const a = projectPatientDetailByContainers(ficha, ['patient:read', 'patient_identity:read']);
    const b = projectPatientDetailByContainers(sem, ['patient:read', 'patient_identity:read']);
    expect(a).toEqual(b);
    expect(a.redacted).toHaveProperty('clinical', true);
  });

  it('arrays de container escondido viram null, não [] — "[]" diria "não tem familiares"', () => {
    const out = projectPatientDetailByContainers(ficha, ['patient:read']);
    expect(out.responsibles).toBeNull();
    expect(out.addresses).toBeNull();
    expect(out.contractedServices).toBeNull();
  });

  it('preserva um `redacted` que a projeção anterior já tinha posto', () => {
    const out = projectPatientDetailByContainers({ ...ficha, redacted: { outro: true } }, ['patient:read']);
    expect(out.redacted).toMatchObject({ outro: true, clinical: true });
  });
});

describe('projectPatientListItemByContainers — P1: a lista é o export de fato', () => {
  const item = {
    id: 'p1', status: 'ACTIVE', admissionStatus: 'DONE', caseNumber: 12,
    firstName: 'Ana', lastName: 'G', documentType: 'DNI', documentNumber: '123', sex: 'F',
    responsibleName: 'Mãe', leadContactEmailMasked: 'a***@x', leadContactIsResponsible: false,
    diagnosis: 'TEA', dependencyLevel: 'ALTA', clinicalSpecialty: 'x', serviceType: ['CAREGIVER'], addressesCount: 2,
  };

  it("com cells=['patient:read'] NENHUM campo clínico nem de identidade sai", () => {
    const out = projectPatientListItemByContainers(item, ['patient:read']);
    for (const f of ['firstName', 'lastName', 'documentType', 'documentNumber', 'sex', 'responsibleName', 'leadContactEmailMasked', 'diagnosis', 'dependencyLevel', 'clinicalSpecialty', 'serviceType', 'addressesCount']) {
      expect((out as Record<string, unknown>)[f]).toBeNull();
    }
    expect(out).toMatchObject({ id: 'p1', status: 'ACTIVE', admissionStatus: 'DONE', caseNumber: 12 });
    expect(out.redacted).toMatchObject({ identity: true, clinical: true, services: true, address: true });
  });

  it('identidade sem clínica: nome e documento saem, diagnóstico não', () => {
    const out = projectPatientListItemByContainers(item, ['patient:read', 'patient_identity:read']);
    expect(out.firstName).toBe('Ana');
    expect(out.documentNumber).toBe('123');
    expect(out.diagnosis).toBeNull();
  });

  it('cells=null devolve o mesmo objeto', () => {
    expect(projectPatientListItemByContainers(item, null)).toBe(item);
  });
});

describe('projectCompletenessByContainers — C4', () => {
  const completeness = { missing: ['ADDRESS', 'RESPONSIBLE', 'COVERAGE', 'CONTRACTED_SERVICE', 'CONSENT'], blocking: ['ADDRESS', 'RESPONSIBLE', 'CONTRACTED_SERVICE'], ready: false, canActivate: false };

  it('cells=null: devolve o mesmo objeto', () => {
    expect(projectCompletenessByContainers(completeness, null)).toBe(completeness);
  });

  it('quem não lê familiares nem cobertura não recebe RESPONSIBLE nem COVERAGE', () => {
    const out = projectCompletenessByContainers(completeness, ['patient:read', 'patient_address:read', 'patient_services:read', 'patient_clinical:read']);
    expect(out.missing).toEqual(['ADDRESS', 'CONTRACTED_SERVICE', 'CONSENT']);
    expect(out.blocking).toEqual(['ADDRESS', 'CONTRACTED_SERVICE']);
    expect(out.ready).toBe(false);
  });

  it('ator sem nenhum container vê a ficha como "pronta" — por isso o gate do /activate recalcula do banco', () => {
    const out = projectCompletenessByContainers(completeness, ['patient:read']);
    expect(out).toEqual({ missing: [], blocking: [], ready: true, canActivate: true });
  });

  it('código desconhecido não é filtrado (fail-open para a lista de códigos crescer)', () => {
    const out = projectCompletenessByContainers({ ...completeness, missing: ['NOVO'], blocking: [] }, ['patient:read']);
    expect(out.missing).toEqual(['NOVO']);
  });
});

describe('servedPatientContainers — o que a trilha registra', () => {
  it('null → todos; parcial → só os concedidos, na ordem canônica', () => {
    expect(servedPatientContainers(null)).toEqual([...PATIENT_CONTAINERS]);
    expect(servedPatientContainers(['patient_chat:read', 'patient_identity:read'])).toEqual(['identity', 'chat']);
    expect(servedPatientContainers([])).toEqual([]);
  });

  it('o `action` da linha em resource_access_log é ENUMERADO: read_detail + containers (lex P7: tabela, não log)', () => {
    expect(patientDetailTrailAction(['patient:read', 'patient_identity:read', 'patient_chat:read'])).toBe('read_detail:identity+chat');
    expect(patientDetailTrailAction([])).toBe('read_detail');
    expect(patientDetailTrailAction(null)).toBe(`read_detail:${PATIENT_CONTAINERS.join('+')}`);
    expect(patientDetailTrailOf({ permissionCells: ['patient:read', 'patient_family:read'] })).toBe('read_detail:family');
    expect(patientDetailTrailOf({})).toBe(`read_detail:${PATIENT_CONTAINERS.join('+')}`);
  });
});
