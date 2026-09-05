/**
 * PostgresPatientDiagnosisRepository — molde: PatientContractedServiceRepository.test.ts
 * (pool/client mockados; a prova de que o SQL real funciona é o e2e
 * tests/e2e/patient-diagnoses.e2e.test.ts, banco real).
 */
const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: mockPoolQuery }) }),
  },
}));

import { DiagnosisSource } from '../../domain/DiagnosisSource';
import {
  DuplicateActiveDiagnosisError,
  PrimaryDiagnosisConflictError,
} from '../../domain/PatientDiagnosisRepositoryPort';
import {
  PostgresPatientDiagnosisRepository,
  PatientDiagnosisNotFoundInScopeError,
} from '../PostgresPatientDiagnosisRepository';

/** Simula o 23505 real do Postgres sobre o índice parcial de principal único (C1). */
function primaryUniqueViolation(): Error & { code: string; constraint: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint: 'uq_patient_diagnoses_primary_por_origem',
  });
}

const ROW = {
  id: 'diag-1',
  patient_id: 'pat-1',
  terminology_system: 'ICD-11',
  concept_uri: 'http://id.who.int/icd/release/11/2026-01/mms/6A02',
  concept_code: '6A02.Z',
  concept_title: 'Trastorno del espectro autista',
  concept_language: 'es',
  concept_group: '06',
  catalog_release: '2026-01',
  source: 'PANEL',
  is_primary: false,
  active: true,
  ended_at: null,
  country: 'AR',
  created_by: 'uid-1',
  updated_by: 'uid-1',
  created_at: new Date('2026-09-04T00:00:00Z'),
  updated_at: new Date('2026-09-04T00:00:00Z'),
};

function txClient(rowForReturning: Record<string, unknown> = ROW) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const trimmed = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(trimmed)) return { rows: [], rowCount: 0 };
    if (/^UPDATE patient_diagnoses SET is_primary = false/.test(trimmed)) return { rows: [], rowCount: 1 };
    if (/^INSERT INTO patient_diagnoses/.test(trimmed)) return { rows: [rowForReturning], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { client: { query, release: jest.fn() }, calls };
}

/** Entrada de `create` reusada pelos testes de mapeamento de 23505 (T5). */
const NOVO_DIAGNOSTICO = {
  patientId: 'pat-1',
  conceptUri: ROW.concept_uri,
  conceptCode: ROW.concept_code,
  conceptTitle: ROW.concept_title,
  conceptLanguage: 'es' as const,
  conceptGroup: '06',
  catalogRelease: '2026-01',
  isPrimary: false,
  actorUid: 'uid-1',
};

describe('PostgresPatientDiagnosisRepository (spec 016 F2, escopo por construtor)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('patientExists: true/false conforme SELECT 1 devolve linha', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await repo.patientExists('pat-1')).toBe(true);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await repo.patientExists('fantasma')).toBe(false);
  });

  it('create: INSERT com source do ESCOPO (não do input) e retorna a Entity reconstruída', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockResolvedValueOnce({ rows: [ROW] });
    const created = await repo.create({
      patientId: 'pat-1',
      conceptUri: ROW.concept_uri,
      conceptCode: ROW.concept_code,
      conceptTitle: ROW.concept_title,
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: false,
      actorUid: 'uid-1',
    });
    expect(created.id).toBe('diag-1');
    expect(created.conceptCode.value).toBe('6A02.Z');
    expect(created.source.equals(DiagnosisSource.PANEL)).toBe(true);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO patient_diagnoses');
    expect(params).toContain('PANEL');
  });

  it('findById: filtra por source do escopo — devolve null se a query não achar linha (outra origem)', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.CLICKUP);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await repo.findById('diag-1')).toBeNull();
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('AND source = $2');
    expect(params).toEqual(['diag-1', 'CLICKUP']);
  });

  it('findById: devolve a Entity quando a query acha a linha', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockResolvedValueOnce({ rows: [ROW] });
    const found = await repo.findById('diag-1');
    expect(found?.id).toBe('diag-1');
  });

  it('listForPatient: NÃO filtra por origem — global de propósito (ver COMMENT do arquivo)', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockResolvedValueOnce({ rows: [ROW, { ...ROW, id: 'diag-2', source: 'CLICKUP' }] });
    const rows = await repo.listForPatient('pat-1');
    expect(rows).toHaveLength(2);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).not.toContain('source');
    expect(params).toEqual(['pat-1']);
  });

  it('findActiveByConceptCode: null quando não acha', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await repo.findActiveByConceptCode('pat-1', '6A02.Z')).toBeNull();
  });

  it('findActiveByConceptCode: devolve a Entity quando acha', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockResolvedValueOnce({ rows: [ROW] });
    const found = await repo.findActiveByConceptCode('pat-1', '6A02.Z');
    expect(found?.conceptCode.value).toBe('6A02.Z');
  });

  it('promotePrimary: lança PatientDiagnosisNotFoundInScopeError quando 0 linhas voltam (id de outra origem)', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.CLICKUP);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(repo.promotePrimary('diag-1', 'uid-1')).rejects.toThrow(PatientDiagnosisNotFoundInScopeError);
  });

  it('promotePrimary: devolve a Entity promovida', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...ROW, is_primary: true }] });
    const promoted = await repo.promotePrimary('diag-1', 'uid-9');
    expect(promoted.isPrimary).toBe(true);
  });

  it('deactivate: lança PatientDiagnosisNotFoundInScopeError quando 0 linhas voltam', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(repo.deactivate('diag-1', 'uid-1')).rejects.toThrow(PatientDiagnosisNotFoundInScopeError);
  });

  it('deactivate: devolve a Entity desativada', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ ...ROW, active: false, is_primary: false, ended_at: new Date() }],
    });
    const deactivated = await repo.deactivate('diag-1', 'uid-1');
    expect(deactivated.active).toBe(false);
  });

  it('demotePrimary: C1 — trava o lock consultivo POR PACIENTE ANTES do UPDATE escopado (patient_id, source, is_primary, active)', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // pg_advisory_xact_lock
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE
    await repo.demotePrimary('pat-1');
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    const [lockSql, lockParams] = mockPoolQuery.mock.calls[0];
    expect(lockSql).toContain('pg_advisory_xact_lock');
    expect(lockParams).toEqual(['diagnosis_primary:pat-1']);
    const [sql, params] = mockPoolQuery.mock.calls[1];
    expect(sql).toContain('is_primary');
    expect(params).toEqual(['pat-1', 'PANEL']);
  });

  it('create: C1 — 23505 do índice de principal vira PrimaryDiagnosisConflictError, NUNCA o erro cru do driver', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockRejectedValueOnce(primaryUniqueViolation());
    await expect(
      repo.create({
        patientId: 'pat-1',
        conceptUri: ROW.concept_uri,
        conceptCode: ROW.concept_code,
        conceptTitle: ROW.concept_title,
        conceptLanguage: 'es',
        conceptGroup: '06',
        catalogRelease: '2026-01',
        isPrimary: true,
        actorUid: 'uid-1',
      }),
    ).rejects.toThrow(PrimaryDiagnosisConflictError);
  });

  it('create: qualquer OUTRO erro do driver sobe intacto (não é engolido pelo mapeamento do 23505)', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      repo.create({
        patientId: 'pat-1',
        conceptUri: ROW.concept_uri,
        conceptCode: ROW.concept_code,
        conceptTitle: ROW.concept_title,
        conceptLanguage: 'es',
        conceptGroup: '06',
        catalogRelease: '2026-01',
        isPrimary: false,
        actorUid: 'uid-1',
      }),
    ).rejects.toThrow('connection reset');
  });

  it('promotePrimary: C1 — 23505 do índice de principal vira PrimaryDiagnosisConflictError (defesa em profundidade; o lock já torna isto inatingível em uso normal)', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockRejectedValueOnce(primaryUniqueViolation());
    await expect(repo.promotePrimary('diag-1', 'uid-1')).rejects.toThrow(PrimaryDiagnosisConflictError);
  });

  /**
   * 🔧 F5-CORREÇÃO T5 (QA-caça, 05/09/2026) — INVERSÃO DE UMA RÉGUA DE CONTROLE.
   *
   * A versão anterior deste teste mandava um 23505 do índice
   * `uq_patient_diagnoses_codigo_ativo_por_origem` (o SEGUNDO índice único da migration 325) e
   * afirmava `.rejects.not.toThrow(PrimaryDiagnosisConflictError)` — uma asserção NEGATIVA.
   * Ela passava ANTES da correção (o erro subia cru e virava HTTP 500) e passa DEPOIS (vira
   * DuplicateActiveDiagnosisError): régua de CONTROLE não detecta instrumento morto, só a
   * POSITIVA detecta. O nome dizia "sobe intacto" — o defeito descrito como comportamento
   * desejado, com o índice certo escrito na fixture.
   */
  it('T5 — 23505 do SEGUNDO índice único (dedupe por código ativo) vira DuplicateActiveDiagnosisError', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_patient_diagnoses_codigo_ativo_por_origem' }),
    );
    await expect(repo.create(NOVO_DIAGNOSTICO)).rejects.toBeInstanceOf(DuplicateActiveDiagnosisError);
  });

  it('T5 — cada índice tem SEU erro: o de principal continua PrimaryDiagnosisConflictError', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockRejectedValueOnce(primaryUniqueViolation());
    await expect(repo.create(NOVO_DIAGNOSTICO)).rejects.toBeInstanceOf(PrimaryDiagnosisConflictError);
  });

  it('T5 — 23505 de um TERCEIRO índice (desconhecido) continua subindo intacto, sem virar nenhum dos dois', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    const desconhecido = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_algum_indice_futuro' });
    mockPoolQuery.mockRejectedValueOnce(desconhecido);
    await expect(repo.create(NOVO_DIAGNOSTICO)).rejects.toBe(desconhecido);
  });

  it('T5 — 23505 SEM `constraint` no erro (driver antigo/erro sintético) não é adivinhado: sobe intacto', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    const semConstraint = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockPoolQuery.mockRejectedValueOnce(semConstraint);
    await expect(repo.create(NOVO_DIAGNOSTICO)).rejects.toBe(semConstraint);
  });

  it('create: erro de rejeição que NÃO é objeto (ex.: string crua) não quebra o mapeamento — sobe intacto', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    mockPoolQuery.mockRejectedValueOnce('rejeição crua');
    await expect(
      repo.create({
        patientId: 'pat-1',
        conceptUri: ROW.concept_uri,
        conceptCode: ROW.concept_code,
        conceptTitle: ROW.concept_title,
        conceptLanguage: 'es',
        conceptGroup: '06',
        catalogRelease: '2026-01',
        isPrimary: false,
        actorUid: 'uid-1',
      }),
    ).rejects.toBe('rejeição crua');
  });

  it('create: erro de rejeição `null` não quebra o mapeamento — sobe intacto', async () => {
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    // eslint-disable-next-line prefer-promise-reject-errors
    mockPoolQuery.mockReturnValueOnce(Promise.reject(null));
    await expect(
      repo.create({
        patientId: 'pat-1',
        conceptUri: ROW.concept_uri,
        conceptCode: ROW.concept_code,
        conceptTitle: ROW.concept_title,
        conceptLanguage: 'es',
        conceptGroup: '06',
        catalogRelease: '2026-01',
        isPrimary: false,
        actorUid: 'uid-1',
      }),
    ).rejects.toBeNull();
  });

  it('withTransaction: BEGIN, roda fn com um repo do MESMO escopo sobre o client, COMMIT; libera o client', async () => {
    const { client, calls } = txClient({ ...ROW, is_primary: true });
    mockConnect.mockResolvedValueOnce(client);
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    const result = await repo.withTransaction(async (tx) => {
      await tx.demotePrimary('pat-1');
      return tx.create({
        patientId: 'pat-1',
        conceptUri: ROW.concept_uri,
        conceptCode: ROW.concept_code,
        conceptTitle: ROW.concept_title,
        conceptLanguage: 'es',
        conceptGroup: '06',
        catalogRelease: '2026-01',
        isPrimary: true,
        actorUid: 'uid-1',
      });
    });
    expect(result.isPrimary).toBe(true);
    expect(calls[0].sql).toBe('BEGIN');
    expect(calls[calls.length - 1].sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('withTransaction: ROLLBACK e propaga o erro quando fn lança', async () => {
    const { client, calls } = txClient();
    mockConnect.mockResolvedValueOnce(client);
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    await expect(
      repo.withTransaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(calls.map((c) => c.sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('withTransaction ANINHADA reusa o MESMO client — sem BEGIN duplo', async () => {
    const { client, calls } = txClient({ ...ROW, active: false, is_primary: false, ended_at: new Date() });
    mockConnect.mockResolvedValueOnce(client);
    const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
    await repo.withTransaction(async (tx) => {
      // Chamada aninhada: não deve abrir um 2º BEGIN.
      return tx.withTransaction(async (inner) => inner.demotePrimary('pat-1'));
    });
    expect(calls.filter((c) => c.sql === 'BEGIN')).toHaveLength(1);
  });

  /**
   * 🔧 F5-CORREÇÃO T5 — `lockForPatient` virou método da porta: o dedupe de
   * `RecordPatientDiagnosis` precisa da MESMA chave por paciente que a troca de principal.
   */
  describe('T5 — lockForPatient (pg_advisory_xact_lock por paciente)', () => {
    it('emite pg_advisory_xact_lock com a chave derivada do paciente', async () => {
      const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await repo.lockForPatient('pat-1');
      expect(mockPoolQuery).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        ['diagnosis_primary:pat-1'],
      );
    });

    it('demotePrimary DELEGA a lockForPatient — uma chave só, um lugar só que a constrói', async () => {
      const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
      const spy = jest.spyOn(repo, 'lockForPatient');
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      await repo.demotePrimary('pat-9');
      expect(spy).toHaveBeenCalledWith('pat-9');
    });
  });

  /**
   * 🔧 F5-CORREÇÃO T8 — um ROLLBACK que FALHA substituía o erro ORIGINAL. Quem chama decide o
   * HTTP por `instanceof` (`PrimaryDiagnosisConflictError` em SetPrimaryDiagnosis /
   * RecordPatientDiagnosis): com o erro trocado, o `instanceof` erra e o cliente recebe 500 em
   * vez de 409. O irmão do mesmo PR já fazia certo (`ReadonlyDbQueryService`).
   */
  describe('T8 — ROLLBACK que falha não engole o erro original', () => {
    it('o erro que sobe é o de `fn`, e continua sendo instanceof PrimaryDiagnosisConflictError', async () => {
      const repo = new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL);
      const client = {
        query: jest.fn(async (sql: string) => {
          if (/^\s*ROLLBACK/i.test(sql)) throw new Error('ROLLBACK falhou: conexão já derrubada');
          return { rows: [], rowCount: 0 };
        }),
        release: jest.fn(),
      };
      mockConnect.mockResolvedValueOnce(client);

      const erroReal = new PrimaryDiagnosisConflictError('pat-1');
      const capturado = await repo
        .withTransaction(async () => {
          throw erroReal;
        })
        .then(() => null, (e: unknown) => e);

      expect(capturado).toBe(erroReal);
      // A trava DE VERDADE: o `instanceof` de quem decide o HTTP continua funcionando — era
      // exatamente ele que quebrava quando o erro do ROLLBACK tomava o lugar do original.
      expect(capturado instanceof PrimaryDiagnosisConflictError).toBe(true);
      expect((capturado as Error).message).not.toContain('ROLLBACK falhou');
      // ROLLBACK foi TENTADO (a falha dele é que não pode vazar), e a conexão foi liberada.
      expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });
});
