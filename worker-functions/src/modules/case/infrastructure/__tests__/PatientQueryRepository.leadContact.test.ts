/**
 * PatientQueryRepository — desempate do lead sem nome, sob o parecer do lex 30/08.
 *
 * O formulário público não colhe nome (`2026-07-27a#DEC-02`), então todo lead
 * entra como 'Solicitante' e o Kanban vira N caixas idênticas. A listagem passou
 * a devolver o contato MASCARADO para desempatá-las. Este arquivo prende as
 * condições que autorizaram isso — cada `describe` nomeia a sua:
 *
 *   C1  máscara aplicada no SERVIDOR (o cru não sai no payload)
 *   C2  escopo travado no servidor (ficha com nome real não expõe nada)
 *   C4  chamadas ao KMS == nº de linhas com placeholder, e ZERO sem nenhuma
 *   C6  contato do responsável vem marcado como do responsável
 *
 * O espião de KMS é o instrumento do D170: a contagem `0` só vale como prova
 * porque o MESMO espião mede `2` no cenário vizinho. Zero sozinho não distingue
 * "não descriptografou" de "não mediu".
 */

const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));

/** Espião: conta TODA chamada de decrypt e devolve o "texto claro" do fixture. */
const decryptSpy = jest.fn(async (cipher: string | null) =>
  cipher == null ? null : cipher.replace(/^enc\(/, '').replace(/\)$/, ''),
);
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn(),
    decrypt: (c: string | null) => decryptSpy(c),
  })),
}));

jest.mock('../PatientDetailQueryHelper', () => ({ fetchPatientDetail: jest.fn() }));

import { PatientQueryRepository } from '../PatientQueryRepository';
import type { AdminPatientsListParams } from '../../interfaces/validators/adminPatientsListSchema';

const FILTERS = { limit: 20, offset: 0 } as AdminPatientsListParams;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1', isTest: false, clickupTaskId: null,
    firstName: 'Solicitante', lastName: null,
    diagnosis: null, dependencyLevel: null, clinicalSpecialty: null,
    serviceType: [], documentType: null, documentNumber: null, sex: null,
    status: 'SOLICITANTE', needsAttention: false, attentionReasons: [],
    addressesCount: '0', caseNumber: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    stageEnteredAt: new Date('2026-08-01T00:00:00Z').toISOString(),
    contactEmailEnc: null, responsibleEmailEnc: null,
    total_count: '1',
    ...overrides,
  };
}

function resolveWith(rows: Array<Record<string, unknown>>): void {
  mockPoolQuery.mockResolvedValueOnce({ rows });
}

beforeEach(() => {
  mockPoolQuery.mockReset();
  decryptSpy.mockClear();
});

describe('C2 — o corte de escopo vive no servidor', () => {
  it('ficha com nome REAL não devolve contato, mesmo tendo ciphertext na linha', async () => {
    resolveWith([
      row({ id: 'real', firstName: 'Ana', lastName: 'García', status: 'ACTIVE',
            contactEmailEnc: 'enc(ana@gmail.com)', total_count: '1' }),
    ]);

    const { rows } = await new PatientQueryRepository().list(FILTERS);

    expect(rows[0].leadContactEmailMasked).toBeNull();
    expect(rows[0].leadContactIsResponsible).toBe(false);
  });

  it('numa página mista, só a linha com placeholder carrega contato', async () => {
    resolveWith([
      row({ id: 'real', firstName: 'Ana', lastName: 'García',
            contactEmailEnc: 'enc(ana@gmail.com)', total_count: '2' }),
      row({ id: 'lead', contactEmailEnc: 'enc(joana@gmail.com)', total_count: '2' }),
    ]);

    const { rows } = await new PatientQueryRepository().list(FILTERS);

    expect(rows.find((r) => r.id === 'real')!.leadContactEmailMasked).toBeNull();
    expect(rows.find((r) => r.id === 'lead')!.leadContactEmailMasked).toBe('joa•••@gmail.com');
  });
});

describe('C1 — a máscara é do servidor, não do React', () => {
  it('o repositório devolve mascarado; o endereço cru não sai da camada', async () => {
    resolveWith([row({ contactEmailEnc: 'enc(joana@gmail.com)' })]);

    const { rows } = await new PatientQueryRepository().list(FILTERS);

    expect(rows[0].leadContactEmailMasked).toBe('joa•••@gmail.com');
    // A prova negativa: o local part inteiro não sobrevive em lugar nenhum da linha.
    expect(JSON.stringify(rows[0])).not.toContain('joana@gmail.com');
  });
});

describe('C6 — de quem é o contato', () => {
  it('lead preenchido pelo PACIENTE: contato próprio, sem marca de responsável', async () => {
    resolveWith([row({ contactEmailEnc: 'enc(joana@gmail.com)', responsibleEmailEnc: null })]);

    const { rows } = await new PatientQueryRepository().list(FILTERS);

    expect(rows[0].leadContactEmailMasked).toBe('joa•••@gmail.com');
    expect(rows[0].leadContactIsResponsible).toBe(false);
  });

  it('lead preenchido pelo FAMILIAR: paciente sem e-mail, contato do responsável marcado', async () => {
    // É o estado real dos 5 leads: CreateLeadUseCase:80 só grava contactEmail
    // quando o solicitante É o paciente.
    resolveWith([row({ contactEmailEnc: null, responsibleEmailEnc: 'enc(filha@gmail.com)' })]);

    const { rows } = await new PatientQueryRepository().list(FILTERS);

    expect(rows[0].leadContactEmailMasked).toBe('fil•••@gmail.com');
    expect(rows[0].leadContactIsResponsible).toBe(true);
  });
});

describe('C4 — o espião de KMS (molde D170)', () => {
  it('descriptografa EXATAMENTE uma vez por linha com placeholder', async () => {
    resolveWith([
      row({ id: 'l1', contactEmailEnc: 'enc(a@gmail.com)', total_count: '3' }),
      row({ id: 'l2', responsibleEmailEnc: 'enc(b@gmail.com)', total_count: '3' }),
      row({ id: 'real', firstName: 'Ana', lastName: 'García',
            contactEmailEnc: 'enc(c@gmail.com)', total_count: '3' }),
    ]);

    await new PatientQueryRepository().list(FILTERS);

    // 2 placeholders → 2 chamadas. A 3ª linha tem ciphertext e NÃO foi tocada.
    expect(decryptSpy).toHaveBeenCalledTimes(2);
  });

  it('CONTROLE POSITIVO: página sem nenhum placeholder faz ZERO chamadas ao KMS', async () => {
    resolveWith([
      row({ id: 'r1', firstName: 'Ana', lastName: 'García',
            contactEmailEnc: 'enc(a@gmail.com)', total_count: '2' }),
      row({ id: 'r2', firstName: 'Beto', lastName: 'Lima',
            contactEmailEnc: 'enc(b@gmail.com)', total_count: '2' }),
    ]);

    await new PatientQueryRepository().list(FILTERS);

    // Este zero só vale porque o MESMO espião mediu 2 no teste acima.
    expect(decryptSpy).toHaveBeenCalledTimes(0);
  });

  it('lead sem nenhum ciphertext não chama o KMS à toa', async () => {
    resolveWith([row({ contactEmailEnc: null, responsibleEmailEnc: null })]);

    await new PatientQueryRepository().list(FILTERS);

    expect(decryptSpy).toHaveBeenCalledTimes(0);
  });

  it('ciphertext que descriptografa para algo que NÃO é e-mail não vira card sujo', async () => {
    // Coluna com lixo (ou null) no banco: o KMS devolve, maskEmail recusa, e o
    // card fica sem contato em vez de exibir uma string qualquer.
    decryptSpy.mockResolvedValueOnce('nao-e-um-email');
    resolveWith([row({ contactEmailEnc: 'enc(lixo)' })]);

    const { rows } = await new PatientQueryRepository().list(FILTERS);

    expect(decryptSpy).toHaveBeenCalledTimes(1);
    expect(rows[0].leadContactEmailMasked).toBeNull();
    expect(rows[0].leadContactIsResponsible).toBe(false);
  });

  it('coluna AUSENTE na linha (undefined, não null) não quebra nem chama o KMS', async () => {
    const bare = row();
    delete (bare as Record<string, unknown>).contactEmailEnc;
    delete (bare as Record<string, unknown>).responsibleEmailEnc;
    resolveWith([bare]);

    const { rows } = await new PatientQueryRepository().list(FILTERS);

    expect(decryptSpy).toHaveBeenCalledTimes(0);
    expect(rows[0].leadContactEmailMasked).toBeNull();
  });

  it('falha do KMS degrada o card, não derruba a listagem', async () => {
    decryptSpy.mockRejectedValueOnce(new Error('KMS unavailable'));
    resolveWith([row({ contactEmailEnc: 'enc(joana@gmail.com)' })]);

    const { rows } = await new PatientQueryRepository().list(FILTERS);

    expect(rows).toHaveLength(1);
    expect(rows[0].leadContactEmailMasked).toBeNull();
  });
});
