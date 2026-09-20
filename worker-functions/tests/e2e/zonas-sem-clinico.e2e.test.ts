import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { TEXTO_CLINICO, esperaSemVazamentoClinico } from '@modules/matching/__tests__/guardaVazamentoClinico';

/**
 * `GET /api/admin/recruitment/zones` contra Postgres REAL — B4 do gate.
 *
 * ⚠️ Por que este arquivo existe, se já há guarda unit: a unit afirma sobre o
 * TEXTO do SQL, e texto é adivinhação de nome de coluna. O gate provou que ela
 * ficava verde com `json_build_object(…)::jsonb || to_jsonb(p)` arrastando a
 * linha inteira de `patients`. Aqui a asserção é sobre o que ATRAVESSA a
 * fronteira — o corpo da resposta — e nenhuma projeção anônima escapa dela,
 * porque não depende de saber como a coluna se chama.
 *
 * ⚠️ A fixture carrega dado clínico REAL (`TEXTO_CLINICO`, o canário da guarda
 * compartilhada) e nome de paciente. Guarda com fixture limpa não prova nada.
 *
 * ⚠️ Sem mock: banco de verdade, HTTP de verdade. O controller é o de produção.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const NOME_PACIENTE = 'Rosario';
const ZONA = 'ZonaE2ESemClinico';
/** `job_postings.case_number` é INTEIRO (medido em `\\d job_postings`), não texto. */
const CASO = 990001;

describe('a análise de zonas não devolve dado clínico (banco e HTTP reais)', () => {
  let pool: Pool;
  let url: string;
  let servidor: import('http').Server;
  let patientId: string;

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM job_postings WHERE case_number = $1`, [CASO]);
    await pool.query(`DELETE FROM patients WHERE zone_neighborhood = $1`, [ZONA]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    const p = await pool.query(
      `INSERT INTO patients (first_name, last_name, diagnosis, zone_neighborhood)
         VALUES ($1, 'Sobrenome', $2, $3) RETURNING id`,
      [NOME_PACIENTE, TEXTO_CLINICO, ZONA],
    );
    patientId = p.rows[0].id;
    await pool.query(
      `INSERT INTO job_postings (case_number, title, status, patient_id)
         VALUES ($1, 'Caso e2e zonas', 'SEARCHING', $2)`,
      [CASO, patientId],
    );

    process.env.DATABASE_URL = DATABASE_URL;
    const { RecruitmentAnalyticsController } = await import(
      '@modules/matching/interfaces/controllers/RecruitmentAnalyticsController'
    );
    const controller = new RecruitmentAnalyticsController();

    const app = express();
    // Sem guard de papel: o que este arquivo mede é o CORPO, não a autorização
    // (essa é a `permission-enforcement-analytics-recruitment`). Montar o guard
    // aqui só esconderia a resposta atrás de um 403 e o teste provaria nada.
    app.get('/api/admin/recruitment/zones', (req, res) => controller.getZoneAnalysis(req, res));
    servidor = app.listen(0);
    await new Promise<void>((r) => servidor.once('listening', () => r()));
    url = `http://127.0.0.1:${(servidor.address() as import('net').AddressInfo).port}`;
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((r) => servidor?.close(() => r()));
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await pool.end();
  });

  it('🔴 o corpo INTEIRO não contém diagnóstico — nem por campo nomeado, nem arrastado', async () => {
    const res = await request(url).get('/api/admin/recruitment/zones').expect(200);

    // A asserção não sabe o nome de nenhuma coluna: serializa TUDO e procura o
    // canário. É isso que alcança `to_jsonb`, que a guarda unit não alcançava.
    esperaSemVazamentoClinico(res.body);
  });

  it('🔴 o nome do paciente também não atravessa', async () => {
    const res = await request(url).get('/api/admin/recruitment/zones').expect(200);

    expect(JSON.stringify(res.body)).not.toContain(NOME_PACIENTE);
  });

  it('a fixture ESTÁ no banco com o dado proibido — senão os dois casos acima passam por vácuo', async () => {
    // Controle positivo do próprio teste: `not.toContain` sobre base vazia é
    // verde que não prova nada (contagem zero é falha, nunca sucesso).
    const r = await pool.query(
      `SELECT p.diagnosis, p.first_name FROM patients p WHERE p.id = $1`,
      [patientId],
    );

    expect(r.rowCount).toBe(1);
    expect(r.rows[0].diagnosis).toBe(TEXTO_CLINICO);
    expect(r.rows[0].first_name).toBe(NOME_PACIENTE);
  });

  it('e a rota devolve o caso semeado — a zona aparece com a contagem certa', async () => {
    // Controle positivo do OUTRO lado: se a rota não devolvesse nada, os dois
    // primeiros casos também passariam.
    const res = await request(url).get('/api/admin/recruitment/zones').expect(200);

    const zona = (res.body.data.zones as Array<{ zone: string; caseCount: number; cases: unknown[] }>)
      .find((z) => z.zone === ZONA);

    expect(zona).toBeDefined();
    expect(zona?.caseCount).toBe(1);
    expect(zona?.cases).toEqual([
      { case_number: CASO, task_name: 'Caso e2e zonas', status: 'SEARCHING' },
    ]);
  });
});
