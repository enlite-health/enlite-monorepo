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
import type { TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
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
  diagnoses: [{ uri: 'http://id.who.int/icd/entity/1', title: 'Trastorno del espectro autista' }],
  clinicalContext: 'contexto sintético',
  generalObjective: 'objetivo sintético',
  specificObjectives: [{ id: 'so1', label: 'Objetivo 1' }],
  activities: [{ id: 'ac1', label: 'Atividade 1' }],
  pathologyTypes: [{ id: 'pt1', label: 'Neurológica' }],
  startDate: '2026-09-01',
  endDate: '2026-12-01',
  annulledAt: null,
  annulledBy: null,
  annulReason: null,
  createdByName: 'Ana Fixture',
  createdAt: '2026-09-01T10:00:00Z',
  country: 'AR',
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
    expect(input.careTeam).toBeNull();
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

// ── Responsáveis e equipe ────────────────────────────────────────────────────

describe('responsáveis e equipe tratante', () => {
  it('responsável com vínculo: parentesco traduzido', () => {
    expect(montar().emergencyContacts).toEqual([
      {
        name: 'Luciana Soto',
        relationship: 'es:admin.patients.detail.relationshipOptions.MOM',
        phone: '(11) 99852-0481',
        email: 'luciana.soto@example.com',
      },
    ]);
  });

  it('responsável SEM vínculo e sem nome: parentesco `null` e nome `—`', () => {
    const p = paciente({
      contractedServices: [SERVICO],
      responsibles: [{ ...patientDetailFixture.responsibles[0], firstName: null, lastName: null, relationship: null }],
    });

    expect(montar({ patient: p }).emergencyContacts).toEqual([
      { name: '—', relationship: null, phone: '(11) 99852-0481', email: 'luciana.soto@example.com' },
    ]);
  });

  it('sem a célula de família → `null`; com a célula e zero responsáveis → `[]`', () => {
    expect(montar({ reads: { ...TODOS, family: false } }).emergencyContacts).toBeNull();
    expect(montar({ patient: paciente({ contractedServices: [SERVICO], responsibles: [] }) }).emergencyContacts).toEqual([]);
  });

  it('profissional sem nome vira `—`; sem a célula de equipe, o bloco é `null`', () => {
    const p = paciente({
      contractedServices: [SERVICO],
      professionals: [patientDetailFixture.professionals[0], { ...patientDetailFixture.professionals[0], id: 'prof2', name: null }],
    });

    expect(montar({ patient: p }).careTeam).toEqual(['Dr. João Alves Pereira', '—']);
    expect(montar({ reads: { ...TODOS, careTeam: false } }).careTeam).toBeNull();
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
