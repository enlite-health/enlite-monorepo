/**
 * AxonicoLancamentoRepository — teste de REPOSITÓRIO, banco Postgres REAL (nunca mock), contra a
 * migration 445 (`axonico_comprobante_lancamento`, change `integracao-axonico` F2) já aplicada.
 *
 * Prova o que o design pede: o dedupe local é uma trava de BANCO (índice único parcial
 * `uq_axonico_lancamento_dedupe`), não uma checagem no código — uma segunda tentativa
 * `status='enviado'` para a mesma tripla `(patient_id, service_type, service_date)` tem que
 * ESTOURAR por violação de constraint. Tentativas `duplicado`/`erro` repetidas, ao contrário,
 * precisam PASSAR — senão o índice não estaria provado como PARCIAL.
 *
 * Como rodar (fora da stack completa de `jest.config.e2e.js` — sem API nem Firebase Emulator):
 *   docker run -d --name axonico-f2-postgres -p 127.0.0.1:5543:5432 \
 *     -e POSTGRES_USER=enlite_admin -e POSTGRES_PASSWORD=enlite_password -e POSTGRES_DB=enlite_e2e \
 *     postgis/postgis:16-3.4
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5543/enlite_e2e \
 *     node scripts/run-migrations-docker.js
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5543/enlite_e2e \
 *     npx jest --config jest.config.repo.js --runInBand
 */
import { Pool } from 'pg';
import { AxonicoLancamentoRepository } from '../../src/modules/integration/infrastructure/AxonicoLancamentoRepository';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5543/enlite_e2e';

describe('AxonicoLancamentoRepository @repo (Postgres real, migration 445)', () => {
  let pool: Pool;
  let repo: AxonicoLancamentoRepository;
  let patientId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1'); // falha cedo e claro se o container não estiver de pé
    // O repositório usa o pool singleton de `DatabaseConnection` (mesmo padrão de
    // `AnaCareSyncRunRepository`) — aponta para o MESMO banco deste teste via DATABASE_URL.
    repo = new AxonicoLancamentoRepository();
  });

  afterAll(async () => {
    await pool.end();
    await DatabaseConnection.getInstance().getPool().end();
  });

  beforeEach(async () => {
    const { rows: [p] } = await pool.query<{ id: string }>('INSERT INTO patients DEFAULT VALUES RETURNING id');
    patientId = p.id;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM axonico_comprobante_lancamento WHERE patient_id = $1', [patientId]);
    await pool.query('DELETE FROM patients WHERE id = $1', [patientId]);
  });

  it('insert grava uma tentativa enviado e findExisting a devolve para a mesma tripla', async () => {
    const inserted = await repo.insert({
      patientId,
      serviceType: 'AT',
      serviceDate: '2026-09-18',
      hours: 4,
      numeroComprobante: 'CMP-1',
      codAutorizacion: 'AUT-1',
      status: 'enviado',
      errorMessage: null,
    });

    expect(inserted.status).toBe('enviado');
    expect(inserted.hours).toBe(4);

    const found = await repo.findExisting(patientId, 'AT', '2026-09-18');
    expect(found).not.toBeNull();
    expect(found?.id).toBe(inserted.id);
    expect(found?.numeroComprobante).toBe('CMP-1');
  });

  it('findExisting devolve null quando não há tentativa enviado para a tripla', async () => {
    const found = await repo.findExisting(patientId, 'AT', '2026-09-18');
    expect(found).toBeNull();
  });

  it('findExisting ignora tentativas duplicado/erro — só enxerga status=enviado', async () => {
    await repo.insert({
      patientId, serviceType: 'AT', serviceDate: '2026-09-18', hours: 2,
      numeroComprobante: null, codAutorizacion: null, status: 'erro', errorMessage: 'timeout',
    });
    await repo.insert({
      patientId, serviceType: 'AT', serviceDate: '2026-09-18', hours: 2,
      numeroComprobante: null, codAutorizacion: null, status: 'duplicado', errorMessage: null,
    });

    const found = await repo.findExisting(patientId, 'AT', '2026-09-18');
    expect(found).toBeNull();
  });

  it('UNIQUE parcial: uma segunda tentativa enviado para a mesma tripla ESTOURA', async () => {
    await repo.insert({
      patientId, serviceType: 'AT', serviceDate: '2026-09-18', hours: 3,
      numeroComprobante: 'CMP-A', codAutorizacion: 'AUT-A', status: 'enviado', errorMessage: null,
    });

    await expect(
      repo.insert({
        patientId, serviceType: 'AT', serviceDate: '2026-09-18', hours: 3,
        numeroComprobante: 'CMP-B', codAutorizacion: 'AUT-B', status: 'enviado', errorMessage: null,
      }),
    ).rejects.toThrow(/uq_axonico_lancamento_dedupe|duplicate key/);
  });

  it('duplicado repetido para a mesma tripla NÃO viola a constraint (índice é PARCIAL, não total)', async () => {
    await repo.insert({
      patientId, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
      numeroComprobante: null, codAutorizacion: null, status: 'duplicado', errorMessage: null,
    });
    const second = await repo.insert({
      patientId, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
      numeroComprobante: null, codAutorizacion: null, status: 'duplicado', errorMessage: null,
    });
    expect(second.status).toBe('duplicado');

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM axonico_comprobante_lancamento WHERE patient_id = $1 AND status = 'duplicado'`,
      [patientId],
    );
    expect(rows[0].count).toBe('2');
  });

  it('erro repetido para a mesma tripla NÃO viola a constraint (índice é PARCIAL, não total)', async () => {
    await repo.insert({
      patientId, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
      numeroComprobante: null, codAutorizacion: null, status: 'erro', errorMessage: 'falha 1',
    });
    const second = await repo.insert({
      patientId, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
      numeroComprobante: null, codAutorizacion: null, status: 'erro', errorMessage: 'falha 2',
    });
    expect(second.status).toBe('erro');

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM axonico_comprobante_lancamento WHERE patient_id = $1 AND status = 'erro'`,
      [patientId],
    );
    expect(rows[0].count).toBe('2');
  });

  it('service_date sobrevive ao round-trip como STRING YYYY-MM-DD íntegra — prova de fuso (rodar sob TZ=UTC e TZ=Asia/Tokyo)', async () => {
    // O parser `postgres-date` do `pg` devolve `Date` em MEIA-NOITE LOCAL para coluna `DATE`
    // (comentário literal no fonte da lib). Sem o cast `::date`→`::text` no repositório, ler
    // componentes UTC dessa `Date` sob TZ=Asia/Tokyo devolveria o dia ANTERIOR (17, não 18) — é
    // exatamente esse fuso que o briefing mediu como o que quebra a solução de componentes UTC.
    // Rodar esta suíte sob os dois TZs e comparar as saídas é a prova; aqui travamos que o tipo
    // devolvido é `string` (nunca `Date`, que faria `typeof` acusar 'object') e que o valor é
    // IDÊNTICO ao que foi gravado, em QUALQUER fuso do processo.
    const inserted = await repo.insert({
      patientId, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
      numeroComprobante: 'CMP-TZ', codAutorizacion: 'AUT-TZ', status: 'enviado', errorMessage: null,
    });
    expect(typeof inserted.serviceDate).toBe('string');
    expect(inserted.serviceDate).toBe('2026-09-18');

    const found = await repo.findExisting(patientId, 'AT', '2026-09-18');
    expect(found).not.toBeNull();
    expect(typeof found?.serviceDate).toBe('string');
    expect(found?.serviceDate).toBe('2026-09-18');
  });

  it('CHECK chk_axonico_lancamento_error_message: status=erro exige error_message (trava de banco, contorna o repositório)', async () => {
    await expect(
      pool.query(
        `INSERT INTO axonico_comprobante_lancamento (patient_id, service_type, service_date, hours, status, error_message)
         VALUES ($1, 'AT', '2026-09-18', 1, 'erro', NULL)`,
        [patientId],
      ),
    ).rejects.toThrow(/chk_axonico_lancamento_error_message/);
  });
});
