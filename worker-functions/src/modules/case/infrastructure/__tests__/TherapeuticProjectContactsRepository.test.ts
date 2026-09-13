/**
 * TherapeuticProjectContactsRepository — resolução de contatos da versão (migration 429, lex-pr7
 * C5/C6). Molde: `PatientExternalContactRepository.test.ts` — pool/KMS mockados na fronteira, o
 * client de query é passado explicitamente (não toca `DatabaseConnection`).
 *
 * Prova, uma por condição do lex:
 *  · C5 — contato INATIVO → `{kind,id,inactive:true}`, nunca nome/telefone; contato SEM a célula
 *         de origem → `{kind,id,redacted:true}`, SEM consultar a tabela de origem (decisão ANTES
 *         do JOIN — D286/lex P3);
 *  · C6 — só os containers EFETIVAMENTE resolvidos (não redigidos) entram em `containersServed`.
 */
const mockDecrypt = jest.fn(async (v: string | null) => (v ? `dec(${v})` : null));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: (v: string | null) => mockDecrypt(v),
  })),
}));
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }) },
}));

import { TherapeuticProjectContactsRepository } from '../TherapeuticProjectContactsRepository';

const VERSION_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';

interface LinkFixture {
  contact_kind: 'RESPONSIBLE' | 'EXTERNAL' | 'COVERAGE' | 'CARE_TEAM';
  responsible_id?: string | null;
  external_contact_id?: string | null;
  coverage_contact_id?: string | null;
  professional_id?: string | null;
  sort_order: number;
}

/** Client fake: primeira query é o SELECT da ligação, as seguintes o JOIN por tabela de origem. */
function cliente(links: LinkFixture[], origins: Record<string, unknown[]> = {}) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/FROM patient_therapeutic_project_contacts/.test(sql)) {
      return { rows: links.map((l) => ({ responsible_id: null, external_contact_id: null, coverage_contact_id: null, professional_id: null, ...l })) };
    }
    if (/FROM patient_responsibles/.test(sql)) return { rows: origins.RESPONSIBLE ?? [] };
    if (/FROM patient_external_contacts/.test(sql)) return { rows: origins.EXTERNAL ?? [] };
    if (/FROM patient_coverage_emergency_contacts/.test(sql)) return { rows: origins.COVERAGE ?? [] };
    if (/FROM patient_professionals/.test(sql)) return { rows: origins.CARE_TEAM ?? [] };
    return { rows: [] };
  });
  return { cli: { query } as never, chamadas };
}

describe('TherapeuticProjectContactsRepository.resolve', () => {
  beforeEach(() => mockDecrypt.mockClear());

  it('versão sem NENHUM contato → lista vazia, nenhum container servido, e nem consulta a ligação de novo', async () => {
    const { cli, chamadas } = cliente([]);
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, ['patient_family:read'], cli);
    expect(out).toEqual({ contacts: [], containersServed: new Set() });
    expect(chamadas).toHaveLength(1);
  });

  it('SEM a célula de origem → `{kind,id,redacted:true}`, e a tabela de origem NUNCA é consultada (decisão antes do JOIN)', async () => {
    const { cli, chamadas } = cliente([{ contact_kind: 'RESPONSIBLE', responsible_id: 'r-1', sort_order: 0 }]);
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, [], cli);
    expect(out.contacts).toEqual([{ kind: 'RESPONSIBLE', id: 'r-1', redacted: true }]);
    expect(out.containersServed.size).toBe(0);
    expect(chamadas.some((c) => /FROM patient_responsibles/.test(c.sql))).toBe(false);
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it('COM a célula mas contato INATIVO → `{kind,id,inactive:true}`, nunca nome/telefone (lex C5, regra única)', async () => {
    const { cli } = cliente(
      [{ contact_kind: 'RESPONSIBLE', responsible_id: 'r-1', sort_order: 0 }],
      { RESPONSIBLE: [{ id: 'r-1', first_name: 'Ana', last_name: 'Gómez', relationship: 'Madre', phone_encrypted: 'enc-1', active: false }] },
    );
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, ['patient_family:read'], cli);
    expect(out.contacts).toEqual([{ kind: 'RESPONSIBLE', id: 'r-1', inactive: true }]);
    expect(out.containersServed.size).toBe(0);
    expect(JSON.stringify(out.contacts)).not.toContain('Ana');
    expect(JSON.stringify(out.contacts)).not.toContain('Madre');
  });

  it('linha da ligação sem correspondência na tabela de origem (id sumiu) → também `inactive:true`, nunca 500', async () => {
    const { cli } = cliente([{ contact_kind: 'COVERAGE', coverage_contact_id: 'c-sumiu', sort_order: 0 }], { COVERAGE: [] });
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, ['patient_coverage:read'], cli);
    expect(out.contacts).toEqual([{ kind: 'COVERAGE', id: 'c-sumiu', inactive: true }]);
  });

  it('RESPONSIBLE ativo: nome = first_name+last_name, telefone DECRIFRADO, relation = relationship', async () => {
    const { cli } = cliente(
      [{ contact_kind: 'RESPONSIBLE', responsible_id: 'r-1', sort_order: 0 }],
      { RESPONSIBLE: [{ id: 'r-1', first_name: 'Ana', last_name: 'Gómez', relationship: 'Madre', phone_encrypted: 'enc-1', active: true }] },
    );
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, ['patient_family:read'], cli);
    expect(out.contacts).toEqual([{ kind: 'RESPONSIBLE', id: 'r-1', name: 'Ana Gómez', phone: 'dec(enc-1)', relation: 'Madre' }]);
    expect(out.containersServed).toEqual(new Set(['family']));
    expect(mockDecrypt).toHaveBeenCalledWith('enc-1');
  });

  it('RESPONSIBLE sem telefone (phone_encrypted null) → phone: null, sem chamar o KMS', async () => {
    const { cli } = cliente(
      [{ contact_kind: 'RESPONSIBLE', responsible_id: 'r-1', sort_order: 0 }],
      { RESPONSIBLE: [{ id: 'r-1', first_name: 'Ana', last_name: 'Gómez', relationship: null, phone_encrypted: null, active: true }] },
    );
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, ['patient_family:read'], cli);
    expect(out.contacts).toEqual([{ kind: 'RESPONSIBLE', id: 'r-1', name: 'Ana Gómez', phone: null }]);
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it('EXTERNAL ativo: name/relation direto da linha', async () => {
    const { cli } = cliente(
      [{ contact_kind: 'EXTERNAL', external_contact_id: 'x-1', sort_order: 0 }],
      { EXTERNAL: [{ id: 'x-1', name: 'Prof. López', relation: 'TEACHER', phone_encrypted: 'enc-x', active: true }] },
    );
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, ['patient_family:read'], cli);
    expect(out.contacts).toEqual([{ kind: 'EXTERNAL', id: 'x-1', name: 'Prof. López', phone: 'dec(enc-x)', relation: 'TEACHER' }]);
    expect(out.containersServed).toEqual(new Set(['family']));
  });

  it('EXTERNAL sem telefone → phone: null, sem chamar o KMS', async () => {
    const { cli } = cliente(
      [{ contact_kind: 'EXTERNAL', external_contact_id: 'x-1', sort_order: 0 }],
      { EXTERNAL: [{ id: 'x-1', name: 'Prof. López', relation: 'TEACHER', phone_encrypted: null, active: true }] },
    );
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, ['patient_family:read'], cli);
    expect(out.contacts).toEqual([{ kind: 'EXTERNAL', id: 'x-1', name: 'Prof. López', phone: null, relation: 'TEACHER' }]);
  });

  it('COVERAGE sem telefone → phone: null, sem chamar o KMS', async () => {
    const { cli } = cliente(
      [{ contact_kind: 'COVERAGE', coverage_contact_id: 'c-1', sort_order: 0 }],
      { COVERAGE: [{ id: 'c-1', name: 'Obra Social X', kind: 'INSURANCE', phone_encrypted: null, active: true }] },
    );
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, ['patient_coverage:read'], cli);
    expect(out.contacts).toEqual([{ kind: 'COVERAGE', id: 'c-1', name: 'Obra Social X', phone: null, relation: 'INSURANCE' }]);
  });

  it('CARE_TEAM ativo COM telefone → phone decrifrado (a mistura acima só cobriu o caso sem telefone)', async () => {
    const { cli } = cliente(
      [{ contact_kind: 'CARE_TEAM', professional_id: 'p-2', sort_order: 0 }],
      { CARE_TEAM: [{ id: 'p-2', name: 'Dra. Souza', specialty: null, phone_encrypted: 'enc-p', active: true }] },
    );
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, ['patient_care_team:read'], cli);
    expect(out.contacts).toEqual([{ kind: 'CARE_TEAM', id: 'p-2', name: 'Dra. Souza', phone: 'dec(enc-p)' }]);
  });

  it('COVERAGE ativo: `relation` sai do `kind` da linha de cobertura', async () => {
    const { cli } = cliente(
      [{ contact_kind: 'COVERAGE', coverage_contact_id: 'c-1', sort_order: 0 }],
      { COVERAGE: [{ id: 'c-1', name: 'Obra Social X', kind: 'INSURANCE', phone_encrypted: 'enc-c', active: true }] },
    );
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, ['patient_coverage:read'], cli);
    expect(out.contacts).toEqual([{ kind: 'COVERAGE', id: 'c-1', name: 'Obra Social X', phone: 'dec(enc-c)', relation: 'INSURANCE' }]);
    expect(out.containersServed).toEqual(new Set(['coverage']));
  });

  it('CARE_TEAM ativo: `specialty` sai quando presente', async () => {
    const { cli } = cliente(
      [{ contact_kind: 'CARE_TEAM', professional_id: 'p-1', sort_order: 0 }],
      { CARE_TEAM: [{ id: 'p-1', name: 'Dr. Pérez', specialty: 'PSYCHIATRIST', phone_encrypted: null, active: true }] },
    );
    const repo = new TherapeuticProjectContactsRepository();
    const out = await repo.resolve(VERSION_ID, ['patient_care_team:read'], cli);
    expect(out.contacts).toEqual([{ kind: 'CARE_TEAM', id: 'p-1', name: 'Dr. Pérez', phone: null, specialty: 'PSYCHIATRIST' }]);
    expect(out.containersServed).toEqual(new Set(['care_team']));
  });

  it('mistura: redigido (sem célula) + inativo (sem KMS) + resolvido — mantém a ordem original de `sort_order`', async () => {
    const { cli } = cliente(
      [
        { contact_kind: 'RESPONSIBLE', responsible_id: 'r-1', sort_order: 0 },
        { contact_kind: 'COVERAGE', coverage_contact_id: 'c-1', sort_order: 1 },
        { contact_kind: 'CARE_TEAM', professional_id: 'p-1', sort_order: 2 },
      ],
      {
        RESPONSIBLE: [{ id: 'r-1', first_name: 'Ana', last_name: 'G', relationship: 'Madre', phone_encrypted: null, active: true }],
        CARE_TEAM: [{ id: 'p-1', name: 'Dr. X', specialty: null, phone_encrypted: null, active: false }],
      },
    );
    const repo = new TherapeuticProjectContactsRepository();
    // Só `patient_family:read` — COVERAGE fica redigido, CARE_TEAM tem célula mas está inativo.
    const out = await repo.resolve(VERSION_ID, ['patient_family:read', 'patient_care_team:read'], cli);
    expect(out.contacts.map((c) => c.kind)).toEqual(['RESPONSIBLE', 'COVERAGE', 'CARE_TEAM']);
    expect(out.contacts[1]).toEqual({ kind: 'COVERAGE', id: 'c-1', redacted: true });
    expect(out.contacts[2]).toEqual({ kind: 'CARE_TEAM', id: 'p-1', inactive: true });
    expect(out.containersServed).toEqual(new Set(['family']));
  });

  it('construtor sem argumento não toca o pool — só ao chamar `resolve` sem client explícito', async () => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
    const repo = new TherapeuticProjectContactsRepository();
    expect(mockPoolQuery).not.toHaveBeenCalled();
    const out = await repo.resolve(VERSION_ID, ['patient_family:read']);
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('FROM patient_therapeutic_project_contacts'), [VERSION_ID]);
    expect(out).toEqual({ contacts: [], containersServed: new Set() });
  });
});
