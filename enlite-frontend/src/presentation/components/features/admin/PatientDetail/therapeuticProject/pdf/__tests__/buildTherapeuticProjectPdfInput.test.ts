/**
 * buildTherapeuticProjectPdfInput — o insumo do PDF do projeto terapêutico (spec 017 F4).
 *
 * O que estes testes seguram:
 *  · lex C12 — o PDF consome SÓ o que a tela recebeu, e a decisão "esta seção entra?" é a MESMA
 *    célula de container dos cards (D286). Cada `reads.*` em `false` tem de produzir `null` no
 *    bloco correspondente (seção OMITIDA com rótulo), nunca string vazia nem dado de outro bloco.
 *  · `null` (bloco inteiro) ≠ `[]`/`'—'` (tem a célula, dado vazio) — a mesma distinção da D113.
 *  · lex C13 — a `version` que entra aqui é a buscada a cada clique; a função é PURA e não busca nada.
 */
import { describe, it, expect } from 'vitest';
import type { PatientContractedServiceDetail, PatientDetail } from '@domain/entities/PatientDetail';
import type { ResolvedTherapeuticContact, TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
import { patientDetailFixture } from '../../../__tests__/patientDetailFixture';
import { buildTherapeuticProjectPdfInput, formatIssuedAt, type PdfContainerReads } from '../buildTherapeuticProjectPdfInput';

// ── Insumos ──────────────────────────────────────────────────────────────────

const TODOS: PdfContainerReads = { identity: true, coverage: true, address: true, family: true, careTeam: true, services: true };
const NENHUM: PdfContainerReads = { identity: false, coverage: false, address: false, family: false, careTeam: false, services: false };

/** Tradutor fixo em es-AR de mentira: devolve `es:<chave>` para provar QUAL chave o builder pediu. */
const tEs = (key: string, fallback?: string): string => (key.endsWith('.DESCONHECIDO') ? (fallback ?? key) : `es:${key}`);

const SERVICO: PatientContractedServiceDetail = {
  id: 'svc-1',
  patientId: patientDetailFixture.id,
  serviceCode: 'AT',
  professionalProfile: 'Perfil sintético do prestador',
  providersNeeded: 1,
  authorizedHours: 20,
  weeklyHours: 20,
  careLocation: 'HOME',
  hourlyValue: null,
  hourlyValueRedacted: false,
  startDate: '2026-09-01T00:00:00.000Z',
  contractType: 'OBRA_SOCIAL',
  taxCondition: 'IVA_EXEMPT',
  supervisionFrequency: 'DAYS_30',
  guardShift: 'MORNING',
  providerAgeBand: 'AGE_30_45',
  addressId: 'addr1',
  liveVacancyId: null,
  schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
  active: true,
  endedAt: null,
  country: 'AR',
  deviceTypes: ['HOME'],
  providers: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const VERSAO: TherapeuticProjectVersion = {
  id: 'v1',
  patientId: patientDetailFixture.id,
  major: 1,
  minor: 0,
  version: 'V.1.0',
  editedFromVersionId: null,
  contractedServiceId: 'svc-1',
  contractedServiceCode: 'CAREGIVER',
  modality: 'IN_PERSON',
  diagnoses: [{ uri: 'http://id.who.int/icd/entity/1', title: 'Trastorno del espectro autista' }],
  clinicalContext: 'contexto sintético',
  generalObjective: 'objetivo sintético',
  specificObjectives: [{ id: 'so1', label: 'Objetivo 1' }],
  activities: [{ id: 'ac1', label: 'Atividade 1' }],
  pathologyTypes: [{ id: 'pt1', label: 'Neurológica' }],
  startDate: '2026-09-01',
  endDate: '2026-12-01',
  annulledAt: null,
  annulledByName: null,
  annulReason: null,
  createdByName: 'Ana Fixture',
  createdAt: '2026-09-01T10:00:00Z',
  country: 'AR',
  contactRefs: [],
  careTeamIds: [],
  contacts: [],
};

const AGORA = new Date(2026, 8, 8, 14, 5); // 08/09/2026 14:05 — local, sem fuso

const paciente = (over: Partial<PatientDetail> = {}): PatientDetail => ({ ...patientDetailFixture, ...over });

const montar = (over: {
  patient?: PatientDetail;
  version?: TherapeuticProjectVersion;
  reads?: PdfContainerReads;
  now?: Date;
  logoSrc?: string;
} = {}) =>
  buildTherapeuticProjectPdfInput({
    patient: over.patient ?? paciente({ contractedServices: [SERVICO] }),
    version: over.version ?? VERSAO,
    reads: over.reads ?? TODOS,
    tEs,
    now: over.now ?? AGORA,
    logoSrc: over.logoSrc,
  });

// ── Células de container (lex C12 / D286) ────────────────────────────────────

describe('lex C12 — cada `reads.*` decide se a seção existe no PDF', () => {
  it('com TODAS as células, todos os blocos vêm preenchidos', () => {
    const input = montar();

    expect(input.caseRef).toBe(patientDetailFixture.id);
    expect(input.version).toBe(VERSAO);
    expect(input.identification).not.toBeNull();
    expect(input.coverage).not.toBeNull();
    expect(input.service).not.toBeNull();
    expect(input.addressText).not.toBeNull();
    expect(input.emergencyContacts).not.toBeNull();
    expect(input.coverageEmergencyContacts).not.toBeNull();
    expect(input.modalityLabel).toBe('es:admin.patients.detail.therapeuticProjectCard.modalityOptions.IN_PERSON');
    expect(input.careTeam).not.toBeNull();
    expect(input.issuedAtText).toBe('08/09/2026 14:05');
    expect(input.logoSrc).toBeUndefined();
  });

  it('🔒 sem NENHUMA célula, TODO bloco é `null` (seção omitida) — nunca `[]` nem string vazia', () => {
    const input = montar({ reads: NENHUM });

    expect(input.identification).toBeNull();
    expect(input.coverage).toBeNull();
    expect(input.service).toBeNull();
    expect(input.addressText).toBeNull();
    expect(input.emergencyContacts).toBeNull();
    expect(input.coverageEmergencyContacts).toBeNull();
    expect(input.careTeam).toBeNull();
    // A modalidade é da VERSÃO (não de container): continua mesmo sem célula nenhuma da ficha.
    expect(input.modalityLabel).toBe('es:admin.patients.detail.therapeuticProjectCard.modalityOptions.IN_PERSON');
    // o que NÃO depende de célula continua: a referência do rodapé e a versão (lex C14).
    expect(input.caseRef).toBe(patientDetailFixture.id);
    expect(input.version).toBe(VERSAO);
  });

  it('`logoSrc` é repassado quando o chamador o serve da própria origem (lex C11)', () => {
    expect(montar({ logoSrc: '/logo.png' }).logoSrc).toBe('/logo.png');
  });
});

// ── Identificação ────────────────────────────────────────────────────────────

describe('identificação', () => {
  it('nome completo, documento traduzido e idade civil', () => {
    const { identification } = montar();

    expect(identification).toEqual({
      fullName: 'Santiago Claiman',
      documentLabel: 'es:admin.patients.detail.documentTypes.CPF 123.456.789-00',
      birthDate: '1960-03-18T00:00:00Z',
      age: 66,
    });
  });

  it('sem nome nem sobrenome → `—` (não string vazia)', () => {
    const { identification } = montar({ patient: paciente({ firstName: null, lastName: null, contractedServices: [SERVICO] }) });

    expect(identification!.fullName).toBe('—');
  });

  it('documento sem TIPO → só o número, sem espaço à esquerda (o `trim`)', () => {
    const { identification } = montar({ patient: paciente({ documentType: null, contractedServices: [SERVICO] }) });

    expect(identification!.documentLabel).toBe('123.456.789-00');
  });

  it('sem número de documento → `—`', () => {
    const { identification } = montar({ patient: paciente({ documentNumber: null, contractedServices: [SERVICO] }) });

    expect(identification!.documentLabel).toBe('—');
  });
});

// ── Cobertura ────────────────────────────────────────────────────────────────

describe('cobertura', () => {
  it('prefere a INFORMADA sobre a verificada', () => {
    const p = paciente({ insuranceInformed: 'OSDE', insuranceVerified: 'Swiss Medical', affiliateId: 'AF-1', contractedServices: [SERVICO] });

    expect(montar({ patient: p }).coverage).toEqual({ insurance: 'OSDE', affiliateId: 'AF-1' });
  });

  it('sem a informada, cai na VERIFICADA', () => {
    const p = paciente({ insuranceInformed: null, insuranceVerified: 'Swiss Medical', contractedServices: [SERVICO] });

    expect(montar({ patient: p }).coverage!.insurance).toBe('Swiss Medical');
  });

  it('sem nenhuma das duas → `null` DENTRO do bloco (o bloco existe, o dado é que falta)', () => {
    const { coverage } = montar();

    expect(coverage).toEqual({ insurance: null, affiliateId: null });
  });
});

// ── Serviço contratado ───────────────────────────────────────────────────────

describe('serviço contratado', () => {
  it('serviço ACHADO: rótulos traduzidos, dispositivos, perfil, horário e local', () => {
    const { service } = montar();

    expect(service).toEqual({
      serviceLabel: 'es:admin.patients.detail.contractedServicesCard.serviceTypes.AT',
      deviceLabels: ['es:admin.patients.deviceTypeOptions.HOME'],
      providerProfile: 'Perfil sintético do prestador',
      scheduleText: expect.any(String),
      careLocationLabel: 'es:admin.patients.detail.contractedServicesCard.careLocationOptions.HOME',
    });
  });

  it('sem `careLocation` → rótulo `null` (o resto do bloco fica)', () => {
    const p = paciente({ contractedServices: [{ ...SERVICO, careLocation: null }] });

    expect(montar({ patient: p }).service!.careLocationLabel).toBeNull();
  });

  it('🔴 serviço NÃO achado (a versão aponta para um id que não está na ficha): bloco com `—`, não `null`', () => {
    const { service } = montar({ version: { ...VERSAO, contractedServiceId: 'svc-inexistente' } });

    expect(service).toEqual({ serviceLabel: '—', deviceLabels: [], providerProfile: null, scheduleText: null, careLocationLabel: null });
  });

  it('sem a célula de serviços, o bloco inteiro é `null` — e a busca do serviço nem acontece', () => {
    const input = montar({ reads: { ...TODOS, services: false } });

    expect(input.service).toBeNull();
    // sem serviço, o endereço cai no principal do paciente (não no do serviço).
    expect(input.addressText).toBe('Rua Augusta, 975 - São Paulo/SP, Torre A, Ap. 701');
  });
});

// ── Endereço ─────────────────────────────────────────────────────────────────

describe('endereço (o do serviço; sem vínculo, o principal)', () => {
  it('serviço COM `addressId`: usa o endereço vinculado, com complemento', () => {
    expect(montar().addressText).toBe('Rua Augusta, 975 - São Paulo/SP, Torre A, Ap. 701');
  });

  it('endereço vinculado SEM complemento: sem a vírgula pendurada', () => {
    const p = paciente({
      contractedServices: [SERVICO],
      addresses: [{ ...patientDetailFixture.addresses[0], complement: null }],
    });

    expect(montar({ patient: p }).addressText).toBe('Rua Augusta, 975 - São Paulo/SP');
  });

  it('serviço SEM `addressId`: cai no principal do paciente', () => {
    const p = paciente({
      contractedServices: [{ ...SERVICO, addressId: null }],
      addresses: [
        { ...patientDetailFixture.addresses[0], id: 'a-outro', isPrimary: false, addressFormatted: 'Otro domicilio', complement: null },
        { ...patientDetailFixture.addresses[0], id: 'a-principal', isPrimary: true, addressFormatted: 'Domicilio principal', complement: null },
      ],
    });

    expect(montar({ patient: p }).addressText).toBe('Domicilio principal');
  });

  it('`addressId` que não existe na ficha: também cai no principal (sem quebrar)', () => {
    const p = paciente({ contractedServices: [{ ...SERVICO, addressId: 'addr-fantasma' }] });

    expect(montar({ patient: p }).addressText).toBe('Rua Augusta, 975 - São Paulo/SP, Torre A, Ap. 701');
  });

  it('nenhum endereço marcado como principal: usa o PRIMEIRO da lista, com complemento', () => {
    const p = paciente({
      contractedServices: [{ ...SERVICO, addressId: null }],
      addresses: [{ ...patientDetailFixture.addresses[0], isPrimary: false, addressFormatted: null, addressRaw: 'Calle Falsa 123', complement: 'PB' }],
    });

    expect(montar({ patient: p }).addressText).toBe('Calle Falsa 123, PB');
  });

  it('paciente SEM endereço nenhum → `—` (tem a célula, o dado é que falta)', () => {
    const p = paciente({ contractedServices: [{ ...SERVICO, addressId: null }], addresses: [] });

    expect(montar({ patient: p }).addressText).toBe('—');
  });

  it('sem a célula de endereço → `null` (seção omitida)', () => {
    expect(montar({ reads: { ...TODOS, address: false } }).addressText).toBeNull();
  });
});

// ── Contatos selecionados na versão (PR-7, `version.contacts`) ───────────────
// lex #7 C5/C12: o insumo do PDF NUNCA lê `patient.responsibles`/`coverageEmergencyContacts`/
// `professionals` para montar contato — só `version.contacts`, já SELECIONADOS e RESOLVIDOS pelo
// backend (resolved | inactive | redacted). RESPONSIBLE + EXTERNAL compõem o mesmo bloco família.

const responsavelResolvido: ResolvedTherapeuticContact = { kind: 'RESPONSIBLE', id: 'r1', name: 'Luciana Soto', phone: '(11) 99852-0481', relation: 'MOM' };
const externoResolvido: ResolvedTherapeuticContact = { kind: 'EXTERNAL', id: 'e1', name: 'Escuela X', phone: '(11) 4000-0000', relation: 'SCHOOL' };
const coberturaResolvida: ResolvedTherapeuticContact = { kind: 'COVERAGE', id: 'c1', name: 'Ambulancia X', phone: '0800-1', relation: 'PRIVATE_AMBULANCE' };
const equipeResolvida: ResolvedTherapeuticContact = { kind: 'CARE_TEAM', id: 'p1', name: 'Dr. João Alves Pereira', phone: '11-0000', specialty: 'Fisioterapia' };

describe('responsáveis e equipe tratante — SEMPRE de `version.contacts` (PR-7)', () => {
  it('responsável RESOLVIDO: parentesco traduzido pelo catálogo de responsáveis', () => {
    const v = { ...VERSAO, contacts: [responsavelResolvido] };
    expect(montar({ version: v }).emergencyContacts).toEqual([
      { status: 'resolved', name: 'Luciana Soto', relationship: 'es:admin.patients.detail.relationshipOptions.MOM', phone: '(11) 99852-0481' },
    ]);
  });

  it('externo RESOLVIDO: mesmo bloco família (container `family`), vínculo traduzido pelo catálogo de externos', () => {
    const v = { ...VERSAO, contacts: [responsavelResolvido, externoResolvido] };
    expect(montar({ version: v }).emergencyContacts).toEqual([
      { status: 'resolved', name: 'Luciana Soto', relationship: 'es:admin.patients.detail.relationshipOptions.MOM', phone: '(11) 99852-0481' },
      { status: 'resolved', name: 'Escuela X', relationship: 'es:admin.patients.detail.externalContactRelationOptions.SCHOOL', phone: '(11) 4000-0000' },
    ]);
  });

  it('sem vínculo (`relation` ausente): rótulo `null`, sem quebrar — RESPONSIBLE e EXTERNAL', () => {
    const semVinculo = { ...VERSAO, contacts: [{ kind: 'RESPONSIBLE', id: 'r2', name: 'Sem Vínculo', phone: null } as ResolvedTherapeuticContact] };
    expect(montar({ version: semVinculo }).emergencyContacts).toEqual([{ status: 'resolved', name: 'Sem Vínculo', relationship: null, phone: null }]);
    const externoSemVinculo = { ...VERSAO, contacts: [{ kind: 'EXTERNAL', id: 'e2', name: 'Externo Sem Vínculo', phone: null } as ResolvedTherapeuticContact] };
    expect(montar({ version: externoSemVinculo }).emergencyContacts).toEqual([{ status: 'resolved', name: 'Externo Sem Vínculo', relationship: null, phone: null }]);
  });

  it('sem a célula de família → `null`; com a célula e zero contatos selecionados → `[]`', () => {
    const v = { ...VERSAO, contacts: [responsavelResolvido] };
    expect(montar({ version: v, reads: { ...TODOS, family: false } }).emergencyContacts).toBeNull();
    expect(montar({ version: VERSAO }).emergencyContacts).toEqual([]);
  });

  it('🔒 lex #7 C5 — contato INATIVO: nunca nome/telefone, `status: "inactive"`', () => {
    const v = { ...VERSAO, contacts: [{ kind: 'RESPONSIBLE', id: 'r3', inactive: true } as ResolvedTherapeuticContact] };
    expect(montar({ version: v }).emergencyContacts).toEqual([{ status: 'inactive' }]);
  });

  it('🔒 lex #7 C12 — contato SEM CÉLULA de origem (o backend já redigiu): `status: "redacted"`, nunca nome/telefone', () => {
    const v = { ...VERSAO, contacts: [{ kind: 'RESPONSIBLE', id: 'r4', redacted: true } as ResolvedTherapeuticContact] };
    expect(montar({ version: v }).emergencyContacts).toEqual([{ status: 'redacted' }]);
  });

  it('417 / lex C5 — contatos da COBERTURA: bloco próprio sob `reads.coverage` (não sob família); tipo traduzido; sem seleção → `[]`', () => {
    const v = { ...VERSAO, contacts: [coberturaResolvida] };
    expect(montar({ version: v }).coverageEmergencyContacts).toEqual([
      { status: 'resolved', kindLabel: 'es:admin.patients.detail.coverageCard.emergencyContactKinds.PRIVATE_AMBULANCE', name: 'Ambulancia X', phone: '0800-1' },
    ]);
    // A célula que manda é a de COBERTURA: sem família o bloco continua; sem cobertura ele some.
    expect(montar({ version: v, reads: { ...TODOS, family: false } }).coverageEmergencyContacts).toHaveLength(1);
    expect(montar({ version: v, reads: { ...TODOS, coverage: false } }).coverageEmergencyContacts).toBeNull();
    // Zero contatos de cobertura selecionados → `[]`, nunca null (a célula existe).
    expect(montar({ version: VERSAO }).coverageEmergencyContacts).toEqual([]);
  });

  it('cobertura sem `relation` (kind ausente): rótulo do tipo vira `es:...DESCONHECIDO`-like fallback do tradutor, sem quebrar', () => {
    const semKind = { ...VERSAO, contacts: [{ kind: 'COVERAGE', id: 'c4', name: 'Cobertura Sem Kind', phone: '0800-9' } as ResolvedTherapeuticContact] };
    expect(montar({ version: semKind }).coverageEmergencyContacts).toEqual([
      { status: 'resolved', kindLabel: 'es:admin.patients.detail.coverageCard.emergencyContactKinds.', name: 'Cobertura Sem Kind', phone: '0800-9' },
    ]);
  });

  it('cobertura sem `phone` (nunca deveria acontecer na origem, mas a forma é `string | null`): vira `""`, não `null`', () => {
    const semTelefone = { ...VERSAO, contacts: [{ kind: 'COVERAGE', id: 'c5', name: 'Cobertura Sem Telefone', phone: null, relation: 'PRIVATE_AMBULANCE' } as ResolvedTherapeuticContact] };
    expect(montar({ version: semTelefone }).coverageEmergencyContacts).toEqual([
      { status: 'resolved', kindLabel: 'es:admin.patients.detail.coverageCard.emergencyContactKinds.PRIVATE_AMBULANCE', name: 'Cobertura Sem Telefone', phone: '' },
    ]);
  });

  it('🔒 lex #7 C5/C12 — contato de COBERTURA inativo/redigido: mesma régua tri-estado, nunca nome/telefone', () => {
    const inativo: ResolvedTherapeuticContact = { kind: 'COVERAGE', id: 'c2', inactive: true };
    const redigido: ResolvedTherapeuticContact = { kind: 'COVERAGE', id: 'c3', redacted: true };
    expect(montar({ version: { ...VERSAO, contacts: [inativo] } }).coverageEmergencyContacts).toEqual([{ status: 'inactive' }]);
    expect(montar({ version: { ...VERSAO, contacts: [redigido] } }).coverageEmergencyContacts).toEqual([{ status: 'redacted' }]);
  });

  it('D301 — modalidade `null` (versão anterior à 417) vira `null`; as seções fixas seguem o `contractedServiceCode` CONGELADO na versão, não o serviço da ficha', () => {
    expect(montar({ version: { ...VERSAO, modality: null } }).modalityLabel).toBeNull();
    expect(montar().fixedSectionsServiceCode).toBe('CAREGIVER');
    expect(montar({ version: { ...VERSAO, contractedServiceCode: 'AT' } }).fixedSectionsServiceCode).toBe('AT');
    // Sem célula de serviço e com serviço não encontrado: o código congelado continua vindo da versão.
    expect(montar({ reads: { ...TODOS, services: false } }).fixedSectionsServiceCode).toBe('CAREGIVER');
    expect(montar({ version: { ...VERSAO, contractedServiceId: 'svc-inexistente' } }).fixedSectionsServiceCode).toBe('CAREGIVER');
    // lex A1: o servidor retém o código sem `patient_services:read` → passa `null` adiante (rótulo neutro no PDF).
    expect(montar({ version: { ...VERSAO, contractedServiceCode: null, redacted: { services: true } } }).fixedSectionsServiceCode).toBeNull();
  });

  it('lex C3 / D167 — marcadores da cobertura: profissional retido (do servidor) e leitura indisponível (ausente ou falhou) — ambos só sob `reads.coverage`; independentes da SELEÇÃO de contatos', () => {
    const base = paciente({ contractedServices: [SERVICO], coverageEmergencyContacts: [] });
    expect(montar({ patient: base })).toMatchObject({ coverageDirectProfessionalRedacted: false, coverageEmergencyContactsUnavailable: false });
    expect(montar({ patient: paciente({ contractedServices: [SERVICO], coverageEmergencyContacts: [], coverageDirectProfessionalRedacted: true }) }).coverageDirectProfessionalRedacted).toBe(true);
    // Backend anterior à 417 (campo ausente) → indisponível.
    const antigo = montar({ patient: paciente({ contractedServices: [SERVICO] }) });
    expect(antigo.coverageEmergencyContactsUnavailable).toBe(true);
    // Bulkhead do servidor.
    expect(montar({ patient: paciente({ contractedServices: [SERVICO], coverageEmergencyContacts: [], coverageEmergencyContactsUnavailable: true }) }).coverageEmergencyContactsUnavailable).toBe(true);
    // Sem a célula: tudo desligado (o bloco inteiro é `null`).
    const semCelula = montar({ patient: paciente({ contractedServices: [SERVICO], coverageDirectProfessionalRedacted: true }), reads: { ...TODOS, coverage: false } });
    expect(semCelula).toMatchObject({ coverageEmergencyContacts: null, coverageDirectProfessionalRedacted: false, coverageEmergencyContactsUnavailable: false });
  });

  it('equipe tratante (CARE_TEAM): nome + especialidade (texto livre, sem catálogo); sem a célula de equipe, o bloco é `null`', () => {
    const v = { ...VERSAO, contacts: [equipeResolvida] };
    expect(montar({ version: v }).careTeam).toEqual([{ status: 'resolved', name: 'Dr. João Alves Pereira', relationship: 'Fisioterapia', phone: '11-0000' }]);
    expect(montar({ reads: { ...TODOS, careTeam: false } }).careTeam).toBeNull();
  });

  it('equipe tratante SEM especialidade: vínculo `null` (o `??`), sem quebrar', () => {
    const semEspecialidade: ResolvedTherapeuticContact = { kind: 'CARE_TEAM', id: 'p4', name: 'Sin Especialidad', phone: '11-9999' };
    expect(montar({ version: { ...VERSAO, contacts: [semEspecialidade] } }).careTeam).toEqual([
      { status: 'resolved', name: 'Sin Especialidad', relationship: null, phone: '11-9999' },
    ]);
  });

  it('🔒 lex #7 C5/C12 — equipe tratante inativa/redigida: mesma régua tri-estado', () => {
    const inativo: ResolvedTherapeuticContact = { kind: 'CARE_TEAM', id: 'p2', inactive: true };
    const redigido: ResolvedTherapeuticContact = { kind: 'CARE_TEAM', id: 'p3', redacted: true };
    expect(montar({ version: { ...VERSAO, contacts: [inativo] } }).careTeam).toEqual([{ status: 'inactive' }]);
    expect(montar({ version: { ...VERSAO, contacts: [redigido] } }).careTeam).toEqual([{ status: 'redacted' }]);
  });
});

// ── Data de emissão ──────────────────────────────────────────────────────────

describe('formatIssuedAt — `dd/mm/aaaa HH:MM`, determinístico e sem Intl', () => {
  it('põe zero à esquerda em dia, mês, hora e minuto', () => {
    expect(formatIssuedAt(new Date(2026, 0, 5, 7, 3))).toBe('05/01/2026 07:03');
  });

  it('mantém dois dígitos quando já os tem (e o mês é 1-based)', () => {
    expect(formatIssuedAt(new Date(2026, 11, 25, 23, 59))).toBe('25/12/2026 23:59');
  });

  it('sem `now`, o builder usa o relógio do operador', () => {
    const input = buildTherapeuticProjectPdfInput({
      patient: paciente({ contractedServices: [SERVICO] }),
      version: VERSAO,
      reads: TODOS,
      tEs,
    });

    expect(input.issuedAtText).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  });
});
