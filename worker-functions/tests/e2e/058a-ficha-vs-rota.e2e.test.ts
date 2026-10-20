/**
 * 058a-ficha-vs-rota.e2e.test.ts @integration — spec 058 Parte A (T094, SC-001, D-44): o MESMO serviço, no MESMO instante, lido pela FICHA do
 * paciente (`GET /patients/:id`) e pela ROTA do serviço (`GET /patients/:id/contracted-services`) devolve `asOf`, `payer`, `payerHistory`, `price`,
 * `tax` e `coverageMatch` idênticos — porque as duas chamam as mesmas funções em lote. E a ficha de um serviço SEM vínculo diz `NO_CONTRACT`
 * (nunca "sem preço" calado). Postgres real, app real com o engine ligado, sem mock de módulo do Jest.
 * Com `requestNow` FIXO (chamada direta dos repositórios) prova também o `asOf` = dia de operação de Buenos Aires, não o do servidor (UTC).
 */
import { Pool } from 'pg';
import type { AppDeFamilia } from './helpers/permissionFamilyHarness';
import { atorComCelulas, CELULAS_TODAS, chamar, fecharApp058a, limparAtores, subirApp058a } from './helpers/contrato058aApp';
import { criarContrato, criarPagador, criarPaciente, criarServico, DATABASE_URL, limpar, novoPool, vigencia, vincular } from './helpers/contrato058aDb';

const ATOR = { uid: 'qa058a-fvr-completo', nome: 'QA058A FVR completo' };
const CAMPOS = ['asOf', 'payer', 'payerHistory', 'price', 'tax', 'coverageMatch'] as const;

describe('058a ficha × rota — o mesmo serviço, o mesmo instante, a mesma resposta (SC-001) @integration', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  let patient = ''; let patient2 = '';
  let sObra = ''; let sPrivado = ''; let sSemVinculo = ''; let sFuturo = ''; let sEncerrado = '';

  beforeAll(async () => {
    pool = novoPool();
    await limpar(pool);
    await limparAtores(pool, [ATOR]);
    await atorComCelulas(pool, ATOR.uid, ATOR.nome, CELULAS_TODAS);
    app = await subirApp058a(DATABASE_URL);
  }, 60000);

  beforeEach(async () => {
    await limpar(pool);
    patient = await criarPaciente(pool, 'AR');
    const obra = await criarPagador(pool, 'OBRA_SOCIAL');
    const cObra = await criarContrato(pool, obra);
    const cFuturo = await criarContrato(pool, obra);
    const priv = await criarPagador(pool, 'PRIVATE');
    const cPriv = await criarContrato(pool, priv);
    for (const [c, taxa, valor] of [[cObra, 21, 1500], [cFuturo, 10.5, 1800]] as const) {
      await pool.query(
        `INSERT INTO insurance_contract_terms (contract_id, hourly_rate, tax_rate_percent, valid, recorded_by) VALUES ($1, $2, $3, '[2020-01-01,)', 'qa058a')`,
        [c, valor, taxa],
      );
    }
    sObra = await criarServico(pool, patient);
    patient2 = await criarPaciente(pool, 'AR'); // pagador particular noutro paciente: T2 barra dois pagadores simultâneos no MESMO paciente
    sPrivado = await criarServico(pool, patient2);
    sSemVinculo = await criarServico(pool, patient);
    sFuturo = await criarServico(pool, patient);
    sEncerrado = await criarServico(pool, patient);
    await vincular(pool, sObra, cObra, vigencia('2020-01-01'));
    await vincular(pool, sEncerrado, cObra, vigencia('2020-01-01', '2021-01-01')); // já encerrado: só um asOf errado (2020) o enxergaria vigente
    await vincular(pool, sPrivado, cPriv, vigencia('2020-01-01'));
    await vincular(pool, sFuturo, cFuturo, vigencia('2999-01-01')); // começa no futuro: hoje não há pagador vigente
  });

  afterAll(async () => {
    await limpar(pool);
    await limparAtores(pool, [ATOR]);
    await fecharApp058a(app);
    await pool.end();
  });

  /** ficha e rota, juntando os dois pacientes (a vista por serviço é o que se compara). */
  const lerAmbos = async (): Promise<{ ficha: Record<string, any>; rota: Record<string, any> }> => {
    const ficha: Record<string, any> = {}; const rota: Record<string, any> = {};
    for (const p of [patient, patient2]) {
      const f = await chamar(app, 'GET', `/api/admin/patients/${p}`, ATOR.uid);
      const r = await chamar(app, 'GET', `/api/admin/patients/${p}/contracted-services`, ATOR.uid);
      expect([f.status, r.status]).toEqual([200, 200]);
      Object.assign(ficha, porId(f.body.data.contractedServices));
      Object.assign(rota, porId(r.body.data.services));
    }
    return { ficha, rota };
  };
  const porId = (itens: Array<{ id: string }>): Record<string, any> => Object.fromEntries(itens.map((i) => [i.id, i]));

  it('HTTP: ficha e rota devolvem asOf/payer/payerHistory/price/tax/coverageMatch idênticos, serviço a serviço', async () => {
    const { ficha: daFicha, rota: daRota } = await lerAmbos();
    for (const id of [sObra, sPrivado, sSemVinculo, sFuturo, sEncerrado]) {
      expect(daFicha[id]).toBeDefined();
      expect(daRota[id]).toBeDefined();
      for (const campo of CAMPOS) expect({ id, campo, v: daFicha[id][campo] }).toEqual({ id, campo, v: daRota[id][campo] });
    }
    // controle: os campos têm conteúdo (igualdade de `undefined` com `undefined` seria "não medi")
    expect(daFicha[sObra].price).toEqual({ state: 'OK', hourlyRate: 1500, currency: 'ARS' });
    expect(daFicha[sObra].tax).toEqual({ state: 'OK', taxRatePercent: 21 });
    expect(daFicha[sObra].payer).toMatchObject({ state: 'LINKED', isPrivate: false });
    expect(daFicha[sPrivado].payer).toMatchObject({ state: 'LINKED', isPrivate: true });
    expect(daFicha[sEncerrado].payer.state).toBe('NO_CONTRACT'); // encerrado em 2021: hoje não há pagador vigente
    expect(daFicha[sObra].asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('ficha de serviço SEM vínculo = NO_CONTRACT (pagador, preço e imposto), e de vínculo só no futuro também, pela ficha e pela rota', async () => {
    const { ficha, rota } = await lerAmbos();
    for (const servicos of [ficha, rota]) {
      expect(servicos[sSemVinculo].payer.state).toBe('NO_CONTRACT');
      expect(servicos[sSemVinculo].price).toEqual({ state: 'NO_CONTRACT' });
      expect(servicos[sSemVinculo].tax).toEqual({ state: 'NO_CONTRACT' });
      expect(servicos[sFuturo].price).toEqual({ state: 'NO_CONTRACT' });
    }
  });

  it('requestNow FIXO: ficha e rota (repositórios reais) dão o mesmo resultado, e o asOf é o dia de Buenos Aires, não o do servidor', async () => {
    const { PatientQueryRepository } = await import('@modules/case/infrastructure/PatientQueryRepository');
    const { PatientContractedServiceRepository } = await import('@modules/case/infrastructure/PatientContractedServiceRepository');
    // 2026-10-19 02:00 UTC = 2026-10-18 23:00 em Buenos Aires
    const AGORA = new Date('2026-10-19T02:00:00Z');
    const daFicha: Record<string, any> = {}; const daRota: Record<string, any> = {};
    for (const p of [patient, patient2]) {
      const ficha = await new PatientQueryRepository().findDetailById(p, undefined, AGORA);
      const rota = await new PatientContractedServiceRepository().listForPatient(p, AGORA);
      Object.assign(daFicha, porId((ficha as unknown as { contractedServices: Array<{ id: string }> }).contractedServices));
      Object.assign(daRota, porId(rota as unknown as Array<{ id: string }>));
    }
    for (const id of [sObra, sPrivado, sSemVinculo, sFuturo, sEncerrado]) {
      for (const campo of CAMPOS) expect({ id, campo, v: daFicha[id][campo] }).toEqual({ id, campo, v: daRota[id][campo] });
    }
    expect(daFicha[sObra].asOf).toBe('2026-10-18');
    expect(daRota[sObra].asOf).toBe('2026-10-18');
  });
});
