/**
 * anacare-email-alias.e2e.test.ts
 *
 * E2E do fallback de ALIAS de e-mail, com Postgres REAL (enlite_e2e) e o AnaCare
 * substituído por um servidor HTTP local (padrão da casa — nunca canal real).
 *
 * O QUE ESTE ARQUIVO PROVA, e o unit não prova:
 * que o alias chega ao BANCO. O provider pode devolver `emailAliasUsed` certinho
 * e o `UPDATE` gravar em coluna errada, ou não gravar — só a linha real responde.
 *
 * Contexto (18/08/2026): o Ana Care exige e-mail único no SISTEMA INTEIRO, mas a
 * nossa chave só enxerga a nossa agência. Quando a pessoa já está cadastrada em
 * outra empresa, o POST é recusado e o prestador nunca chega lá — não entra em
 * caso e não é alocado. A saída acordada é criar com `+1`, que cai na mesma caixa,
 * e marcar o cadastro para a coordenação resolver depois.
 */

import http from 'http';
import { Pool } from 'pg';
import { MirrorWorkerService, isAnaCareIdClaimed } from '../../src/modules/integration/application/MirrorWorkerService';
import { AnaCareMirrorProvider } from '../../src/modules/integration/infrastructure/anacare/AnaCareMirrorProvider';
import { AnaCareClient } from '../../src/modules/integration/infrastructure/anacare/AnaCareClient';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const MOCK_PORT = 29996; // 29997/29998/29999 já usados por outros e2e
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}`;

const BODY_400_EMAIL =
  '{"email":["No es posible usar este correo electrónico para el registro."]}';

interface MockState {
  /** Todo POST que chegou, na ordem — é o que as asserções leem. */
  postEmails: string[];
  /** E-mails que o "sistema" considera já em uso (por outra empresa). */
  emailsTomados: Set<string>;
  nextId: number;
}

function createAnaCareServer(state: MockState): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      if (req.url === '/api/v2/agencies/nurse-types/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: 1, next: null, previous: null, results: [{ id: 1, name: 'Acompañante Terapéutico' }] }));
        return;
      }
      if (req.url === '/api/v2/agencies/hiring-types/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: 0, next: null, previous: null, results: [] }));
        return;
      }
      // Listagem vazia: a pessoa NÃO está na nossa agência (é o caso real).
      if (req.url?.startsWith('/api/v2/agencies/nurses/?') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: 0, next: null, previous: null, results: [] }));
        return;
      }
      if (req.url === '/api/v2/agencies/nurses/' && req.method === 'POST') {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const email = String(body.email ?? '');
        state.postEmails.push(email);
        if (state.emailsTomados.has(email)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(BODY_400_EMAIL);
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: state.nextId++, nombre: body.nombre, apellidos: body.apellidos, genero: body.genero, email }));
        return;
      }
      // PATCH de quem já tem id — usado para provar que a marca DESLIGA.
      const patch = req.url?.match(/^\/api\/v2\/agencies\/nurses\/(\d+)\/$/) ?? null;
      if (patch && req.method === 'PATCH') {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const email = String(body.email ?? '');
        if (email && state.emailsTomados.has(email)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(BODY_400_EMAIL);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: parseInt(patch[1], 10), nombre: body.nombre, apellidos: body.apellidos, genero: body.genero, email }));
        return;
      }

      res.writeHead(404); res.end('{}');
    });
  });
}

describe('espelho Ana Care — alias de e-mail quando a pessoa já existe em outra empresa', () => {
  let pool: Pool;
  let mockServer: http.Server;
  let state: MockState;
  let service: MirrorWorkerService;
  const workerIds: string[] = [];

  const enc = (v: string) => Buffer.from(v, 'utf8').toString('base64');

  beforeAll(async () => {
    state = { postEmails: [], emailsTomados: new Set(), nextId: 9001 };
    mockServer = createAnaCareServer(state);
    await new Promise<void>(r => mockServer.listen(MOCK_PORT, r));

    process.env.ANACARE_API_KEY = 'ana_care.test.email-alias';
    process.env.ANACARE_BASE_URL = MOCK_BASE_URL;

    pool = new Pool({ connectionString: DATABASE_URL });
    const provider = new AnaCareMirrorProvider(AnaCareClient.fromEnv(), {
      isExternalIdClaimed: isAnaCareIdClaimed,
    });
    service = new MirrorWorkerService(provider);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE 'alias-e2e-%'`);
    await pool.end();
    await new Promise<void>(r => mockServer.close(() => r()));
  });

  beforeEach(() => {
    state.postEmails = [];
    state.emailsTomados = new Set();
  });

  async function seed(slug: string, email: string, extra: { merged?: boolean } = {}): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, phone, occupation,
                            first_name_encrypted, last_name_encrypted, sex_encrypted)
       VALUES ($1, $2, 'REGISTERED', 'AR', $3, 'AT', $4, $5, $6)
       RETURNING id`,
      [`alias-e2e-${slug}`, email, `54911000${slug.slice(0, 5).padEnd(5, '0')}`,
       enc('Nelida'), enc('Troche'), enc('FEMALE')],
    );
    const id = rows[0].id;
    workerIds.push(id);
    if (extra.merged) {
      const { rows: s } = await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, status, country,
                              first_name_encrypted, last_name_encrypted, sex_encrypted)
         VALUES ($1, $2, 'REGISTERED', 'AR', $3, $4, $5) RETURNING id`,
        [`alias-e2e-${slug}-surv`, `surv-${slug}@example.com`, enc('Nelida'), enc('Troche'), enc('FEMALE')],
      );
      workerIds.push(s[0].id);
      await pool.query(`UPDATE workers SET merged_into_id = $2 WHERE id = $1`, [id, s[0].id]);
    }
    return id;
  }

  it('grava ana_care_id E a marca do alias na LINHA quando o e-mail real está tomado', async () => {
    const email = 'nelida.alias1@example.com';
    const id = await seed('c1', email);
    state.emailsTomados.add(email); // já pertence a outra empresa

    const result = await service.mirrorOne(id);

    expect(result).toBe('created');
    expect(state.postEmails).toEqual([email, 'nelida.alias1+1@example.com']);

    const { rows } = await pool.query(
      `SELECT ana_care_id, ana_care_email_alias, ana_care_sync_error FROM workers WHERE id = $1`, [id]);
    expect(rows[0].ana_care_id).toBe('9001');
    expect(rows[0].ana_care_email_alias).toBe('nelida.alias1+1@example.com');
    expect(rows[0].ana_care_sync_error).toBeNull();
  });

  it('sem conflito, a marca fica NULL — só quem precisa de resolução entra na fila', async () => {
    const id = await seed('c2', 'nelida.livre@example.com');

    await service.mirrorOne(id);

    const { rows } = await pool.query(
      `SELECT ana_care_id, ana_care_email_alias FROM workers WHERE id = $1`, [id]);
    expect(rows[0].ana_care_id).not.toBeNull();
    expect(rows[0].ana_care_email_alias).toBeNull();
    expect(state.postEmails).toEqual(['nelida.livre@example.com']);
  });

  it('anda até o +2 quando o +1 também está tomado', async () => {
    const email = 'nelida.alias3@example.com';
    const id = await seed('c3', email);
    state.emailsTomados.add(email);
    state.emailsTomados.add('nelida.alias3+1@example.com');

    await service.mirrorOne(id);

    const { rows } = await pool.query(`SELECT ana_care_email_alias FROM workers WHERE id = $1`, [id]);
    expect(rows[0].ana_care_email_alias).toBe('nelida.alias3+2@example.com');
  });

  it('cadastro FUNDIDO não vira duplicata: nenhum POST sai e a linha segue sem id', async () => {
    const email = 'nelida.fundida@example.com';
    const id = await seed('c4', email, { merged: true });
    state.emailsTomados.add(email);

    const result = await service.mirrorOne(id);

    expect(result).toBe('skipped');
    expect(state.postEmails).toEqual([]);
    const { rows } = await pool.query(
      `SELECT ana_care_id, ana_care_email_alias FROM workers WHERE id = $1`, [id]);
    expect(rows[0].ana_care_id).toBeNull();
    expect(rows[0].ana_care_email_alias).toBeNull();
  });

  it('a marca DESLIGA quando um sync posterior consegue usar o e-mail real', async () => {
    const email = 'nelida.desliga@example.com';
    const id = await seed('c5', email);
    state.emailsTomados.add(email);
    await service.mirrorOne(id); // nasce com alias

    let { rows } = await pool.query(`SELECT ana_care_email_alias FROM workers WHERE id = $1`, [id]);
    expect(rows[0].ana_care_email_alias).toBe('nelida.desliga+1@example.com');

    // O e-mail foi liberado do lado deles e o worker volta a sincronizar (PATCH).
    state.emailsTomados.delete(email);
    await service.mirrorOne(id);

    ({ rows } = await pool.query(`SELECT ana_care_email_alias FROM workers WHERE id = $1`, [id]));
    expect(rows[0].ana_care_email_alias).toBeNull();
  });
});
