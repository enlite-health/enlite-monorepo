/**
 * 058a-vinculo.e2e.test.ts @integration — spec 058 Parte A (T091): travas de BANCO do vínculo serviço → contrato (migration 537).
 *
 * Postgres REAL, sem mock. T1 (regras do vínculo novo e isenção do escritor por carimbo de banco), T2 (dois pagadores), T3 (serviço não muda de
 * paciente/país com E5) e o EXCLUDE de E5. Nomes casam com as linhas SABOTAGEM de tasks.md T027:
 *   `-t "T1 recusa"` (6) · `-t "T1 permite"` (0 falhas) · `-t "T1 permite escritor"` (4) · `-t "SWITCHED outro pagador"` (1) ·
 *   `-t "isenção por serviço"` (1) · `-t "T2"` (1) · `-t "T3 recusa"` (2) · `-t "T3 sem E5"` (0) · `-t "E5 sobreposição"` (1) · `-t "E5 serviços distintos"` (0).
 * ATENÇÃO nos nomes: só o teste de T2 leva "T2" no título; só os 6 de recusa levam "T1 recusa".
 *
 * Parte API/HTTP (rotas de vínculo, SAME_START, 5 casos 23505 → 409, retry 40P01 → 409): fora desta rodada (it.todo no fim).
 */
import { Pool } from 'pg';
import {
  criarContrato, criarPagador, criarPaciente, criarServico, emTransacao, erroDe, limpar, marcar, novoPool, vigencia, vincular,
} from './helpers/contrato058aDb';

describe('058a vínculo serviço → contrato — travas de banco (537) @integration', () => {
  let pool: Pool;
  let provA = ''; let provB = '';
  let cA1 = ''; let cA2 = ''; let cB1 = ''; let cA_BR = '';
  let patient = '';
  let s1 = ''; let s2 = '';

  beforeAll(async () => { pool = novoPool(); await limpar(pool); });
  beforeEach(async () => {
    await limpar(pool);
    provA = await criarPagador(pool, 'OBRA_SOCIAL');
    provB = await criarPagador(pool, 'PREPAGA');
    cA1 = await criarContrato(pool, provA);
    cA2 = await criarContrato(pool, provA);
    cB1 = await criarContrato(pool, provB);
    cA_BR = await criarContrato(pool, provA, 'BR');
    patient = await criarPaciente(pool, 'AR');
    s1 = await criarServico(pool, patient);
    s2 = await criarServico(pool, patient);
  });
  afterAll(async () => { await limpar(pool); await pool.end(); });

  const vivas = async (service: string): Promise<number> =>
    (await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM contracted_service_contract WHERE contracted_service_id = $1 AND superseded_at IS NULL', [service])).rows[0].n;

  /** `supersede` do escritor: marca a viva, reinsere o trecho anterior e insere a nova (tudo na mesma transação). */
  const supersede = (service: string, viva: string, reason: 'SWITCHED' | 'CORRECTION', anterior: { contract: string; valid: string } | null,
    nova: { contract: string; valid: string }): Promise<void> =>
    emTransacao(pool, async (c) => {
      await marcar(c, viva, reason);
      if (anterior) await vincular(c, service, anterior.contract, anterior.valid);
      await vincular(c, service, nova.contract, nova.valid);
    });

  /** `end` do escritor: marca a viva `ENDED` e reinsere `[lower, fim)`. */
  const encerrar = (service: string, viva: string, contract: string, valid: string): Promise<void> =>
    emTransacao(pool, async (c) => { await marcar(c, viva, 'ENDED'); await vincular(c, service, contract, valid); });

  describe('T1 recusa — vínculo NOVO (POST) sobre histórico', () => {
    it('T1 recusa: 2º POST com 1 viva e sem histórico → USE_CORRECTION', async () => {
      await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      const e = await erroDe(() => vincular(pool, s1, cA2, vigencia('2027-01-01')));
      expect(e?.message).toContain('USE_CORRECTION');
      expect(await vivas(s1)).toBe(1);
    });

    it('T1 recusa: POST com ENDED no histórico → REQUIRES_NEW_SERVICE (ENDED é terminal)', async () => {
      const l1 = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      await encerrar(s1, l1, cA1, vigencia('2026-01-01', '2026-03-01'));
      const e = await erroDe(() => vincular(pool, s1, cA2, vigencia('2026-06-01')));
      expect(e?.message).toContain('REQUIRES_NEW_SERVICE');
    });

    it('T1 recusa: POST com SWITCHED no histórico → REQUIRES_NEW_SERVICE', async () => {
      const l1 = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      await supersede(s1, l1, 'SWITCHED', { contract: cA1, valid: vigencia('2026-01-01', '2026-03-01') }, { contract: cA2, valid: vigencia('2026-03-01') });
      const e = await erroDe(() => vincular(pool, s1, cA2, vigencia('2027-01-01')));
      expect(e?.message).toContain('REQUIRES_NEW_SERVICE');
    });

    it('T1 recusa: 2 vivas → REQUIRES_NEW_SERVICE', async () => {
      // duas linhas na MESMA transação: ambas são "da transação corrente" e ficam fora das contagens do próprio INSERT
      await emTransacao(pool, async (c) => {
        await vincular(c, s1, cA1, vigencia('2026-01-01', '2026-02-01'));
        await vincular(c, s1, cA1, vigencia('2026-04-01', '2026-05-01'));
      });
      expect(await vivas(s1)).toBe(2);
      const e = await erroDe(() => vincular(pool, s1, cA2, vigencia('2027-01-01')));
      expect(e?.message).toContain('REQUIRES_NEW_SERVICE');
    });

    it('T1 recusa: corrida de 2 transações — a segunda espera o lock do paciente, relê e recusa USE_CORRECTION', async () => {
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        await vincular(a, s1, cA1, vigencia('2026-01-01')); // segura o lock do paciente até o COMMIT
        await b.query('BEGIN');
        let terminou = false;
        const pb = erroDe(() => vincular(b, s1, cA2, vigencia('2027-01-01'))).then((e) => { terminou = true; return e; });
        await new Promise((r) => setTimeout(r, 400));
        expect(terminou).toBe(false); // prova de que B estava de fato bloqueado no lock, não só atrasado
        await a.query('COMMIT');
        const e = await pb;
        expect(e?.message).toContain('USE_CORRECTION');
      } finally {
        await b.query('ROLLBACK').catch(() => undefined);
        a.release(); b.release();
      }
      expect(await vivas(s1)).toBe(1);
    });

    it('T1 recusa: contrato de país diferente do serviço → COUNTRY_MISMATCH', async () => {
      const e = await erroDe(() => vincular(pool, s1, cA_BR, vigencia('2026-01-01')));
      expect(e?.message).toContain('COUNTRY_MISMATCH');
      expect(await vivas(s1)).toBe(0);
    });
  });

  describe('T1 permite — positivos do vínculo novo', () => {
    it('T1 permite: o primeiro vínculo do serviço', async () => {
      await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      expect(await vivas(s1)).toBe(1);
    });

    it('T1 permite: só CORRECTION no histórico e nenhuma viva', async () => {
      const l1 = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      await emTransacao(pool, (c) => marcar(c, l1, 'CORRECTION')); // corrigida e não substituída: 0 vivas
      expect(await vivas(s1)).toBe(0);
      await vincular(pool, s1, cB1, vigencia('2026-01-01'));
      expect(await vivas(s1)).toBe(1);
    });

    it('T1 permite: dois INSERTs na mesma transação (as linhas da transação corrente não contam)', async () => {
      await emTransacao(pool, async (c) => {
        await vincular(c, s1, cA1, vigencia('2026-01-01', '2026-02-01'));
        await vincular(c, s1, cA1, vigencia('2026-02-01'));
      });
      expect(await vivas(s1)).toBe(2);
    });

    it('T1 permite: o 1º vínculo de um 2º serviço do mesmo paciente e do mesmo pagador', async () => {
      await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      await vincular(pool, s2, cA2, vigencia('2026-01-01'));
      expect([await vivas(s1), await vivas(s2)]).toEqual([1, 1]);
    });
  });

  describe('T1 permite escritor — isenção por carimbo de banco (superseded_xact da transação corrente)', () => {
    it('T1 permite escritor: supersede SWITCHED para outro contrato do MESMO pagador', async () => {
      const l1 = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      await supersede(s1, l1, 'SWITCHED', { contract: cA1, valid: vigencia('2026-01-01', '2026-03-01') }, { contract: cA2, valid: vigencia('2026-03-01') });
      expect(await vivas(s1)).toBe(2);
    });

    it('T1 permite escritor: supersede CORRECTION (qualquer pagador) de uma viva quando o serviço tem OUTRA viva', async () => {
      const [, l2] = await emTransacao(pool, async (c) => [
        await vincular(c, s1, cA1, vigencia('2026-01-01', '2026-02-01')),
        await vincular(c, s1, cA1, vigencia('2026-04-01', '2026-05-01')),
      ]);
      expect(await vivas(s1)).toBe(2);
      await supersede(s1, l2, 'CORRECTION', null, { contract: cB1, valid: vigencia('2026-04-01', '2026-05-01') });
      expect(await vivas(s1)).toBe(2);
      expect((await pool.query('SELECT contract_id FROM contracted_service_contract WHERE contracted_service_id = $1 AND superseded_at IS NULL AND lower(valid) = \'2026-04-01\'', [s1])).rows[0].contract_id).toBe(cB1);
    });

    it('T1 permite escritor: end (marca ENDED e reinsere o trecho fechado do mesmo pagador)', async () => {
      const l1 = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      await encerrar(s1, l1, cA1, vigencia('2026-01-01', '2026-04-01'));
      expect(await vivas(s1)).toBe(1);
    });

    it('T1 permite escritor: end e CORRECTION sobre a viva DEPOIS de um SWITCHED', async () => {
      const l1 = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      await supersede(s1, l1, 'SWITCHED', { contract: cA1, valid: vigencia('2026-01-01', '2026-03-01') }, { contract: cA2, valid: vigencia('2026-03-01') });
      const aberta = (await pool.query<{ id: string }>(
        'SELECT id FROM contracted_service_contract WHERE contracted_service_id = $1 AND superseded_at IS NULL AND upper_inf(valid)', [s1])).rows[0].id;
      await supersede(s1, aberta, 'CORRECTION', { contract: cA2, valid: vigencia('2026-03-01', '2026-04-01') }, { contract: cB1, valid: vigencia('2026-04-01') });
      const aberta2 = (await pool.query<{ id: string }>(
        'SELECT id FROM contracted_service_contract WHERE contracted_service_id = $1 AND superseded_at IS NULL AND upper_inf(valid)', [s1])).rows[0].id;
      await encerrar(s1, aberta2, cB1, vigencia('2026-04-01', '2026-06-01'));
      expect((await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM contracted_service_contract WHERE contracted_service_id = $1 AND superseded_reason IN ('SWITCHED','CORRECTION','ENDED')`, [s1])).rows[0].n).toBe(3);
    });
  });

  describe('T1 — outros ramos do escritor', () => {
    it('SWITCHED outro pagador: trocar para contrato de OUTRO pagador pelo caminho do escritor → REQUIRES_NEW_SERVICE', async () => {
      const l1 = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      const e = await erroDe(() => supersede(s1, l1, 'SWITCHED', { contract: cA1, valid: vigencia('2026-01-01', '2026-03-01') }, { contract: cB1, valid: vigencia('2026-03-01') }));
      expect(e?.message).toContain('REQUIRES_NEW_SERVICE');
      expect(await vivas(s1)).toBe(1); // a transação inteira voltou: a viva original segue lá
    });

    it('isenção por serviço: marcação no serviço X NÃO isenta um POST no serviço Y (que tem 1 viva) → USE_CORRECTION', async () => {
      const lx = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      await vincular(pool, s2, cA1, vigencia('2026-01-01'));
      const e = await erroDe(() => emTransacao(pool, async (c) => {
        await marcar(c, lx, 'SWITCHED');                       // supersede no serviço X…
        await vincular(c, s2, cA2, vigencia('2027-01-01'));    // …e depois um POST no serviço Y, que tem 1 viva
      }));
      expect(e?.message).toContain('USE_CORRECTION');
    });

    it('ENDED só admite o reinsert fechado: reinsert aberto depois de marcar ENDED → REQUIRES_NEW_SERVICE', async () => {
      const l1 = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      const e = await erroDe(() => encerrar(s1, l1, cA1, vigencia('2026-01-01')));
      expect(e?.message).toContain('REQUIRES_NEW_SERVICE');
    });
  });

  describe('T2 — dois pagadores ao mesmo tempo', () => {
    it('T2 TWO_PAYERS_OVERLAP: outro serviço do paciente com pagador diferente e vigência que se cruza', async () => {
      await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      const e = await erroDe(() => vincular(pool, s2, cB1, vigencia('2026-06-01')));
      expect(e?.message).toContain('TWO_PAYERS_OVERLAP');
      expect(await vivas(s2)).toBe(0);
    });

    it('pagador diferente sem cruzar datas, ou o mesmo pagador, ou OUTRO paciente: aceitos (controles positivos)', async () => {
      await vincular(pool, s1, cA1, vigencia('2026-01-01', '2026-06-01'));
      await vincular(pool, s2, cB1, vigencia('2026-06-01'));                  // outro pagador, vigências vizinhas
      const outro = await criarServico(pool, await criarPaciente(pool, 'AR'));
      await vincular(pool, outro, cB1, vigencia('2026-01-01'));               // outro paciente: sem relação
      expect(await vivas(outro)).toBe(1);
    });
  });

  describe('T3 — o serviço não muda de paciente/país por baixo do vínculo (R6)', () => {
    it('T3 recusa: trocar o patient_id de serviço com linha em E5 (inclusive só superada)', async () => {
      const l1 = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      await emTransacao(pool, (c) => marcar(c, l1, 'CORRECTION')); // só superada, nenhuma viva
      const outro = await criarPaciente(pool, 'AR');
      const e = await erroDe(() => pool.query('UPDATE patient_contracted_services SET patient_id = $2 WHERE id = $1', [s1, outro]));
      expect(e?.message).toContain('SERVICE_HAS_CONTRACT_LINK');
      expect((await pool.query('SELECT patient_id FROM patient_contracted_services WHERE id = $1', [s1])).rows[0].patient_id).toBe(patient);
    });

    it('T3 recusa: trocar o country de serviço com linha em E5', async () => {
      await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      const e = await erroDe(() => pool.query(`UPDATE patient_contracted_services SET country = 'BR' WHERE id = $1`, [s1]));
      expect(e?.message).toContain('SERVICE_HAS_CONTRACT_LINK');
      expect((await pool.query('SELECT country FROM patient_contracted_services WHERE id = $1', [s1])).rows[0].country).toBe('AR');
    });

    it('T3 sem E5: serviço sem nenhuma linha em E5 troca de paciente e de país (positivo)', async () => {
      const outro = await criarPaciente(pool, 'AR');
      await pool.query('UPDATE patient_contracted_services SET patient_id = $2 WHERE id = $1', [s2, outro]);
      await pool.query(`UPDATE patient_contracted_services SET country = 'BR' WHERE id = $1`, [s2]);
      const r = (await pool.query('SELECT patient_id, country FROM patient_contracted_services WHERE id = $1', [s2])).rows[0];
      expect(r).toEqual({ patient_id: outro, country: 'BR' });
    });
  });

  describe('EXCLUDE de E5 (contracted_service_contract_sem_sobreposicao)', () => {
    it('E5 sobreposição: dois INSERTs sobrepostos do mesmo pagador, pelo caminho do escritor → 23P01 (mede o EXCLUDE, não a T1)', async () => {
      const l1 = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      const e = await erroDe(() => emTransacao(pool, async (c) => {
        await marcar(c, l1, 'CORRECTION');                          // linha marcada do MESMO serviço: a T1 fica isenta
        await vincular(c, s1, cA1, vigencia('2026-01-01'));
        await vincular(c, s1, cA1, vigencia('2026-02-01'));         // cruza a anterior, mesmo pagador
      }));
      expect(e?.code).toBe('23P01');
      expect(e?.constraint).toBe('contracted_service_contract_sem_sobreposicao');
    });

    it('E5 serviços distintos: o mesmo pagador em vigências que se cruzam em serviços DIFERENTES, e linhas superadas, não conflitam', async () => {
      await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      await vincular(pool, s2, cA2, vigencia('2026-01-01'));
      expect([await vivas(s1), await vivas(s2)]).toEqual([1, 1]);
      const l = (await pool.query<{ id: string }>('SELECT id FROM contracted_service_contract WHERE contracted_service_id = $1', [s1])).rows[0].id;
      await supersede(s1, l, 'CORRECTION', null, { contract: cA2, valid: vigencia('2026-01-01') }); // a superada cruza a nova e não conflita
      expect(await vivas(s1)).toBe(1);
    });
  });

  describe('imutabilidade de E5 (R2)', () => {
    it('vínculo imutável: contrato, vigência e quem gravou não mudam; o trio é marcado uma única vez', async () => {
      const l1 = await vincular(pool, s1, cA1, vigencia('2026-01-01'));
      const c = await erroDe(() => pool.query('UPDATE contracted_service_contract SET contract_id = $2 WHERE id = $1', [l1, cA2]));
      const v = await erroDe(() => pool.query(`UPDATE contracted_service_contract SET valid = '[2026-02-01,)' WHERE id = $1`, [l1]));
      expect([c?.code, v?.code]).toEqual(['23514', '23514']);
      await emTransacao(pool, (cl) => marcar(cl, l1, 'ENDED'));
      const r = (await pool.query<{ at: boolean; x: boolean }>(
        `SELECT superseded_at IS NOT NULL AS at, superseded_xact IS NOT NULL AS x FROM contracted_service_contract WHERE id = $1`, [l1])).rows[0];
      expect(r).toEqual({ at: true, x: true });
      const de_novo = await erroDe(() => pool.query(`UPDATE contracted_service_contract SET superseded_reason = 'CORRECTION' WHERE id = $1`, [l1]));
      expect(de_novo?.code).toBe('23514');
    });

    it('vínculo: o app não apaga (sem DELETE) e a RLS está ligada na tabela', async () => {
      const r = await pool.query<{ rt: boolean; sys: boolean; rls: boolean }>(
        `SELECT has_table_privilege('app_runtime', 'contracted_service_contract', 'DELETE') AS rt,
                has_table_privilege('app_system',  'contracted_service_contract', 'DELETE') AS sys,
                (SELECT relrowsecurity FROM pg_class WHERE oid = 'contracted_service_contract'::regclass) AS rls`);
      expect(r.rows[0]).toEqual({ rt: false, sys: false, rls: true });
    });
  });

  describe('API/HTTP — TODO rodada futura (A1.3/A1.4)', () => {
    it.todo('POST/PUT /contracted-services/:sid/contract: SAME_START_USE_CORRECTION recusado antes do banco (isSameStart)');
    it.todo('5 casos de 23505/23P01 por constraint (pkey, sort_order_unico, name_uq, tax_id_uq, contracts_name_uq) → 409 com código');
    it.todo('retry de 40P01/40001 em withSerializationRetry → 409 depois de 3 tentativas');
    it.todo('mapa de erro: REQUIRES_NEW_SERVICE / USE_CORRECTION / TWO_PAYERS_OVERLAP / COUNTRY_MISMATCH → 409/422 do §K');
  });
});
