/**
 * backfill-patient-diagnosis-catalog.dryrun.test.ts — gate F5, D3.
 *
 * 🔴 O DEFEITO: `parseBackfillFlags(['--dry-run','--write'])` devolve `{dryRun:true, write:true}`
 * — e o teste de flags já existente chama isso de "fail-safe". Só que `run()` decidia gravar
 * olhando SÓ `flags.write`; `flags.dryRun` só aparecia no `console.log`, que imprimia
 * `modo=DRY-RUN` ENQUANTO gravava em `patient_diagnoses`. O fail-safe existia no parser e
 * morria no caminho — sinal de proteção que existe no TIPO e não existe no CAMINHO é pior que
 * não existir, porque faz quem lê acreditar que está protegido.
 *
 * Semântica escolhida (a que o teste de flags JÁ declarava, D-3): **dry-run vence**. O código
 * passa a concordar com o teste, não o contrário.
 *
 * 🔒 CONTROLE POSITIVO obrigatório: um teste que só prova "não gravou" fica verde com o mock
 * quebrado (nada grava nunca). O bloco `--write` sozinho prova que este arreio SABE gravar.
 */

const recordDiagnosis = jest.fn();
const search = jest.fn();
const poolEnd = jest.fn();
const poolQuery = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: poolQuery, end: poolEnd })),
}));
jest.mock('../../src/modules/terminology/infrastructure/IcdCatalogTerminology', () => ({
  IcdCatalogTerminology: jest.fn().mockImplementation(() => ({ search })),
}));
jest.mock('../../src/modules/diagnosis/application/PatientDiagnosisService', () => ({
  PatientDiagnosisService: jest.fn().mockImplementation(() => ({ recordDiagnosis })),
}));
jest.mock('../../src/modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository', () => ({
  PostgresPatientDiagnosisRepository: jest.fn().mockImplementation(() => ({})),
}));

import { run } from '../backfill-patient-diagnosis-catalog';

const LOCAL = { DATABASE_URL: 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e' } as NodeJS.ProcessEnv;

beforeEach(() => {
  jest.clearAllMocks();
  // Um valor distinto de `diagnosis`, em 2 pacientes, que casa exatamente com 1 candidato.
  poolQuery.mockImplementation((sql: string) => {
    if (String(sql).includes('GROUP BY diagnosis')) {
      return Promise.resolve({ rows: [{ diagnosis: 'Diabetes mellitus tipo 2', patient_count: 2 }] });
    }
    return Promise.resolve({ rows: [{ id: 'pac-1' }, { id: 'pac-2' }] });
  });
  search.mockResolvedValue([{ uri: 'http://id.who.int/icd/entity/1', title: 'Diabetes mellitus tipo 2' }]);
  recordDiagnosis.mockResolvedValue({ outcome: 'created' });
});

describe('run() — o caminho de escrita tem de honrar --dry-run', () => {
  it('CONTROLE POSITIVO: com --write sozinho, GRAVA (é o que prova que este arreio sabe gravar)', async () => {
    const report = await run(LOCAL, ['--write']);
    expect(recordDiagnosis).toHaveBeenCalledTimes(2);
    expect(report.writes).toBe(2);
  });

  it('CONTROLE NEGATIVO: com --dry-run sozinho, não grava', async () => {
    const report = await run(LOCAL, ['--dry-run']);
    expect(recordDiagnosis).not.toHaveBeenCalled();
    expect(report.writes).toBe(0);
  });

  it('O DEFEITO: --dry-run E --write juntos NÃO gravam — dry-run vence, como o parser declara', async () => {
    const report = await run(LOCAL, ['--dry-run', '--write']);
    expect(recordDiagnosis).not.toHaveBeenCalled();
    expect(report.writes).toBe(0);
  });

  it('--dry-run --write continua MEDINDO: o relatório é o mesmo do dry-run puro, não um zero mudo', async () => {
    const seco = await run(LOCAL, ['--dry-run']);
    jest.clearAllMocks();
    search.mockResolvedValue([{ uri: 'http://id.who.int/icd/entity/1', title: 'Diabetes mellitus tipo 2' }]);
    const misto = await run(LOCAL, ['--dry-run', '--write']);
    expect(misto).toEqual(seco);
    expect(misto.matched).toBe(1);
    expect(misto.patientsAffected).toBe(2);
  });

  it('--dry-run --write NÃO consulta os ids dos pacientes — nem leitura de alvo de escrita acontece', async () => {
    await run(LOCAL, ['--dry-run', '--write']);
    const sqls = poolQuery.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => s.includes('GROUP BY diagnosis'))).toBe(true);
    expect(sqls.some(s => s.includes('SELECT id FROM patients'))).toBe(false);
  });

  it('a trava de alvo NÃO é desarmada: --write contra a porta de PRD aborta antes de qualquer pool', async () => {
    await expect(run({ DATABASE_URL: 'postgresql://u:p@localhost:5436/enlite_ar' } as NodeJS.ProcessEnv, ['--write']))
      .rejects.toThrow(/^TRAVA: porta 5436/);
    expect(recordDiagnosis).not.toHaveBeenCalled();
  });
});
