/**
 * 058a-rastro-e-redacao.e2e.test.ts @integration — spec 058 Parte A (T093): rastro de autoria, redação por célula (§0, os 4 decisores), recusa de
 * chave legada ANTES do ABAC, log sem PII, portão 403 do §L ponta a ponta e a cascata `for-service` (R7).
 * App REAL com o engine de permissão LIGADO (ver `helpers/contrato058aApp.ts`), banco real, atores em grupos com EXATAMENTE as células de cada cenário.
 * Sem mock de módulo do Jest. Cada recusa tem o controle positivo do MESMO ator/rota (a recusa mede a célula, não um corpo ruim).
 */
import { Pool } from 'pg';
import type { AppDeFamilia } from './helpers/permissionFamilyHarness';
import { concederPaises } from './helpers/contrato058aApi';
import { atorComCelulas, CELULAS_TODAS, chamar, fecharApp058a, limparAtores, sem, subirApp058a } from './helpers/contrato058aApp';
import { criarContrato, criarPagador, criarPaciente, criarServico, DATABASE_URL, limpar, novoPool, vigencia, vincular, type PayerKind } from './helpers/contrato058aDb';

const A = {
  completo: { uid: 'qa058a-rr-completo', nome: 'QA058A RR completo' },
  semPreco: { uid: 'qa058a-rr-sem-preco', nome: 'QA058A RR sem preço' },
  semCobertura: { uid: 'qa058a-rr-sem-cobertura', nome: 'QA058A RR sem cobertura' },
  semL: { uid: 'qa058a-rr-sem-l', nome: 'QA058A RR sem §L' },
  soLeitura: { uid: 'qa058a-rr-so-leitura', nome: 'QA058A RR só leitura de serviço' },
  soCascata: { uid: 'qa058a-rr-so-cascata', nome: 'QA058A RR só cascata' },
};
const ATORES = Object.values(A);
const SECRET = { phone: '+54 11 4000-0058', email: 'qa058a.pii.058@example.com', doc: '30123058' };

describe('058a rastro e redação por célula — API real com o engine ligado @integration', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const limpezasPais: Array<() => Promise<void>> = [];
  let provObra = ''; let provPriv = '';
  let cObra = ''; let cObraSemTermo = ''; let cPriv = '';
  let pObra = ''; let pPriv = '';
  let sObra = ''; let sPriv = '';

  beforeAll(async () => {
    pool = novoPool();
    await limpar(pool);
    await limparAtores(pool, ATORES);
    await atorComCelulas(pool, A.completo.uid, A.completo.nome, CELULAS_TODAS);
    await atorComCelulas(pool, A.semPreco.uid, A.semPreco.nome, sem('patient_contract_value:read'));
    await atorComCelulas(pool, A.semCobertura.uid, A.semCobertura.nome, sem('patient_coverage:read'));
    await atorComCelulas(pool, A.semL.uid, A.semL.nome, sem('insurance_provider_patients:read'));
    await atorComCelulas(pool, A.soLeitura.uid, A.soLeitura.nome, [['patient', 'read'], ['patient_services', 'read']]);
    await atorComCelulas(pool, A.soCascata.uid, A.soCascata.nome, [['insurance_contracts', 'read']]);
    // a lista de contratos e o §L recortam por país (resolveCountryScope): o escopo vem de um grupo com países, não do papel
    for (const a of [A.completo, A.semPreco, A.semL]) limpezasPais.push(await concederPaises(pool, a.uid, ['AR']));
    app = await subirApp058a(DATABASE_URL);
  }, 60000);

  beforeEach(async () => {
    await limpar(pool);
    provObra = await criarPagador(pool, 'OBRA_SOCIAL');
    provPriv = await criarPagador(pool, 'PRIVATE');
    cObra = await criarContrato(pool, provObra);
    cObraSemTermo = await criarContrato(pool, provObra);
    cPriv = await criarContrato(pool, provPriv);
    for (const [c, valor] of [[cObra, 1500], [cPriv, 900]] as const) {
      await pool.query(
        `INSERT INTO insurance_contract_terms (contract_id, hourly_rate, tax_rate_percent, valid, recorded_by) VALUES ($1, $2, 21, '[2020-01-01,)', 'qa058a')`,
        [c, valor],
      );
    }
    // termo FUTURO do contrato com preço: a lista redige também os futuros
    await pool.query(
      `INSERT INTO insurance_contract_terms (contract_id, hourly_rate, tax_rate_percent, valid, recorded_by) VALUES ($1, 2222, 10.5, '[2999-01-01,)', 'qa058a')`,
      [cObraSemTermo],
    );
    pObra = await criarPaciente(pool, 'AR');
    pPriv = await criarPaciente(pool, 'AR');
    sObra = await criarServico(pool, pObra);
    sPriv = await criarServico(pool, pPriv);
    await vincular(pool, sObra, cObra, vigencia('2020-01-01'));
    await vincular(pool, sPriv, cPriv, vigencia('2020-01-01'));
  });

  afterAll(async () => {
    await pool.query('DROP TRIGGER IF EXISTS qa058a_echo ON insurance_provider_contacts');
    await pool.query('DROP FUNCTION IF EXISTS qa058a_echo()');
    await limpar(pool);
    for (const l of limpezasPais) await l();
    await limparAtores(pool, ATORES);
    await fecharApp058a(app);
    await pool.end();
  });

  const servico = (lista: Array<{ id: string }>, id: string): any => lista.find((s) => s.id === id);
  const fichaDe = async (uid: string, patient: string): Promise<any[]> => {
    const r = await chamar(app, 'GET', `/api/admin/patients/${patient}`, uid);
    expect(r.status).toBe(200);
    return r.body.data.contractedServices;
  };
  const rotaDe = async (uid: string, patient: string): Promise<any[]> => {
    const r = await chamar(app, 'GET', `/api/admin/patients/${patient}/contracted-services`, uid);
    expect(r.status).toBe(200);
    return r.body.data.services;
  };

  describe('rastro de autoria', () => {
    it('rastro: classificar o pagador grava payer_kind_history.changed_by = staff:<uid do ator>, com old/new na ordem', async () => {
      const antes = (await pool.query('SELECT count(*)::int AS n FROM insurance_provider_payer_kind_history WHERE provider_code = $1', [provObra])).rows[0].n;
      const r = await chamar(app, 'PATCH', `/api/admin/insurance-providers/${provObra}`, A.completo.uid, { payerKind: 'PREPAGA' });
      expect(r.status).toBe(200);
      const h = (await pool.query<{ changed_by: string; old_kind: PayerKind; new_kind: PayerKind }>(
        `SELECT changed_by, old_kind, new_kind FROM insurance_provider_payer_kind_history WHERE provider_code = $1 ORDER BY changed_at DESC, id DESC LIMIT 1`, [provObra])).rows[0];
      expect(h).toEqual({ changed_by: `staff:${A.completo.uid}`, old_kind: 'OBRA_SOCIAL', new_kind: 'PREPAGA' });
      expect((await pool.query('SELECT count(*)::int AS n FROM insurance_provider_payer_kind_history WHERE provider_code = $1', [provObra])).rows[0].n).toBe(antes + 1);
    });

    it('rastro: vínculo novo e encerramento gravam recorded_by / superseded_by = o uid do ator (nunca "system")', async () => {
      const sNovo = await criarServico(pool, pObra);
      const base = `/api/admin/patients/${pObra}/contracted-services/${sNovo}/contract-link`;
      // pObra já tem a obra social vigente em sObra: o 2º serviço do mesmo paciente só pode ser do MESMO pagador (T2)
      expect((await chamar(app, 'POST', base, A.completo.uid, { contractId: cObra, validFrom: '2020-01-01' })).status).toBe(201);
      expect((await chamar(app, 'POST', `${base}/end`, A.completo.uid, { validTo: '2025-12-31' })).status).toBe(200);
      const linhas = (await pool.query<{ recorded_by: string; superseded_by: string | null; superseded_reason: string | null }>(
        `SELECT recorded_by, superseded_by, superseded_reason FROM contracted_service_contract WHERE contracted_service_id = $1 ORDER BY recorded_at`, [sNovo])).rows;
      expect(linhas.length).toBeGreaterThanOrEqual(2);
      expect(new Set(linhas.map((l) => l.recorded_by))).toEqual(new Set([A.completo.uid]));
      expect(linhas.find((l) => l.superseded_reason === 'ENDED')?.superseded_by).toBe(A.completo.uid);
    });
  });

  describe('§0 decisor 1 — o preço some para quem não tem patient_contract_value:read', () => {
    it('ficha e rota: price REDACTED sem a célula, OK com ela; o imposto nunca é redigido', async () => {
      for (const ler of [fichaDe, rotaDe]) {
        const redigido = servico(await ler(A.semPreco.uid, pObra), sObra);
        expect(redigido.price).toEqual({ state: 'REDACTED' });
        expect(redigido.tax).toEqual({ state: 'OK', taxRatePercent: 21 });
        expect(JSON.stringify(redigido)).not.toContain('1500');
        const completo = servico(await ler(A.completo.uid, pObra), sObra);
        expect(completo.price).toEqual({ state: 'OK', hourlyRate: 1500, currency: 'ARS' });
      }
    });

    it('lista de contratos: currentTerm.price e futureTerms[].price REDACTED sem a célula; NO_TERM passa; imposto visível', async () => {
      const vista = async (uid: string) => {
        const r = await chamar(app, 'GET', `/api/admin/insurance-providers/${provObra}/contracts`, uid);
        expect(r.status).toBe(200);
        return Object.fromEntries((r.body.data.items as any[]).map((i) => [i.id, i]));
      };
      const sem$ = await vista(A.semPreco.uid);
      expect(sem$[cObra].currentTerm).toMatchObject({ state: 'OK', price: { state: 'REDACTED' }, taxRatePercent: 21 });
      expect(sem$[cObraSemTermo].currentTerm).toEqual({ state: 'NO_TERM' });
      expect(sem$[cObraSemTermo].futureTerms[0]).toMatchObject({ state: 'OK', price: { state: 'REDACTED' }, taxRatePercent: 10.5 });
      expect(JSON.stringify(sem$)).not.toMatch(/1500|2222/);
      const com$ = await vista(A.completo.uid);
      expect(com$[cObra].currentTerm.price).toEqual({ state: 'OK', hourlyRate: 1500, currency: 'ARS' });
      expect(com$[cObraSemTermo].futureTerms[0].price).toMatchObject({ state: 'OK', hourlyRate: 2222 });
    });
  });

  describe('§0 decisores 2 e 3 — quem é o pagador e o tipo dele só com a cobertura; "particular?" e a vigência continuam visíveis', () => {
    it('sem patient_coverage:read: names null, payerHistory[].names null, coverageMatch REDACTED; state/isPrivate/vigência visíveis; sem payerKind em lugar nenhum', async () => {
      for (const ler of [fichaDe, rotaDe]) {
        const obra = servico(await ler(A.semCobertura.uid, pObra), sObra);
        expect(obra.payer).toMatchObject({ state: 'LINKED', isPrivate: false, validFrom: '2020-01-01', validTo: null, names: null });
        expect(obra.payerHistory).toHaveLength(1);
        expect(obra.payerHistory[0]).toMatchObject({ isPrivate: false, validFrom: '2020-01-01', names: null });
        expect(obra.coverageMatch).toEqual({ state: 'REDACTED' });
        expect(JSON.stringify(obra)).not.toMatch(new RegExp(`OBRA_SOCIAL|${provObra}|${cObra}`));
        const priv = servico(await ler(A.semCobertura.uid, pPriv), sPriv);
        expect(priv.payer).toMatchObject({ state: 'LINKED', isPrivate: true, names: null });
        // o preço é OUTRA célula: este ator a tem
        expect(obra.price).toMatchObject({ state: 'OK' });
      }
    });

    it('com patient_coverage:read: names com providerCode/contractId/payerKind (controle positivo da mesma leitura)', async () => {
      for (const ler of [fichaDe, rotaDe]) {
        const obra = servico(await ler(A.completo.uid, pObra), sObra);
        expect(obra.payer.names).toMatchObject({ providerCode: provObra, contractId: cObra, payerKind: 'OBRA_SOCIAL' });
        expect(obra.payerHistory[0].names).toMatchObject({ providerCode: provObra, payerKind: 'OBRA_SOCIAL' });
        expect(obra.coverageMatch.state).not.toBe('REDACTED');
      }
    });

    it('a resposta da ESCRITA do vínculo também é projetada: sem a cobertura, names null e coverageMatch REDACTED', async () => {
      await atorComCelulas(pool, 'qa058a-rr-escreve-sem-cobertura', 'QA058A RR escreve sem cobertura', sem('patient_coverage:read'));
      try {
        const sNovo = await criarServico(pool, pObra);
        const r = await chamar(app, 'POST', `/api/admin/patients/${pObra}/contracted-services/${sNovo}/contract-link`, 'qa058a-rr-escreve-sem-cobertura', { contractId: cObra, validFrom: '2020-01-01' });
        expect(r.status).toBe(201);
        expect(r.body.data.payer).toMatchObject({ state: 'LINKED', isPrivate: false, names: null });
        expect(r.body.data.coverageMatch).toEqual({ state: 'REDACTED' });
      } finally {
        await limparAtores(pool, [{ uid: 'qa058a-rr-escreve-sem-cobertura', nome: 'QA058A RR escreve sem cobertura' }]);
      }
    });
  });

  describe('§0 decisor 4 — a lista de pacientes da obra social (§L) tem portão próprio', () => {
    it('portão 403 ponta a ponta: ator SEM insurance_provider_patients:read leva 403 (e nenhum dado); COM a célula leva 200 e o paciente', async () => {
      const negado = await chamar(app, 'GET', `/api/admin/insurance-providers/${provObra}/patients`, A.semL.uid);
      expect(negado.status).toBe(403);
      expect(JSON.stringify(negado.body)).not.toContain(pObra);
      const ok = await chamar(app, 'GET', `/api/admin/insurance-providers/${provObra}/patients`, A.completo.uid);
      expect(ok.status).toBe(200);
      expect((ok.body.data.items as any[]).map((i) => i.patientId)).toEqual([pObra]);
      // quem só lê serviços e cobertura (carona proibida) também não entra
      expect((await chamar(app, 'GET', `/api/admin/insurance-providers/${provObra}/patients`, A.soLeitura.uid)).status).toBe(403);
    });
  });

  describe('422 LEGACY_FIELD_REMOVED antes do ABAC', () => {
    it('ator SEM patient_services:create/update mandando a chave legada leva 422 (e não 403); o corpo válido do MESMO ator leva 403', async () => {
      const post = `/api/admin/patients/${pObra}/contracted-services`;
      const patch = `${post}/${sObra}`;
      for (const chave of [{ hourlyValue: 100 }, { contractType: 'OBRA_SOCIAL' }, { taxCondition: 'IVA_21' }]) {
        const a = await chamar(app, 'POST', post, A.soLeitura.uid, { serviceCode: 'CAREGIVER', ...chave });
        expect([a.status, a.body.code]).toEqual([422, 'LEGACY_FIELD_REMOVED']);
        const b = await chamar(app, 'PATCH', patch, A.soLeitura.uid, chave);
        expect([b.status, b.body.code]).toEqual([422, 'LEGACY_FIELD_REMOVED']);
      }
      const c = await chamar(app, 'PATCH', `/api/admin/patients/${pObra}/coverage`, A.soLeitura.uid, { healthInsuranceMemberId: '123' });
      expect([c.status, c.body.code]).toEqual([422, 'LEGACY_FIELD_REMOVED']);
      // controle: sem a chave legada o ABAC fala (403) — a ordem é mesmo "chave legada" antes da célula
      expect((await chamar(app, 'PATCH', patch, A.soLeitura.uid, { weeklyHours: 10 })).status).toBe(403);
      expect((await chamar(app, 'PATCH', `/api/admin/patients/${pObra}/coverage`, A.soLeitura.uid, { insuranceInformed: 'X' })).status).toBe(403);
      // nada foi gravado
      expect((await pool.query('SELECT weekly_hours FROM patient_contracted_services WHERE id = $1', [sObra])).rows[0].weekly_hours).toBeNull();
    });
  });

  describe('log sem PII', () => {
    it('erro inesperado do banco ao gravar um contato: o corpo da resposta e os logs NÃO carregam telefone, e-mail, documento, nome nem o texto do erro do driver', async () => {
      const { logger } = await import('@shared/logging');
      const espioes = (['error', 'warn', 'info', 'debug'] as const).map((n) => jest.spyOn(logger, n));
      const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      await pool.query(`CREATE OR REPLACE FUNCTION qa058a_echo() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ECHO_LINHA_058A %', NEW::text; END $$`);
      await pool.query('CREATE TRIGGER qa058a_echo BEFORE INSERT ON insurance_provider_contacts FOR EACH ROW EXECUTE FUNCTION qa058a_echo()');
      try {
        const r = await chamar(app, 'POST', `/api/admin/insurance-providers/${provObra}/contacts`, A.completo.uid, {
          fullName: 'Maria QA Gomez', roleTitle: 'Auditora', phone: SECRET.phone, email: SECRET.email, documentType: 'DNI', documentNumber: SECRET.doc,
        });
        expect(r.status).toBe(500);
        const logado = JSON.stringify([...espioes, consoleErr].map((s) => s.mock.calls.map((c) => c.map((x) => (x instanceof Error ? [x.message, x.stack] : x)))));
        const respondido = JSON.stringify(r.body);
        // controle positivo: o caminho de erro DE FATO logou (senão "sem PII" seria "sem log nenhum")
        expect(logado).toContain('AdminInsuranceProviderContactsController:create');
        for (const segredo of [SECRET.phone, SECRET.email, SECRET.doc, 'Maria QA Gomez', 'ECHO_LINHA_058A']) {
          expect({ segredo, noLog: logado.includes(segredo) }).toEqual({ segredo, noLog: false });
          expect({ segredo, naResposta: respondido.includes(segredo) }).toEqual({ segredo, naResposta: false });
        }
        expect((await pool.query('SELECT count(*)::int AS n FROM insurance_provider_contacts WHERE provider_code = $1', [provObra])).rows[0].n).toBe(0);
      } finally {
        await pool.query('DROP TRIGGER IF EXISTS qa058a_echo ON insurance_provider_contacts');
        await pool.query('DROP FUNCTION IF EXISTS qa058a_echo()');
        [...espioes, consoleErr].forEach((s) => s.mockRestore());
      }
      // com o trigger removido o MESMO pedido grava (a recusa era do trigger, não do corpo)
      const ok = await chamar(app, 'POST', `/api/admin/insurance-providers/${provObra}/contacts`, A.completo.uid, {
        fullName: 'Maria QA Gomez', roleTitle: 'Auditora', phone: SECRET.phone, email: SECRET.email, documentType: 'DNI', documentNumber: SECRET.doc,
      });
      expect(ok.status).toBe(201);
    });
  });

  describe('for-service (R7) — a cascata do serviço contratado', () => {
    it('não devolve payerKind e mantém o pagador escolhido mesmo sem oferta, para um ator que só tem insurance_contracts:read', async () => {
      const semOferta = await criarPagador(pool, 'PREPAGA'); // ativo, mas sem contrato oferecido
      const r = await chamar(app, 'GET', `/api/admin/insurance-providers/for-service?country=AR&selected=${semOferta}`, A.soCascata.uid);
      expect(r.status).toBe(200);
      const codes = (r.body.data.providers as Array<{ code: string }>).map((p) => p.code);
      expect(codes).toContain(provObra);
      expect(codes).toContain(semOferta);
      expect(JSON.stringify(r.body.data)).not.toMatch(/payerKind|payer_kind|OBRA_SOCIAL|PREPAGA|PRIVATE/);
      // sem o `selected`, o pagador sem oferta não aparece (o selected é o que o mantém)
      const sem = await chamar(app, 'GET', `/api/admin/insurance-providers/for-service?country=AR`, A.soCascata.uid);
      expect((sem.body.data.providers as Array<{ code: string }>).map((p) => p.code)).not.toContain(semOferta);
      // a célula certa é a do contrato: quem não a tem leva 403
      expect((await chamar(app, 'GET', `/api/admin/insurance-providers/for-service?country=AR`, A.soLeitura.uid)).status).toBe(403);
    });
  });
});
