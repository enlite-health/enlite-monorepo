/**
 * AxonicoLancamentoRepository — teste de REPOSITÓRIO, banco Postgres REAL (nunca mock), contra a
 * migration 445 (`axonico_comprobante_lancamento`, change `integracao-axonico` F2) já aplicada.
 *
 * Prova o que o design pede: o dedupe local é uma trava de BANCO (índice único parcial
 * `uq_axonico_lancamento_dedupe`), não uma checagem no código — uma segunda tentativa
 * `status='enviado'` para a mesma tripla `(document_number, service_type, service_date)` tem que
 * ESTOURAR por violação de constraint. Tentativas `duplicado`/`erro` repetidas, ao contrário,
 * precisam PASSAR — senão o índice não estaria provado como PARCIAL.
 *
 * CORREÇÃO (18/09/2026, antes do merge): a chave de dedupe deixou de ser `patient_id` e passou a
 * ser `document_number` (o Axonico fatura pelo DNI, e dois `patient_id` podem compartilhar o
 * mesmo DNI — ver migration 445). `document_number` vira coluna própria da tabela, `patient_id`
 * continua gravado (rastreabilidade), só sai da chave de dedupe/busca.
 *
 * CORREÇÃO (24/09/2026, change `axonico-envio-rastreavel`): `sent_by` (migration 473) — toda
 * tentativa agora grava quem a disparou. Este teste semeia uma linha própria em `users` no
 * `beforeAll` (mesmo padrão de `tests/e2e/wave4-entities-and-fks.test.ts`) só para exercitar o
 * JOIN de `findSentByDocumentAndMonth` (`sentByName` resolvido) — NÃO porque a coluna exija.
 *
 * CORREÇÃO (25/09/2026, achado A1 do gate `revisao-pr`, ANTES do merge): a versão original desta
 * migration levava `sent_by REFERENCES users(firebase_uid)`. Errado — o uid autenticado
 * (`FirebaseAuthStrategy.authenticateProduction`) pode não ter linha em `users` (JWT com claims
 * `role`+`account_type` nunca consulta o banco; ou a linha existe mas foi achada só por E-MAIL,
 * com um `firebase_uid` diferente do uid do token) — e a tentativa JÁ FATUROU no Axonico antes
 * deste INSERT. Uma FK que estoura aqui perde o registro local de um faturamento real. `sent_by`
 * é `VARCHAR(128) NULL` simples, sem FK: grava QUALQUER uid, mesmo sem linha correspondente em
 * `users` — a leitura (`findSentByDocumentAndMonth`) é sempre `LEFT JOIN`, `sentByName` sai `null`
 * quando não acha, nunca quebra.
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

const DNI = '30111222';
// FK real (migration 473) — sent_by tem que apontar para uma linha existente em users.firebase_uid.
const SENT_BY_UID = 'axonico-lancamento-repo-test-uid';
const SENT_BY_NAME = 'QA Axonico Repo Test';

describe('AxonicoLancamentoRepository @repo (Postgres real, migration 445)', () => {
  let pool: Pool;
  let repo: AxonicoLancamentoRepository;
  let patientId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1'); // falha cedo e claro se o container não estiver de pé
    // Seed de `users` — `sent_by` (migration 473) tem FK real para `users.firebase_uid`; sem esta
    // linha, todo `insert()` com `sentBy: SENT_BY_UID` estouraria FK, não o que o teste quer provar.
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (firebase_uid) DO NOTHING`,
      [SENT_BY_UID, 'axonico-lancamento-repo-test@e2e.local', SENT_BY_NAME],
    );
    // O repositório usa o pool singleton de `DatabaseConnection` (mesmo padrão de
    // `AnaCareSyncRunRepository`) — aponta para o MESMO banco deste teste via DATABASE_URL.
    repo = new AxonicoLancamentoRepository();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE firebase_uid = $1', [SENT_BY_UID]);
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

  it('insert grava uma tentativa enviado e findExisting a devolve para a mesma tripla (documentNumber)', async () => {
    const inserted = await repo.insert({
      patientId,
      documentNumber: DNI,
      serviceType: 'AT',
      serviceDate: '2026-09-18',
      hours: 4,
      numeroComprobante: 'CMP-1',
      codAutorizacion: 'AUT-1',
      status: 'enviado',
      errorMessage: null, sentBy: SENT_BY_UID,
    });

    expect(inserted.status).toBe('enviado');
    expect(inserted.hours).toBe(4);
    expect(inserted.documentNumber).toBe(DNI);

    const found = await repo.findExisting(DNI, 'AT', '2026-09-18');
    expect(found).not.toBeNull();
    expect(found?.id).toBe(inserted.id);
    expect(found?.numeroComprobante).toBe('CMP-1');
  });

  it('findExisting devolve null quando não há tentativa enviado para a tripla', async () => {
    const found = await repo.findExisting(DNI, 'AT', '2026-09-18');
    expect(found).toBeNull();
  });

  it('findExisting ignora tentativas duplicado/erro — só enxerga status=enviado', async () => {
    await repo.insert({
      patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 2,
      numeroComprobante: null, codAutorizacion: null, status: 'erro', errorMessage: 'timeout', sentBy: SENT_BY_UID,
    });
    await repo.insert({
      patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 2,
      numeroComprobante: null, codAutorizacion: null, status: 'duplicado', errorMessage: null, sentBy: SENT_BY_UID,
    });

    const found = await repo.findExisting(DNI, 'AT', '2026-09-18');
    expect(found).toBeNull();
  });

  it('UNIQUE parcial: uma segunda tentativa enviado para a mesma tripla de documentNumber ESTOURA', async () => {
    await repo.insert({
      patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 3,
      numeroComprobante: 'CMP-A', codAutorizacion: 'AUT-A', status: 'enviado', errorMessage: null, sentBy: SENT_BY_UID,
    });

    await expect(
      repo.insert({
        patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 3,
        numeroComprobante: 'CMP-B', codAutorizacion: 'AUT-B', status: 'enviado', errorMessage: null, sentBy: SENT_BY_UID,
      }),
    ).rejects.toThrow(/uq_axonico_lancamento_dedupe|duplicate key/);
  });

  it('CORREÇÃO 18/09/2026 — dois patient_id DISTINTOS com o MESMO documentNumber: a segunda tentativa enviado ESTOURA (a chave é o DNI, não o patient_id)', async () => {
    const { rows: [p2] } = await pool.query<{ id: string }>('INSERT INTO patients DEFAULT VALUES RETURNING id');
    const outroPatientId = p2.id;
    try {
      await repo.insert({
        patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 3,
        numeroComprobante: 'CMP-P1', codAutorizacion: 'AUT-P1', status: 'enviado', errorMessage: null, sentBy: SENT_BY_UID,
      });

      // patient_id DIFERENTE do primeiro, mas MESMO documentNumber — antes da correção isto
      // passava (dedupe era por patient_id); agora estoura.
      await expect(
        repo.insert({
          patientId: outroPatientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 3,
          numeroComprobante: 'CMP-P2', codAutorizacion: 'AUT-P2', status: 'enviado', errorMessage: null, sentBy: SENT_BY_UID,
        }),
      ).rejects.toThrow(/uq_axonico_lancamento_dedupe|duplicate key/);
    } finally {
      await pool.query('DELETE FROM axonico_comprobante_lancamento WHERE patient_id = $1', [outroPatientId]);
      await pool.query('DELETE FROM patients WHERE id = $1', [outroPatientId]);
    }
  });

  it('duplicado repetido para a mesma tripla NÃO viola a constraint (índice é PARCIAL, não total)', async () => {
    await repo.insert({
      patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
      numeroComprobante: null, codAutorizacion: null, status: 'duplicado', errorMessage: null, sentBy: SENT_BY_UID,
    });
    const second = await repo.insert({
      patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
      numeroComprobante: null, codAutorizacion: null, status: 'duplicado', errorMessage: null, sentBy: SENT_BY_UID,
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
      patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
      numeroComprobante: null, codAutorizacion: null, status: 'erro', errorMessage: 'falha 1', sentBy: SENT_BY_UID,
    });
    const second = await repo.insert({
      patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
      numeroComprobante: null, codAutorizacion: null, status: 'erro', errorMessage: 'falha 2', sentBy: SENT_BY_UID,
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
      patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
      numeroComprobante: 'CMP-TZ', codAutorizacion: 'AUT-TZ', status: 'enviado', errorMessage: null, sentBy: SENT_BY_UID,
    });
    expect(typeof inserted.serviceDate).toBe('string');
    expect(inserted.serviceDate).toBe('2026-09-18');

    const found = await repo.findExisting(DNI, 'AT', '2026-09-18');
    expect(found).not.toBeNull();
    expect(typeof found?.serviceDate).toBe('string');
    expect(found?.serviceDate).toBe('2026-09-18');
  });

  it('CHECK chk_axonico_lancamento_error_message: status=erro exige error_message (trava de banco, contorna o repositório)', async () => {
    await expect(
      pool.query(
        `INSERT INTO axonico_comprobante_lancamento (patient_id, document_number, service_type, service_date, hours, status, error_message)
         VALUES ($1, $2, 'AT', '2026-09-18', 1, 'erro', NULL)`,
        [patientId, DNI],
      ),
    ).rejects.toThrow(/chk_axonico_lancamento_error_message/);
  });

  describe('sent_by (migration 473, change axonico-envio-rastreavel)', () => {
    it('insert grava sent_by e findExisting o devolve', async () => {
      const inserted = await repo.insert({
        patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 4,
        numeroComprobante: 'CMP-SB', codAutorizacion: 'AUT-SB', status: 'enviado', errorMessage: null, sentBy: SENT_BY_UID,
      });
      expect(inserted.sentBy).toBe(SENT_BY_UID);

      const found = await repo.findExisting(DNI, 'AT', '2026-09-18');
      expect(found?.sentBy).toBe(SENT_BY_UID);
    });

    it('A1 (25/09/2026) — sent_by aponta para um uid SEM linha em users: grava normalmente, sem erro (sent_by é trilha, não invariante relacional)', async () => {
      const inserted = await repo.insert({
        patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
        numeroComprobante: 'CMP-SEM-USERS', codAutorizacion: 'AUT-SEM-USERS', status: 'enviado', errorMessage: null,
        sentBy: 'uid-sem-linha-em-users',
      });
      expect(inserted.sentBy).toBe('uid-sem-linha-em-users');

      const found = await repo.findExisting(DNI, 'AT', '2026-09-18');
      expect(found?.sentBy).toBe('uid-sem-linha-em-users');
    });

    it('A1 (25/09/2026) — findSentByDocumentAndMonth com sent_by SEM linha em users: sentByName null (LEFT JOIN não quebra), front mostraria só a data', async () => {
      await repo.insert({
        patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
        numeroComprobante: 'CMP-SEM-USERS-2', codAutorizacion: 'AUT-SEM-USERS-2', status: 'enviado', errorMessage: null,
        sentBy: 'uid-sem-linha-em-users-2',
      });

      const sent = await repo.findSentByDocumentAndMonth(DNI, 'AT', '2026-09-01');
      expect(sent).toHaveLength(1);
      expect(sent[0].sentBy).toBe('uid-sem-linha-em-users-2');
      expect(sent[0].sentByName).toBeNull();
    });

    it('findSentByDocumentAndMonth devolve a tentativa enviado do mês, com displayName resolvido via JOIN em users', async () => {
      await repo.insert({
        patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 4,
        numeroComprobante: 'CMP-MONTH', codAutorizacion: 'AUT-MONTH', status: 'enviado', errorMessage: null, sentBy: SENT_BY_UID,
      });

      const sent = await repo.findSentByDocumentAndMonth(DNI, 'AT', '2026-09-01');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        serviceDate: '2026-09-18',
        numeroComprobante: 'CMP-MONTH',
        codAutorizacion: 'AUT-MONTH',
        sentBy: SENT_BY_UID,
        sentByName: SENT_BY_NAME,
      });
    });

    it('findSentByDocumentAndMonth NUNCA devolve tentativas duplicado/erro, nem de outro mês', async () => {
      await repo.insert({
        patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-09-18', hours: 1,
        numeroComprobante: null, codAutorizacion: null, status: 'duplicado', errorMessage: null, sentBy: SENT_BY_UID,
      });
      await repo.insert({
        patientId, documentNumber: DNI, serviceType: 'AT', serviceDate: '2026-08-18', hours: 4,
        numeroComprobante: 'CMP-AGOSTO', codAutorizacion: 'AUT-AGOSTO', status: 'enviado', errorMessage: null, sentBy: SENT_BY_UID,
      });

      const sent = await repo.findSentByDocumentAndMonth(DNI, 'AT', '2026-09-01');
      expect(sent).toEqual([]);
    });

    it('findSentByDocumentAndMonth devolve sentByName=null quando sent_by é NULL (linha anterior à migration 473)', async () => {
      // Grava direto por SQL, contornando o repositório — simula uma linha da era pré-473.
      await pool.query(
        `INSERT INTO axonico_comprobante_lancamento
           (patient_id, document_number, service_type, service_date, hours, numero_comprobante, cod_autorizacion, status, sent_by)
         VALUES ($1, $2, 'AT', '2026-09-05', 2, 'CMP-LEGACY', 'AUT-LEGACY', 'enviado', NULL)`,
        [patientId, DNI],
      );

      const sent = await repo.findSentByDocumentAndMonth(DNI, 'AT', '2026-09-01');
      expect(sent).toHaveLength(1);
      expect(sent[0].sentBy).toBeNull();
      expect(sent[0].sentByName).toBeNull();
    });
  });
});
