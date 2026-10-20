/**
 * 058a-vinculo.e2e.test.ts @integration — spec 058 Parte A (T091): travas de BANCO do vínculo serviço → contrato (migration 537).
 *
 * Postgres REAL, sem mock. T1 (regras do vínculo novo e isenção do escritor por carimbo de banco), T2 (dois pagadores), T3 (serviço não muda de
 * paciente/país com E5) e o EXCLUDE de E5. Nomes casam com as linhas SABOTAGEM de tasks.md T027:
 *   `-t "T1 recusa"` (6) · `-t "T1 permite"` (0 falhas) · `-t "T1 permite escritor"` (4) · `-t "SWITCHED outro pagador"` (1) ·
 *   `-t "isenção por serviço"` (1) · `-t "T2"` (1) · `-t "T3 recusa"` (2) · `-t "T3 sem E5"` (0) · `-t "E5 sobreposição"` (1) · `-t "E5 serviços distintos"` (0).
 * ATENÇÃO nos nomes: só o teste de T2 leva "T2" no título; só os 6 de recusa levam "T1 recusa".
 *
 * Parte API/HTTP (A1.4, rotas reais de vínculo, SAME_START, mapa de erro do §K, 5 casos 23505 → 409): bloco `API/HTTP` no fim. O retry de 40P01 → 409
 * fica como `it.todo` (um deadlock real não é determinístico por HTTP; o retry é provado no unit do escritor e o 409 no mapa de erros).
 */
import { Pool } from 'pg';
import {
  criarContrato, criarPagador, criarPaciente, criarServico, emTransacao, erroDe, limpar, marcar, novoPool, vigencia, vincular,
} from './helpers/contrato058aDb';
import { api, atores, BASE, sufixo, concederPaises } from './helpers/contrato058aApi';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';

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

  describe('API/HTTP — rotas reais (A1.4)', () => {
    let admin: StaffAuth;
    beforeAll(async () => { ({ admin } = await atores()); });

    const link = (service = s1) => `${BASE}/patients/${patient}/contracted-services/${service}/contract-link`;
    const vivosDe = async (service: string): Promise<Array<{ contract: string; valid: string }>> =>
      (await pool.query<{ contract: string; valid: string }>(
        `SELECT contract_id AS contract, valid::text AS valid FROM contracted_service_contract
          WHERE contracted_service_id = $1 AND superseded_at IS NULL ORDER BY valid`, [service])).rows;
    const termo = (contract: string, rate = 1500, tax = 21): Promise<unknown> =>
      pool.query(`INSERT INTO insurance_contract_terms (contract_id, hourly_rate, tax_rate_percent, valid, recorded_by) VALUES ($1, $2, $3, '[2020-01-01,)', 'qa058a')`, [contract, rate, tax]);

    it('vínculo novo: 201 devolve o serviço projetado (pagador, preço e imposto vêm dos leitores em lote) e o vínculo está vivo', async () => {
      await termo(cA1);
      const r = await api.post(link(), { contractId: cA1, validFrom: '2020-01-01' }, admin);
      expect(r.status).toBe(201);
      expect(r.data.data.payer).toMatchObject({ state: 'LINKED', isPrivate: false, validFrom: '2020-01-01', validTo: null });
      expect(r.data.data.payer.names).toMatchObject({ providerCode: provA, contractId: cA1, payerKind: 'OBRA_SOCIAL' });
      expect(r.data.data.price).toEqual({ state: 'OK', hourlyRate: 1500, currency: 'ARS' });
      expect(r.data.data.tax).toEqual({ state: 'OK', taxRatePercent: 21 });
      expect(await vivosDe(s1)).toEqual([{ contract: cA1, valid: '[2020-01-01,)' }]);
    });

    it('SAME_START: troca (SWITCHED) com validFrom igual ao início do vivo → 422 SAME_START_USE_CORRECTION antes do banco; nada muda', async () => {
      await api.post(link(), { contractId: cA1, validFrom: '2020-01-01' }, admin);
      const r = await api.post(`${link()}/supersede`, { reason: 'SWITCHED', contractId: cA2, validFrom: '2020-01-01' }, admin);
      expect(r.status).toBe(422);
      expect(r.data.code).toBe('SAME_START_USE_CORRECTION');
      expect(await vivosDe(s1)).toEqual([{ contract: cA1, valid: '[2020-01-01,)' }]);
      expect((await pool.query("SELECT count(*)::int AS n FROM contracted_service_contract WHERE contracted_service_id = $1 AND superseded_reason IS NOT NULL", [s1])).rows[0].n).toBe(0);
      // CORRECTION no mesmo início é correção legítima: troca o contrato inteiro
      const corr = await api.post(`${link()}/supersede`, { reason: 'CORRECTION', contractId: cA2, validFrom: '2020-01-01' }, admin);
      expect(corr.status).toBe(200);
      expect(await vivosDe(s1)).toEqual([{ contract: cA2, valid: '[2020-01-01,)' }]);
    });

    it('troca (SWITCHED) no mesmo pagador re-insere o trecho anterior; encerrar (end) fecha o vigente com validTo inclusivo', async () => {
      await api.post(link(), { contractId: cA1, validFrom: '2020-01-01' }, admin);
      const troca = await api.post(`${link()}/supersede`, { reason: 'SWITCHED', contractId: cA2, validFrom: '2024-06-01' }, admin);
      expect(troca.status).toBe(200);
      expect(await vivosDe(s1)).toEqual([{ contract: cA1, valid: '[2020-01-01,2024-06-01)' }, { contract: cA2, valid: '[2024-06-01,)' }]);
      const fim = await api.post(`${link()}/end`, { validTo: '2025-12-31' }, admin);
      expect(fim.status).toBe(200);
      expect(await vivosDe(s1)).toEqual([{ contract: cA1, valid: '[2020-01-01,2024-06-01)' }, { contract: cA2, valid: '[2024-06-01,2026-01-01)' }]);
      const razoes = (await pool.query<{ superseded_reason: string }>(
        `SELECT superseded_reason FROM contracted_service_contract WHERE contracted_service_id = $1 AND superseded_at IS NOT NULL ORDER BY superseded_reason`, [s1])).rows;
      expect(razoes.map((x) => x.superseded_reason)).toEqual(['ENDED', 'SWITCHED']);
      // o carimbo de quem/quando é do banco, e quem marcou é o ator
      const m = (await pool.query<{ superseded_by: string; carimbado: boolean }>(
        `SELECT superseded_by, superseded_at IS NOT NULL AND superseded_xact IS NOT NULL AS carimbado FROM contracted_service_contract WHERE contracted_service_id = $1 AND superseded_reason = 'ENDED'`, [s1])).rows[0];
      expect(m).toEqual({ superseded_by: admin.uid, carimbado: true });
    });

    it('mapa de erro do §K: REQUIRES_NEW_SERVICE / USE_CORRECTION / TWO_PAYERS_OVERLAP / COUNTRY_MISMATCH → 422 com o próprio código', async () => {
      // USE_CORRECTION: 2º vínculo novo com exatamente 1 viva e sem histórico
      expect((await api.post(link(), { contractId: cA1, validFrom: '2020-01-01' }, admin)).status).toBe(201);
      const uc = await api.post(link(), { contractId: cA2, validFrom: '2025-01-01' }, admin);
      expect([uc.status, uc.data.code]).toEqual([422, 'USE_CORRECTION']);
      // REQUIRES_NEW_SERVICE: depois de ENDED o serviço não aceita vínculo novo; e SWITCHED para OUTRO pagador também não
      const trocaOutro = await api.post(`${link()}/supersede`, { reason: 'SWITCHED', contractId: cB1, validFrom: '2024-01-01' }, admin);
      expect([trocaOutro.status, trocaOutro.data.code]).toEqual([422, 'REQUIRES_NEW_SERVICE']);
      expect((await api.post(`${link()}/end`, { validTo: '2024-12-31' }, admin)).status).toBe(200);
      const novo = await api.post(link(), { contractId: cA2, validFrom: '2025-06-01' }, admin);
      expect([novo.status, novo.data.code]).toEqual([422, 'REQUIRES_NEW_SERVICE']);
      // COUNTRY_MISMATCH: contrato BR em serviço AR
      const cm = await api.post(link(s2), { contractId: cA_BR, validFrom: '2020-01-01' }, admin);
      expect([cm.status, cm.data.code]).toEqual([422, 'COUNTRY_MISMATCH']);
      // TWO_PAYERS_OVERLAP: o s2 do MESMO paciente com OUTRO pagador, no mesmo período em que o s1 ainda é vivo (ENDED fechou em 2024-12-31)
      const dois = await api.post(link(s2), { contractId: cB1, validFrom: '2024-06-01' }, admin);
      expect([dois.status, dois.data.code]).toEqual([422, 'TWO_PAYERS_OVERLAP']);
      // nada foi gravado pelas recusas (a transação inteira voltou)
      expect(await vivosDe(s2)).toEqual([]);
    });

    it('404: serviço de OUTRO paciente, serviço inexistente e contrato inexistente não gravam nada', async () => {
      const outro = await criarPaciente(pool, 'AR');
      const r1 = await api.post(`${BASE}/patients/${outro}/contracted-services/${s1}/contract-link`, { contractId: cA1, validFrom: '2020-01-01' }, admin);
      expect([r1.status, r1.data.code]).toEqual([404, 'SERVICE_NOT_FOUND']);
      const r2 = await api.post(link(), { contractId: '00000000-0000-4000-8000-000000000000', validFrom: '2020-01-01' }, admin);
      expect([r2.status, r2.data.code]).toEqual([404, 'CONTRACT_NOT_FOUND']);
      const r3 = await api.post(`${link()}/end`, { validTo: '2025-01-01' }, admin);
      expect([r3.status, r3.data.code]).toEqual([404, 'NO_LIVE_LINK']);
      expect(await vivosDe(s1)).toEqual([]);
    });

    it('5 casos de 23505 por constraint (pkey, sort_order_unico, name_uq, tax_id_uq, contracts_name_uq) → 409 com código', async () => {
      const nome = `QA058 API ${sufixo()}`;
      const code = `QA058_${sufixo()}`;
      const criado = await api.post(`${BASE}/catalogs/insurance-providers`, { name: nome, code }, admin);
      expect(criado.status).toBe(201);
      // 1) pkey do código
      const pkey = await api.post(`${BASE}/catalogs/insurance-providers`, { name: `${nome} outro`, code }, admin);
      expect([pkey.status, pkey.data.code]).toEqual([409, 'INSURANCE_PROVIDER_CODE_EXISTS']);
      // 2) posição ocupada (sort_order_unico)
      const sort = await api.post(`${BASE}/catalogs/insurance-providers`, { name: `${nome} dois`, code: `${code}_2`, sortOrder: criado.data.data.sortOrder }, admin);
      expect([sort.status, sort.data.code]).toEqual([409, 'INSURANCE_PROVIDER_SORT_ORDER_TAKEN']);
      // 3) nome (sem caixa/espaços das pontas)
      const dupNome = await api.post(`${BASE}/catalogs/insurance-providers`, { name: `  ${nome.toLowerCase()} `, code: `${code}_3` }, admin);
      expect([dupNome.status, dupNome.data.code]).toEqual([409, 'INSURANCE_PROVIDER_NAME_EXISTS']);
      // 4) CUIT/CNPJ: o valor não volta na resposta
      const outra = await criarPagador(pool, 'OBRA_SOCIAL');
      expect((await api.patch(`${BASE}/insurance-providers/${code}`, { taxId: '30-70123456-9' }, admin)).status).toBe(200);
      const tax = await api.patch(`${BASE}/insurance-providers/${outra}`, { taxId: '30-70123456-9' }, admin);
      expect([tax.status, tax.data.code]).toEqual([409, 'INSURANCE_PROVIDER_TAX_ID_EXISTS']);
      expect(JSON.stringify(tax.data)).not.toContain('30-70123456-9');
      // 5) nome de contrato por pagador
      const body = { name: 'Plan Unico', country: 'AR', firstTerm: { hourlyRate: 100, taxRatePercent: 0, validFrom: '2026-01-01' } };
      await pool.query(`UPDATE insurance_providers SET payer_kind = 'OBRA_SOCIAL' WHERE code = $1`, [code]);
      expect((await api.post(`${BASE}/insurance-providers/${code}/contracts`, body, admin)).status).toBe(201);
      const dupContrato = await api.post(`${BASE}/insurance-providers/${code}/contracts`, body, admin);
      expect([dupContrato.status, dupContrato.data.code]).toEqual([409, 'INSURANCE_CONTRACT_NAME_EXISTS']);
    });

    it('sem código: o código nasce do nome (deriveProviderCode); nome sem caractere codificável → 422 NAME_NOT_CODIFIABLE; aliases gravam o rótulo do ClickUp', async () => {
      const base = `QA058 Derivado ${sufixo()}`;
      const r = await api.post(`${BASE}/catalogs/insurance-providers`, { name: base, aliases: [`${base} (rótulo)`] }, admin);
      expect(r.status).toBe(201);
      expect(r.data.data.code).toMatch(/^QA058_DERIVADO_[A-Z0-9]+$/);
      const alias = (await pool.query(`SELECT code FROM insurance_provider_aliases WHERE source = 'clickup' AND label = $1`, [`${base} (rótulo)`])).rows[0];
      expect(alias).toEqual({ code: r.data.data.code });
      const nada = await api.post(`${BASE}/catalogs/insurance-providers`, { name: '日本語' }, admin);
      expect([nada.status, nada.data.code]).toEqual([422, 'NAME_NOT_CODIFIABLE']);
    });

    it('cascata do serviço (for-service): só ativas com contrato oferecido no país + o escolhido; nunca payerKind', async () => {
      await termo(cA1);
      const sem = await criarPagador(pool, 'PREPAGA'); // sem contrato oferecido
      const r = await api.get(`${BASE}/insurance-providers/for-service?country=AR&selected=${sem}`, admin);
      expect(r.status).toBe(200);
      const codes = (r.data.data.providers as Array<{ code: string }>).map((p) => p.code);
      expect(codes).toContain(provA);
      expect(codes).toContain(sem); // o escolhido entra mesmo sem oferta
      expect(codes).not.toContain(provB); // provB tem contrato mas sem termo oferecido
      expect(JSON.stringify(r.data.data.providers)).not.toMatch(/payer|OBRA_SOCIAL|PREPAGA/);
      expect(r.data.data.providers.find((p: { code: string }) => p.code === provA)).toEqual({ code: provA, name: expect.stringContaining('QA058') });
      const br = await api.get(`${BASE}/insurance-providers/for-service?country=BR`, admin);
      expect((br.data.data.providers as Array<{ code: string }>).map((p) => p.code)).not.toContain(provA); // o contrato oferecido é AR
      expect((await api.get(`${BASE}/insurance-providers/for-service`, admin)).status).toBe(400);
    });

    describe('escopo de país (resolveCountryScope) — só-AR não vê contrato BR nem paciente BR', () => {
      let soAr: StaffAuth; let arEBr: StaffAuth;
      const limpezas: Array<() => Promise<void>> = [];
      beforeAll(async () => {
        soAr = await staffAuth(`qa058a-so-ar-${sufixo()}`, 'admin', 'AR');
        arEBr = await staffAuth(`qa058a-ar-br-${sufixo()}`, 'admin', 'AR');
        limpezas.push(await concederPaises(pool, soAr.uid, ['AR']), await concederPaises(pool, arEBr.uid, ['AR', 'BR']));
      });
      afterAll(async () => { for (const l of limpezas) await l(); });

      it('lista de contratos: ator só-AR vê os AR (e NÃO o BR); pedir BR é 403; ator AR+BR vê os dois; ?offered=true recorta ao oferecido', async () => {
        await termo(cA1);
        const todos = await api.get(`${BASE}/insurance-providers/${provA}/contracts`, soAr);
        expect(todos.status).toBe(200);
        const porId = Object.fromEntries((todos.data.data.items as Array<{ id: string; currentTerm: { state: string } }>).map((i) => [i.id, i.currentTerm.state]));
        expect(porId).toEqual({ [cA1]: 'OK', [cA2]: 'NO_TERM' });
        expect(JSON.stringify(todos.data)).not.toContain(cA_BR);
        const br = await api.get(`${BASE}/insurance-providers/${provA}/contracts?country=BR`, soAr);
        expect([br.status, br.data.error]).toEqual([403, 'COUNTRY_SCOPE_REQUIRED']);
        const ambos = await api.get(`${BASE}/insurance-providers/${provA}/contracts`, arEBr);
        expect((ambos.data.data.items as Array<{ id: string }>).map((i) => i.id).sort()).toEqual([cA1, cA2, cA_BR].sort());
        const oferecidos = await api.get(`${BASE}/insurance-providers/${provA}/contracts?offered=true&country=AR`, soAr);
        expect((oferecidos.data.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([cA1]);
      });

      it('§L: pacientes com vínculo VIGENTE da obra social, no recorte de país do ator, sem campo de container de paciente', async () => {
        await termo(cA1);
        await api.post(link(), { contractId: cA1, validFrom: '2020-01-01' }, soAr);
        const pBr = await criarPaciente(pool, 'BR');
        const sBr = await criarServico(pool, pBr);
        await vincular(pool, sBr, cA_BR, vigencia('2020-01-01'));
        const ar = await api.get(`${BASE}/insurance-providers/${provA}/patients`, soAr);
        expect(ar.status).toBe(200);
        const itens = ar.data.data.items as Array<Record<string, unknown>>;
        expect(itens.map((i) => i.contractedServiceId)).toEqual([s1]);
        expect(Object.keys(itens[0]).sort()).toEqual(['asOf', 'caseNumber', 'contractName', 'contractedServiceId', 'patientId', 'validFrom', 'validTo']);
        expect(itens[0]).toMatchObject({ patientId: patient, validFrom: '2020-01-01', validTo: null });
        const dois = await api.get(`${BASE}/insurance-providers/${provA}/patients`, arEBr);
        expect((dois.data.data.items as Array<{ contractedServiceId: string }>).map((i) => i.contractedServiceId).sort()).toEqual([s1, sBr].sort());
        expect((await api.get(`${BASE}/insurance-providers/${provA}/patients?country=BR`, soAr)).status).toBe(403);
        expect((await api.get(`${BASE}/insurance-providers/NAO_EXISTE_058/patients`, soAr)).status).toBe(404);
      });

      it('§L: paciente apagado (deleted_at) não aparece em pacientes da obra social', async () => {
        await termo(cA1);
        await vincular(pool, s1, cA1, vigencia('2020-01-01'));
        const url = `${BASE}/insurance-providers/${provA}/patients`;
        expect((await api.get(url, soAr)).data.data.items.map((i: { contractedServiceId: string }) => i.contractedServiceId)).toEqual([s1]);
        await pool.query('UPDATE patients SET deleted_at = now() WHERE id = $1', [patient]);
        expect((await api.get(url, soAr)).data.data.items).toEqual([]);
      });
    });

    it('baixa de serviço (PATCH active:false) encerra o vínculo vivo na mesma transação: o serviço novo de OUTRA obra social do paciente nasce sem TWO_PAYERS_OVERLAP', async () => {
      expect((await api.post(link(), { contractId: cA1, validFrom: '2020-01-01' }, admin)).status).toBe(201);
      // antes da baixa o vínculo vivo bloqueia o pagador novo (controle: a medição enxerga o cruzamento)
      const antes = await api.post(link(s2), { contractId: cB1, validFrom: '2099-01-01' }, admin);
      expect([antes.status, antes.data.code]).toEqual([422, 'TWO_PAYERS_OVERLAP']);
      const baixa = await api.patch(`${BASE}/patients/${patient}/contracted-services/${s1}`, { active: false }, admin);
      expect(baixa.status).toBe(200);
      const vivos = await vivosDe(s1);
      expect(vivos).toHaveLength(1);
      expect(vivos[0].valid).toMatch(/^\[2020-01-01,\d{4}-\d{2}-\d{2}\)$/); // fechado no dia de encerramento, não mais aberto
      expect((await pool.query('SELECT superseded_reason FROM contracted_service_contract WHERE contracted_service_id = $1 AND superseded_at IS NOT NULL', [s1])).rows)
        .toEqual([{ superseded_reason: 'ENDED' }]);
      const depois = await api.post(link(s2), { contractId: cB1, validFrom: '2099-01-01' }, admin);
      expect(depois.status).toBe(201);
    });

    it('baixa de serviço cujo vínculo vivo começa DEPOIS do encerramento: marcado ENDED sem reinsert (nada vivo) e o serviço novo passa', async () => {
      expect((await api.post(link(), { contractId: cA1, validFrom: '2099-01-01' }, admin)).status).toBe(201);
      expect((await api.patch(`${BASE}/patients/${patient}/contracted-services/${s1}`, { active: false }, admin)).status).toBe(200);
      expect(await vivosDe(s1)).toEqual([]);
      expect((await pool.query('SELECT superseded_reason FROM contracted_service_contract WHERE contracted_service_id = $1', [s1])).rows).toEqual([{ superseded_reason: 'ENDED' }]);
      expect((await api.post(link(s2), { contractId: cB1, validFrom: '2099-01-01' }, admin)).status).toBe(201);
    });

    it('baixa de serviço sem vínculo, ou repetida: segue 200 (no-op no vínculo)', async () => {
      expect((await api.patch(`${BASE}/patients/${patient}/contracted-services/${s1}`, { active: false }, admin)).status).toBe(200);
      expect(await vivosDe(s1)).toEqual([]);
    });

    it.todo('retry de 40P01/40001 em withSerializationRetry → 409 depois de 3 tentativas (unit do escritor + mapa de erros cobrem; deadlock real não é determinístico por HTTP)');
  });
});
