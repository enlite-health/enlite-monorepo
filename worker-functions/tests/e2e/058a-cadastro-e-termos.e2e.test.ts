/**
 * 058a-cadastro-e-termos.e2e.test.ts @integration — spec 058 Parte A: travas de BANCO de contatos (534), contratos (535) e termos (536).
 *
 * Postgres REAL, sem mock. Nomes casam com as linhas SABOTAGEM de tasks.md T023/T024/T026:
 *   `-t "par do documento"` · `-t "retire"` · `-t "retire sem sentinela"` · `-t "E3"` · `-t "imposto"` ·
 *   `-t "sobreposição de termos"` · `-t "marcar trio"` · `-t "termo imutável"` · teste de contrato "vocabulário do documento".
 *
 * Parte API/HTTP (A1.4, rotas reais de contato/contrato/termo, zod, mapa constraint → 409): bloco `API/HTTP` no fim.
 */
import { Pool } from 'pg';
import { DOCUMENT_TYPES } from '@modules/case/domain/enums/DocumentType';
import {
  criarContrato, criarPagador, emTransacaoRevertida, erroDe, limpar, novoPool,
} from './helpers/contrato058aDb';
import { api, atores, BASE } from './helpers/contrato058aApi';
import type { StaffAuth } from './helpers/staffAuth';

describe('058a cadastro e termos — travas de banco (534/535/536) @integration', () => {
  let pool: Pool;
  let provider = '';

  beforeAll(async () => { pool = novoPool(); await limpar(pool); });
  beforeEach(async () => { await limpar(pool); provider = await criarPagador(pool, 'OBRA_SOCIAL'); });
  afterAll(async () => { await limpar(pool); await pool.end(); });

  const contato = async (extra: Record<string, string | null> = {}): Promise<string> => {
    const c = { document_type: null, document_number_encrypted: null, email_encrypted: null, ...extra };
    const r = await pool.query<{ id: string }>(
      `INSERT INTO insurance_provider_contacts
         (provider_code, full_name, role_title, phone_encrypted, email_encrypted, document_type, document_number_encrypted, created_by, updated_by)
       VALUES ($1, 'Contato QA', 'Gestor', 'cifrado-fake', $2, $3, $4, 'qa058a', 'qa058a') RETURNING id`,
      [provider, c.email_encrypted, c.document_type, c.document_number_encrypted]);
    return r.rows[0].id;
  };

  describe('contatos (534)', () => {
    it('par do documento: só o tipo, sem número → 23514 (insurance_provider_contacts_document_pair_chk)', async () => {
      const e = await erroDe(() => contato({ document_type: 'DNI' }));
      expect(e?.code).toBe('23514');
      expect(e?.constraint).toBe('insurance_provider_contacts_document_pair_chk');
    });

    it('par do documento: só o número, sem tipo → 23514 (insurance_provider_contacts_document_pair_chk)', async () => {
      const e = await erroDe(() => contato({ document_number_encrypted: 'cifrado-fake' }));
      expect(e?.code).toBe('23514');
      expect(e?.constraint).toBe('insurance_provider_contacts_document_pair_chk');
    });

    it('documento completo ou nenhum: os dois preenchidos e os dois vazios passam (controle positivo)', async () => {
      await contato({ document_type: 'PASSPORT', document_number_encrypted: 'cifrado-fake' });
      await contato();
      expect((await pool.query('SELECT count(*)::int AS n FROM insurance_provider_contacts WHERE provider_code = $1', [provider])).rows[0].n).toBe(2);
    });

    it('vocabulário do documento: o CHECK vivo (pg_get_constraintdef) lista exatamente DOCUMENT_TYPES', async () => {
      const def = (await pool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'insurance_provider_contacts_document_type_check'`)).rows[0]?.def;
      expect(def).toBeDefined();
      const noBanco = [...def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]).sort();
      expect(noBanco.length).toBeGreaterThan(0);
      expect(noBanco).toEqual([...DOCUMENT_TYPES].sort());
    });

    it('vocabulário do documento: tipo fora do vocabulário (CUIT) → 23514', async () => {
      const e = await erroDe(() => contato({ document_type: 'CUIT', document_number_encrypted: 'cifrado-fake' }));
      expect(e?.constraint).toBe('insurance_provider_contacts_document_type_check');
    });

    it('retire: o sentinela infinity vira now() pelo trigger e o contato fica aposentado', async () => {
      const id = await contato();
      await pool.query(`UPDATE insurance_provider_contacts SET retired_at = 'infinity' WHERE id = $1`, [id]);
      const r = (await pool.query<{ finito: boolean; recente: boolean }>(
        `SELECT retired_at <> 'infinity' AS finito, retired_at > now() - interval '1 minute' AS recente
           FROM insurance_provider_contacts WHERE id = $1`, [id])).rows[0];
      expect(r).toEqual({ finito: true, recente: true });
    });

    it('retire sem sentinela: sem o trigger, o CHECK recusa o infinity (nunca sobrevive) — 23514 …_retired_at_finito', async () => {
      const id = await contato();
      const e = await emTransacaoRevertida(pool, async (c) => {
        await c.query('ALTER TABLE insurance_provider_contacts DISABLE TRIGGER USER'); // simula o trigger ausente
        return erroDe(() => c.query(`UPDATE insurance_provider_contacts SET retired_at = 'infinity' WHERE id = $1`, [id]));
      });
      expect(e?.code).toBe('23514');
      expect(e?.constraint).toBe('insurance_provider_contacts_retired_at_finito');
    });

    it('contatos: o app não apaga (sem DELETE para app_runtime/app_system)', async () => {
      const r = await pool.query<{ rt: boolean; sys: boolean }>(
        `SELECT has_table_privilege('app_runtime', 'insurance_provider_contacts', 'DELETE') AS rt,
                has_table_privilege('app_system',  'insurance_provider_contacts', 'DELETE') AS sys`);
      expect(r.rows[0]).toEqual({ rt: false, sys: false });
    });
  });

  describe('contratos (535)', () => {
    it('E3 name_uq: mesmo nome (caixa/espaço) no mesmo pagador → 23505 insurance_contracts_name_uq; em outro pagador passa', async () => {
      await pool.query(`INSERT INTO insurance_contracts (provider_code, country, name, created_by, updated_by) VALUES ($1, 'AR', 'Plan Oro', 'qa', 'qa')`, [provider]);
      const e = await erroDe(() => pool.query(
        `INSERT INTO insurance_contracts (provider_code, country, name, created_by, updated_by) VALUES ($1, 'AR', 'PLAN ORO', 'qa', 'qa')`, [provider]));
      expect(e?.code).toBe('23505');
      expect(e?.constraint).toBe('insurance_contracts_name_uq');
      const outro = await criarPagador(pool, 'PREPAGA');
      await pool.query(`INSERT INTO insurance_contracts (provider_code, country, name, created_by, updated_by) VALUES ($1, 'AR', 'Plan Oro', 'qa', 'qa')`, [outro]);
    });

    it('E3 OTHER: contrato para o código OTHER é recusado — pelo CHECK (23514), isolado do T5 que também o barraria', async () => {
      const insert = `INSERT INTO insurance_contracts (provider_code, country, name, created_by, updated_by) VALUES ('OTHER', 'AR', 'qa058 other', 'qa', 'qa')`;
      expect(await erroDe(() => pool.query(insert))).not.toBeNull(); // pelo caminho normal: recusado (T5 e/ou CHECK)
      const e = await emTransacaoRevertida(pool, async (c) => {
        await c.query('ALTER TABLE insurance_contracts DISABLE TRIGGER USER'); // sem o T5, só o CHECK segura
        return erroDe(() => c.query(insert));
      });
      expect(e?.code).toBe('23514');
      expect(e?.constraint).toBe('insurance_contracts_provider_not_other_chk');
    });

    it('E3 país: só AR|BR (23514 insurance_contracts_country_check)', async () => {
      const e = await erroDe(() => criarContrato(pool, provider, 'UY' as unknown as 'AR'));
      expect(e?.constraint).toBe('insurance_contracts_country_check');
    });

    it('E3 imutáveis: provider_code e country não mudam; o nome e a abrangência mudam', async () => {
      const id = await criarContrato(pool, provider);
      const outro = await criarPagador(pool, 'PREPAGA');
      const eP = await erroDe(() => pool.query('UPDATE insurance_contracts SET provider_code = $2 WHERE id = $1', [id, outro]));
      const eC = await erroDe(() => pool.query(`UPDATE insurance_contracts SET country = 'BR' WHERE id = $1`, [id]));
      expect([eP?.code, eC?.code]).toEqual(['23514', '23514']);
      await pool.query(`UPDATE insurance_contracts SET name = 'renomeado qa058', scope_description = 'Zona norte' WHERE id = $1`, [id]);
      expect((await pool.query('SELECT name FROM insurance_contracts WHERE id = $1', [id])).rows[0].name).toBe('renomeado qa058');
    });
  });

  describe('termos (536)', () => {
    let contrato = '';
    beforeEach(async () => { contrato = await criarContrato(pool, provider); });

    const termo = (valid: string, over: { rate?: number; tax?: number } = {}) =>
      pool.query<{ id: string }>(
        `INSERT INTO insurance_contract_terms (contract_id, hourly_rate, tax_rate_percent, valid, recorded_by)
         VALUES ($1, $2, $3, $4::daterange, 'qa058a') RETURNING id`, [contrato, over.rate ?? 1500.5, over.tax ?? 0, valid]);

    it('imposto: INSERT sem tax_rate_percent falha (NOT NULL, sem DEFAULT — 23502)', async () => {
      const e = await erroDe(() => pool.query(
        `INSERT INTO insurance_contract_terms (contract_id, hourly_rate, valid, recorded_by) VALUES ($1, 100, '[2026-01-01,)', 'qa058a')`, [contrato]));
      expect(e?.code).toBe('23502');
    });

    it('imposto fora de 0–100 → 23514 (…_tax_rate_percent_check); 0 (isento) e 100 passam', async () => {
      const menos = await erroDe(() => termo('[2026-01-01,)', { tax: -0.01 }));
      const mais = await erroDe(() => termo('[2026-01-01,)', { tax: 100.01 }));
      expect([menos?.code, mais?.code]).toEqual(['23514', '23514']);
      await termo('[2020-01-01,2021-01-01)', { tax: 0 });
      await termo('[2021-01-01,2022-01-01)', { tax: 100 });
    });

    it('termo: valor-hora > 0 e vigência não vazia, com início obrigatório', async () => {
      const zero = await erroDe(() => termo('[2026-01-01,)', { rate: 0 }));
      const vazia = await erroDe(() => pool.query(
        `INSERT INTO insurance_contract_terms (contract_id, hourly_rate, tax_rate_percent, valid, recorded_by) VALUES ($1, 10, 0, 'empty', 'qa058a')`, [contrato]));
      const semInicio = await erroDe(() => pool.query(
        `INSERT INTO insurance_contract_terms (contract_id, hourly_rate, tax_rate_percent, valid, recorded_by) VALUES ($1, 10, 0, '(,2026-01-01)', 'qa058a')`, [contrato]));
      expect([zero?.constraint, vazia?.constraint, semInicio?.constraint]).toEqual([
        'insurance_contract_terms_hourly_rate_check', 'insurance_contract_terms_valid_check', 'insurance_contract_terms_valid_check']);
    });

    it('sobreposição de termos: dois termos correntes que se cruzam → 23P01 (insurance_contract_terms_sem_sobreposicao)', async () => {
      await termo('[2026-01-01,2026-06-01)');
      const e = await erroDe(() => termo('[2026-05-01,)'));
      expect(e?.code).toBe('23P01');
      expect(e?.constraint).toBe('insurance_contract_terms_sem_sobreposicao');
    });

    it('termos vizinhos e superados não conflitam (controle positivo do EXCLUDE parcial)', async () => {
      const a = (await termo('[2026-01-01,2026-06-01)')).rows[0].id;
      await termo('[2026-06-01,)'); // vizinho: [) encosta, não cruza
      await pool.query(`UPDATE insurance_contract_terms SET superseded_by = 'qa058a', superseded_reason = 'CORRECTION' WHERE id = $1`, [a]);
      await termo('[2026-02-01,2026-03-01)'); // cruza só a linha superada → passa
    });

    it('marcar trio: superseded_by + reason bastam; superseded_at é posto pelo banco, uma única vez', async () => {
      const id = (await termo('[2026-01-01,)')).rows[0].id;
      await pool.query(`UPDATE insurance_contract_terms SET superseded_by = 'qa058a', superseded_reason = 'REPRICED' WHERE id = $1`, [id]);
      const r = (await pool.query<{ at_recente: boolean; reason: string }>(
        `SELECT superseded_at > now() - interval '1 minute' AS at_recente, superseded_reason AS reason FROM insurance_contract_terms WHERE id = $1`, [id])).rows[0];
      expect(r).toEqual({ at_recente: true, reason: 'REPRICED' });
      const de_novo = await erroDe(() => pool.query(`UPDATE insurance_contract_terms SET superseded_reason = 'CORRECTION' WHERE id = $1`, [id]));
      expect(de_novo?.code).toBe('23514');
    });

    it('trio incoerente: só a razão (sem autor) é recusado; razão fora de REPRICED|CORRECTION também', async () => {
      const id = (await termo('[2026-01-01,)')).rows[0].id;
      const semAutor = await erroDe(() => pool.query(`UPDATE insurance_contract_terms SET superseded_reason = 'REPRICED' WHERE id = $1`, [id]));
      const razao = await erroDe(() => pool.query(`UPDATE insurance_contract_terms SET superseded_by = 'x', superseded_reason = 'ENDED' WHERE id = $1`, [id]));
      expect([semAutor?.constraint, razao?.constraint]).toEqual([
        'insurance_contract_terms_superseded_trio_chk', 'insurance_contract_terms_superseded_reason_check']);
    });

    it('termo imutável: valor-hora, imposto e vigência não mudam depois de gravados (23514)', async () => {
      const id = (await termo('[2026-01-01,)')).rows[0].id;
      const h = await erroDe(() => pool.query('UPDATE insurance_contract_terms SET hourly_rate = 9999 WHERE id = $1', [id]));
      const t = await erroDe(() => pool.query('UPDATE insurance_contract_terms SET tax_rate_percent = 21 WHERE id = $1', [id]));
      const v = await erroDe(() => pool.query(`UPDATE insurance_contract_terms SET valid = '[2026-02-01,)' WHERE id = $1`, [id]));
      expect([h?.code, t?.code, v?.code]).toEqual(['23514', '23514', '23514']);
      expect(Number((await pool.query('SELECT hourly_rate FROM insurance_contract_terms WHERE id = $1', [id])).rows[0].hourly_rate)).toBe(1500.5);
    });

    it('termos: o app não apaga (sem DELETE para app_runtime/app_system)', async () => {
      const r = await pool.query<{ rt: boolean; sys: boolean }>(
        `SELECT has_table_privilege('app_runtime', 'insurance_contract_terms', 'DELETE') AS rt,
                has_table_privilege('app_system',  'insurance_contract_terms', 'DELETE') AS sys`);
      expect(r.rows[0]).toEqual({ rt: false, sys: false });
    });
  });

  describe('API/HTTP — rotas reais (A1.4)', () => {
    let admin: StaffAuth;
    beforeAll(async () => { ({ admin } = await atores()); });

    const contatoBase = { fullName: 'Maria Gomez', roleTitle: 'Auditora', phone: '+54 11 5555-0000' };

    it('PATCH de contato só com documentType → 422 DOCUMENT_PAIR_INCOMPLETE; email: null limpa e ausente não toca', async () => {
      const criado = await api.post(`${BASE}/insurance-providers/${provider}/contacts`, { ...contatoBase, email: 'maria@osde.example', documentType: 'DNI', documentNumber: '30123456' }, admin);
      expect(criado.status).toBe(201);
      const id = criado.data.data.id as string;
      expect(criado.data.data).toMatchObject({ phone: contatoBase.phone, email: 'maria@osde.example', document: { type: 'DNI', number: '30123456' }, redacted: false });
      // cifrado em repouso: o que está na tabela NÃO é o texto
      const crua = (await pool.query('SELECT phone_encrypted, email_encrypted, document_number_encrypted FROM insurance_provider_contacts WHERE id = $1', [id])).rows[0];
      expect(JSON.stringify(crua)).not.toMatch(/5555-0000|maria@osde|30123456/);

      const par = await api.patch(`${BASE}/insurance-providers/${provider}/contacts/${id}`, { documentType: 'PASSPORT' }, admin);
      expect(par.status).toBe(422);
      expect(par.data.code).toBe('DOCUMENT_PAIR_INCOMPLETE');

      const ausente = await api.patch(`${BASE}/insurance-providers/${provider}/contacts/${id}`, { roleTitle: 'Chefa de auditoria' }, admin);
      expect(ausente.status).toBe(200);
      expect(ausente.data.data).toMatchObject({ roleTitle: 'Chefa de auditoria', email: 'maria@osde.example', document: { type: 'DNI', number: '30123456' } });

      const limpa = await api.patch(`${BASE}/insurance-providers/${provider}/contacts/${id}`, { email: null, documentType: null, documentNumber: null }, admin);
      expect(limpa.status).toBe(200);
      expect(limpa.data.data).toMatchObject({ email: null, document: null });
      const linha = (await pool.query('SELECT email_encrypted, document_type, document_number_encrypted FROM insurance_provider_contacts WHERE id = $1', [id])).rows[0];
      expect(linha).toEqual({ email_encrypted: null, document_type: null, document_number_encrypted: null });
      expect((await api.patch(`${BASE}/insurance-providers/${provider}/contacts/${id}`, { phone: null }, admin)).status).toBe(422);
    });

    it('contato: aposentar (retire) nunca apaga; a lista padrão some com ele e includeRetired traz de volta', async () => {
      const id = (await api.post(`${BASE}/insurance-providers/${provider}/contacts`, contatoBase, admin)).data.data.id as string;
      const retire = await api.post(`${BASE}/insurance-providers/${provider}/contacts/${id}/retire`, {}, admin);
      expect(retire.status).toBe(200);
      expect(retire.data.data.retired).toBe(true);
      expect(Number((await pool.query('SELECT count(*) FROM insurance_provider_contacts WHERE id = $1 AND retired_at IS NOT NULL AND retired_at <> \'infinity\'', [id])).rows[0].count)).toBe(1);
      expect((await api.get(`${BASE}/insurance-providers/${provider}/contacts`, admin)).data.data.items).toEqual([]);
      expect((await api.get(`${BASE}/insurance-providers/${provider}/contacts?includeRetired=true`, admin)).data.data.items).toHaveLength(1);
      expect((await api.post(`${BASE}/insurance-providers/${provider}/contacts/${id}/retire`, {}, admin)).status).toBe(409);
    });

    const contratoBody = (name: string, extra: Record<string, unknown> = {}) => ({
      name, country: 'AR', firstTerm: { hourlyRate: 1500, taxRatePercent: 21, validFrom: '2026-01-01', validTo: '2026-12-31', ...extra },
    });

    it('POST de termo sem taxRatePercent → 422 do zod (formulário vazio não vira 0); com 0 ("isento") grava 0', async () => {
      const criado = await api.post(`${BASE}/insurance-providers/${provider}/contracts`, contratoBody('Plan Termos'), admin);
      expect(criado.status).toBe(201);
      const id = criado.data.data.id as string;
      const termos = async (): Promise<number> => (await pool.query('SELECT count(*)::int AS n FROM insurance_contract_terms WHERE contract_id = $1', [id])).rows[0].n;
      expect(await termos()).toBe(1);
      for (const corpo of [{ hourlyRate: 1700, validFrom: '2027-01-01' }, { hourlyRate: 1700, taxRatePercent: '', validFrom: '2027-01-01' }, { hourlyRate: 1700, taxRatePercent: null, validFrom: '2027-01-01' }]) {
        const r = await api.post(`${BASE}/insurance-contracts/${id}/terms`, corpo, admin);
        expect(r.status).toBe(422);
        expect(r.data.code).toBe('VALIDATION_FAILED');
        expect(r.data.details.fields).toContain('taxRatePercent');
      }
      expect(await termos()).toBe(1);
      const isento = await api.post(`${BASE}/insurance-contracts/${id}/terms`, { hourlyRate: 1700, taxRatePercent: 0, validFrom: '2027-01-01' }, admin);
      expect(isento.status).toBe(201);
      expect((await pool.query('SELECT tax_rate_percent FROM insurance_contract_terms WHERE contract_id = $1 AND valid @> \'2027-02-01\'::date', [id])).rows.map((x) => Number(x.tax_rate_percent))).toEqual([0]);
      expect(isento.data.data.futureTerms).toEqual(expect.any(Array));
    });

    it('23505 de insurance_contracts_name_uq e 23P01 de …_sem_sobreposicao → 409 com código por constraint', async () => {
      const a = await api.post(`${BASE}/insurance-providers/${provider}/contracts`, contratoBody('Plan Duplicado'), admin);
      expect(a.status).toBe(201);
      const dup = await api.post(`${BASE}/insurance-providers/${provider}/contracts`, contratoBody('  plan DUPLICADO '), admin);
      expect(dup.status).toBe(409);
      expect(dup.data.code).toBe('INSURANCE_CONTRACT_NAME_EXISTS');
      // sobreposição: o 1º termo vai até 2026-12-31; um termo que invade 2026 é recusado pelo EXCLUDE
      const sobre = await api.post(`${BASE}/insurance-contracts/${a.data.data.id}/terms`, { hourlyRate: 1800, taxRatePercent: 21, validFrom: '2026-06-01' }, admin);
      expect(sobre.status).toBe(409);
      expect(sobre.data.code).toBe('RANGE_OVERLAP');
      expect(sobre.data.details.constraint).toBe('insurance_contract_terms_sem_sobreposicao');
      // nome igual em OUTRA obra social é permitido (a unicidade é por pagador)
      const outro = await criarPagador(pool, 'PREPAGA');
      expect((await api.post(`${BASE}/insurance-providers/${outro}/contracts`, contratoBody('Plan Duplicado'), admin)).status).toBe(201);
    });

    it('REPRICED / CORRECTION: reajuste fecha o trecho anterior, mesmo início → 422 SAME_START_USE_CORRECTION, termo antigo nunca é editado', async () => {
      const c = await api.post(`${BASE}/insurance-providers/${provider}/contracts`, contratoBody('Plan Reajuste', { validTo: null }), admin);
      const id = c.data.data.id as string;
      const termoId = c.data.data.currentTerm.termId as string;
      const mesmoInicio = await api.post(`${BASE}/insurance-contracts/${id}/terms/${termoId}/supersede`, { reason: 'REPRICED', hourlyRate: 1600, taxRatePercent: 21, validFrom: '2026-01-01' }, admin);
      expect(mesmoInicio.status).toBe(422);
      expect(mesmoInicio.data.code).toBe('SAME_START_USE_CORRECTION');
      const reajuste = await api.post(`${BASE}/insurance-contracts/${id}/terms/${termoId}/supersede`, { reason: 'REPRICED', hourlyRate: 1600, taxRatePercent: 21, validFrom: '2026-07-01' }, admin);
      expect(reajuste.status).toBe(200);
      const vivos = (await pool.query<{ hourly_rate: string; valid: string }>(
        'SELECT hourly_rate, valid::text AS valid FROM insurance_contract_terms WHERE contract_id = $1 AND superseded_at IS NULL ORDER BY valid', [id])).rows;
      expect(vivos.map((v) => [Number(v.hourly_rate), v.valid])).toEqual([[1500, '[2026-01-01,2026-07-01)'], [1600, '[2026-07-01,)']]);
      const velho = (await pool.query('SELECT superseded_reason, superseded_at IS NOT NULL AS carimbado FROM insurance_contract_terms WHERE id = $1', [termoId])).rows[0];
      expect(velho).toEqual({ superseded_reason: 'REPRICED', carimbado: true });
      expect((await api.post(`${BASE}/insurance-contracts/${id}/terms/${termoId}/supersede`, { reason: 'CORRECTION', hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-01-01' }, admin)).status).toBe(409);
    });

    it('PATCH de contrato: país e pagador imutáveis (422), name/scopeDescription editam; null limpa a abrangência', async () => {
      const c = await api.post(`${BASE}/insurance-providers/${provider}/contracts`, { ...contratoBody('Plan Edita'), scopeDescription: 'CABA' }, admin);
      const id = c.data.data.id as string;
      expect((await api.patch(`${BASE}/insurance-contracts/${id}`, { country: 'BR' }, admin)).data.code).toBe('IMMUTABLE_FIELD');
      expect((await api.patch(`${BASE}/insurance-contracts/${id}`, { name: 'Plan Editado', scopeDescription: null }, admin)).data.data).toMatchObject({ name: 'Plan Editado', scopeDescription: null });
      expect((await api.patch(`${BASE}/insurance-contracts/${id}`, { name: '' }, admin)).status).toBe(422);
    });
  });
});
