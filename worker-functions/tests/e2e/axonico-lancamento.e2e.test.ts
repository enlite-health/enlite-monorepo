/**
 * axonico-lancamento.e2e.test.ts — F4 da change `integracao-axonico`.
 *
 * E2E dos endpoints POST /api/admin/integrations/axonico/comprobante (unitário) e
 * .../lancamentos/lote, contra o STUB local do Axonico (`axonicoStubServer.ts`), NUNCA a API real
 * (não existe sandbox — todo PUT real GERA FATURAMENTO em produção de terceiro).
 *
 * `AXONICO_BASE_URL` já aponta para `http://host.docker.internal:9912` (docker-compose.test.yml) —
 * o stub sobe NESTE processo (fora do container) na porta 9912, e o container da API alcança via
 * `host.docker.internal` (extra_hosts já configurado). O banco é real (enlite_e2e).
 */

import { execFileSync } from 'child_process';
import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend, createPatientFixture } from './helpers';
import { startAxonicoStub, type AxonicoStub } from './helpers/axonicoStubServer';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const AXONICO_STUB_PORT = 9912;
const TODAY = '2026-09-18';
// Datas DISTINTAS por bloco de teste — necessário desde a correção 18/09/2026: o dedupe (guard 2)
// passou a ser chaveado por `document_number`, e o stub só tem 3 DNIs cadastrados
// (30111111/30222222/30333333, reciclados em vários describes). Antes da correção, cada teste
// usava um `patientId` (UUID) novo e nunca colidia mesmo reciclando DNI; agora dois testes com o
// MESMO (DNI, serviceType, serviceDate) colidiriam um com o outro — por isso cada bloco usa sua
// própria data, exceto quando o teste em si é sobre A colisão proposital (o describe abaixo).
const DATE_DUPLICADO_LOCAL = '2026-09-17';
const DATE_DNI_DUP = '2026-09-16';
const DATE_LOTE = '2026-09-15';

describe('Axonico Lançamento API (F4)', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;
  let stub: AxonicoStub;

  const patientIds: string[] = [];
  const lancamentoIds: number[] = [];

  async function patientComDni(slug: string, dni: string): Promise<string> {
    const id = await createPatientFixture(pool, slug);
    await pool.query(`UPDATE patients SET document_number = $2 WHERE id = $1`, [id, dni]);
    patientIds.push(id);
    return id;
  }

  /** Pré-semeia dedupe LOCAL (guard 2) — insere `status='enviado'` para a tripla (agora chaveada
   *  por `document_number`, correção 18/09/2026 — migration 445), o que faz o use case devolver
   *  `duplicado` SEM tocar o stub (prova exigida: contador do espião = 0). `documentNumber` é
   *  OBRIGATÓRIO (a coluna é NOT NULL) — sempre o DNI do MESMO paciente passado como `patientId`. */
  async function semearDuplicadoLocal(patientId: string, documentNumber: string, serviceDate: string): Promise<void> {
    const r = await pool.query(
      `INSERT INTO axonico_comprobante_lancamento
         (patient_id, document_number, service_type, service_date, hours, numero_comprobante, cod_autorizacion, status, error_message)
       VALUES ($1, $2, 'AT', $3, 1, 'CMP-ORIGINAL', 'AUT-ORIGINAL', 'enviado', NULL)
       RETURNING id`,
      [patientId, documentNumber, serviceDate],
    );
    lancamentoIds.push(r.rows[0].id as number);
  }

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'axonico-lancamento-admin',
      email: 'axonico-lancamento-admin@e2e.local',
      role: 'admin',
    });
    workerToken = await getMockToken(api, {
      uid: 'axonico-lancamento-worker',
      email: 'axonico-lancamento-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    stub = await startAxonicoStub(
      [
        { dni: '30111111', historiaClinica: 'HC-001', nroCobertura: 'COB-001' },
        { dni: '30222222', historiaClinica: 'HC-002', nroCobertura: 'COB-002' },
        { dni: '30333333', historiaClinica: 'HC-003', nroCobertura: 'COB-003' },
      ],
      AXONICO_STUB_PORT,
    );
  });

  afterAll(async () => {
    if (lancamentoIds.length > 0) {
      await pool.query(`DELETE FROM axonico_comprobante_lancamento WHERE id = ANY($1::bigint[])`, [lancamentoIds]).catch(() => {});
    }
    if (patientIds.length > 0) {
      await pool.query(`DELETE FROM axonico_comprobante_lancamento WHERE patient_id = ANY($1::uuid[])`, [patientIds]).catch(() => {});
      await pool.query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [patientIds]).catch(() => {});
    }
    await pool.end().catch(() => {});
    await stub.close();
  });

  function auth(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ═══════════════════════════════════════════════════════════════
  // Auth/ABAC
  // ═══════════════════════════════════════════════════════════════

  describe('auth', () => {
    it('retorna 401 sem token', async () => {
      const res = await api.post('/api/admin/integrations/axonico/comprobante', {});
      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const res = await api.post(
        '/api/admin/integrations/axonico/comprobante',
        {},
        auth(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Unitário feliz
  // ═══════════════════════════════════════════════════════════════

  describe('unitário — caminho feliz', () => {
    it('200 + numeroComprobante, e o stub RECEBEU as chamadas (contador > 0)', async () => {
      // CORREÇÃO (19/09/2026): contrato não recebe mais `patientId` — o lançamento é feito pelo
      // `documentNumber` (DNI) direto. `patientComDni` continua criando o paciente-fixture só para
      // manter dado realista de apoio (afterAll limpa por `patientIds`); o corpo da chamada não usa
      // o id que ele devolve.
      await patientComDni('axonico-feliz', '30111111');
      const before = { ...stub.requestCounts };

      const res = await api.post(
        '/api/admin/integrations/axonico/comprobante',
        { documentNumber: '30111111', serviceType: 'AT', serviceDate: TODAY, hours: 3 },
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.status).toBe('enviado');
      expect(res.data.data.numeroComprobante).toEqual(expect.stringMatching(/^CMP-/));
      expect(res.data.data.codAutorizacion).toEqual(expect.stringMatching(/^AUT-/));

      // ESPIÃO — imprime o contador literal (exigido no fecho, não só a asserção).
      // eslint-disable-next-line no-console
      console.log('[ESPIÃO][caso FELIZ] stub.requestCounts =', JSON.stringify(stub.requestCounts));

      // Prova de que o stub foi de fato exercitado — baseline para o teste "duplicado = 0".
      expect(stub.requestCounts.pacienteFilter).toBeGreaterThan(before.pacienteFilter);
      expect(stub.requestCounts.comprobantePut).toBeGreaterThan(before.comprobantePut);
      expect(stub.requestCounts.medicoParametroPortalFilter).toBeGreaterThan(before.medicoParametroPortalFilter);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Unitário duplicado (dedupe LOCAL — guard 2)
  // ═══════════════════════════════════════════════════════════════

  describe('unitário — duplicado (dedupe local)', () => {
    it('200 + jaFaturado=true, e o stub NÃO recebe requisição NENHUMA (contador = 0)', async () => {
      const patientId = await patientComDni('axonico-duplicado', '30222222');
      await semearDuplicadoLocal(patientId, '30222222', DATE_DUPLICADO_LOCAL);

      const before = { ...stub.requestCounts };

      // CORREÇÃO (19/09/2026): body pelo `documentNumber`, não mais `patientId`.
      const res = await api.post(
        '/api/admin/integrations/axonico/comprobante',
        { documentNumber: '30222222', serviceType: 'AT', serviceDate: DATE_DUPLICADO_LOCAL, hours: 2 },
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.status).toBe('duplicado');
      expect(res.data.data.jaFaturado).toBe(true);
      expect(res.data.data.numeroComprobante).toBe('CMP-ORIGINAL');
      expect(res.data.data.codAutorizacion).toBe('AUT-ORIGINAL');

      // ESPIÃO — imprime o contador literal ANTES e DEPOIS (exigido no fecho).
      // eslint-disable-next-line no-console
      console.log('[ESPIÃO][caso DUPLICADO LOCAL] antes =', JSON.stringify(before), '| depois =', JSON.stringify(stub.requestCounts));

      // O CONTADOR não se mexeu — nenhuma rota do stub foi tocada.
      expect(stub.requestCounts).toEqual(before);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Correção 18/09/2026 — DOIS pacientes (patient_id DISTINTOS) com o MESMO DNI: o dedupe tem
  // que ser pelo DNI (a chave que o Axonico fatura), não pelo patient_id. ANTES da correção, cada
  // patient_id passava o guard 2 isoladamente e os dois viravam PUT /api/comprobante reais —
  // FATURAMENTO DUPLICADO da mesma historia_clinica. Esta é a inversão exigida pelo item (f).
  //
  // ⚠️ NOTA (19/09/2026, conserto de contrato): a premissa original — "dois patientId DISTINTOS
  // compartilhando o mesmo DNI" — não é mais representável NESTE endpoint: o contrato novo não
  // recebe `patientId` (o use case grava `patientId: null` sempre, D-19/09). Não existe mais forma
  // de a chamada HTTP "ser" o patientA ou o patientB — a única identidade que a rota enxerga é o
  // `documentNumber`. Por isso o teste abaixo já NÃO prova mais "dedupe ignora patient_id
  // diferente" (essa garantia virou trivial/inexistente na borda HTTP); prova apenas que DUAS
  // chamadas reais e sequenciais com o MESMO `documentNumber` deduplicam (2ª não fatura de novo) —
  // redundante com 'unitário — duplicado (dedupe local)' acima, mantido aqui por não ter sido
  // pedido para apagar cobertura. `patientA`/`patientB` seguem criados só para preservar o dado de
  // apoio do cenário histórico; nenhum dos dois entra no corpo da chamada.
  // ═══════════════════════════════════════════════════════════════

  describe('CORREÇÃO — duas chamadas sequenciais com o mesmo documentNumber (patientId não existe mais no contrato)', () => {
    it('primeira chamada fatura; a SEGUNDA (mesmo documentNumber) tem que vir duplicado, com o comprovante da primeira, e o stub NÃO pode faturar de novo (comprobantePut não pode subir na segunda chamada)', async () => {
      const DNI_COMPARTILHADO = '30111111'; // já cadastrado no stub (beforeAll)
      await patientComDni('axonico-dni-dup-a', DNI_COMPARTILHADO);
      await patientComDni('axonico-dni-dup-b', DNI_COMPARTILHADO);

      // ── Primeira chamada — fatura de verdade, toca o stub. ──
      const resA = await api.post(
        '/api/admin/integrations/axonico/comprobante',
        { documentNumber: DNI_COMPARTILHADO, serviceType: 'AT', serviceDate: DATE_DNI_DUP, hours: 2 },
        auth(adminToken),
      );
      expect(resA.status).toBe(200);
      expect(resA.data.data.status).toBe('enviado');
      const numeroComprobanteOriginal = resA.data.data.numeroComprobante as string;
      const codAutorizacionOriginal = resA.data.data.codAutorizacion as string;

      const comprobantePutAposPrimeira = stub.requestCounts.comprobantePut;

      // ── Segunda chamada — MESMO documentNumber, MESMO serviceType/serviceDate. ──
      const resB = await api.post(
        '/api/admin/integrations/axonico/comprobante',
        { documentNumber: DNI_COMPARTILHADO, serviceType: 'AT', serviceDate: DATE_DNI_DUP, hours: 2 },
        auth(adminToken),
      );

      // ESPIÃO — imprime os dois resultados e o contador do stub (exigido no fecho).
      // eslint-disable-next-line no-console
      console.log(
        '[ESPIÃO][mesmo documentNumber, duas chamadas] resA.data=',
        JSON.stringify(resA.data.data),
        '| resB.data=',
        JSON.stringify(resB.data.data),
        '| stub.requestCounts=',
        JSON.stringify(stub.requestCounts),
      );

      // A PROVA da correção: a segunda chamada é 'duplicado', carrega o comprovante ORIGINAL (de
      // patientA), e o stub NÃO recebeu um segundo PUT — sem isso, seria um segundo faturamento
      // real da MESMA historia_clinica no Axonico.
      expect(resB.status).toBe(200);
      expect(resB.data.data.status).toBe('duplicado');
      expect(resB.data.data.jaFaturado).toBe(true);
      expect(resB.data.data.numeroComprobante).toBe(numeroComprobanteOriginal);
      expect(resB.data.data.codAutorizacion).toBe(codAutorizacionOriginal);
      expect(stub.requestCounts.comprobantePut).toBe(comprobantePutAposPrimeira);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Hora quebrada — 400 ANTES de tocar o stub
  // ═══════════════════════════════════════════════════════════════

  describe('unitário — hora quebrada (D366)', () => {
    it('400 e o stub NÃO recebe requisição NENHUMA (contador = 0)', async () => {
      await patientComDni('axonico-hora-quebrada', '30333333');
      const before = { ...stub.requestCounts };

      // CORREÇÃO (19/09/2026): body pelo `documentNumber`, não mais `patientId`.
      const res = await api.post(
        '/api/admin/integrations/axonico/comprobante',
        { documentNumber: '30333333', serviceType: 'AT', serviceDate: TODAY, hours: 2.5 },
        auth(adminToken),
      );

      // ESPIÃO — imprime o contador literal ANTES e DEPOIS (exigido no fecho).
      // eslint-disable-next-line no-console
      console.log('[ESPIÃO][caso HORA QUEBRADA] antes =', JSON.stringify(before), '| depois =', JSON.stringify(stub.requestCounts));

      expect(res.status).toBe(400);
      expect(stub.requestCounts).toEqual(before);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Lote misto — 2 ok + 1 duplicado + 1 tipo sem mapeamento
  // ═══════════════════════════════════════════════════════════════

  describe('lote — misto', () => {
    it('4 status certos, sem abortar o laço', async () => {
      const patientDup = await patientComDni('axonico-lote-dup', '30333333');
      // CORREÇÃO (19/09/2026): dedupe é por (documentNumber, serviceType, serviceDate) — não por
      // patient_id (migration 445/446). '30111111' aparece em dois itens do lote com serviceType
      // DIFERENTE (AT vs CAREGIVER), então não colide com o item 'ok' de mesmo DNI.
      await semearDuplicadoLocal(patientDup, '30333333', DATE_LOTE);

      const res = await api.post(
        '/api/admin/integrations/axonico/comprobante/lote',
        {
          itens: [
            { documentNumber: '30111111', serviceType: 'AT', serviceDate: DATE_LOTE, hours: 1 },
            { documentNumber: '30222222', serviceType: 'AT', serviceDate: DATE_LOTE, hours: 2 },
            { documentNumber: '30333333', serviceType: 'AT', serviceDate: DATE_LOTE, hours: 1 },
            { documentNumber: '30111111', serviceType: 'CAREGIVER', serviceDate: DATE_LOTE, hours: 1 },
          ],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      const { summary, resultados } = res.data.data;

      expect(summary).toEqual({ total: 4, ok: 2, duplicado: 1, erro: 1 });
      expect(resultados[0].status).toBe('ok');
      expect(resultados[1].status).toBe('ok');
      expect(resultados[2].status).toBe('duplicado');
      expect(resultados[2].jaFaturado).toBe(true);
      expect(resultados[3].status).toBe('erro');
      expect(resultados[3].errorType).toBe('AxonicoUnmappedServiceTypeError');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Espião — zero chamadas a hosts de produção do Axonico em TODA a suíte
  // ═══════════════════════════════════════════════════════════════

  describe('espião — nenhuma chamada a produção', () => {
    it('AXONICO_BASE_URL do container nunca é um host de produção, e todo tráfego desta suíte passou pelo stub local', async () => {
      // CORREÇÃO (19/09/2026, endurecendo a asserção): `process.env` é o ambiente deste PROCESSO
      // DE TESTE (roda fora do Docker) — ele passa em silêncio pelo fallback acima mesmo quando o
      // CONTAINER da API não tem a variável definida (cairia no default de produção do
      // `AxonicoApiClient`, e este teste nunca perceberia). A prova real tem de ler a env de dentro
      // do container `enlite-api` — mesmo padrão de `guardAxonicoEnvOuFalha` em
      // `enlite-frontend/e2e/integration/anacare-hours-axonico-envio.integration.e2e.ts`.
      let baseUrlUsadaPeloContainer: string;
      try {
        baseUrlUsadaPeloContainer = execFileSync('docker', ['exec', 'enlite-api', 'printenv', 'AXONICO_BASE_URL'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
          .toString()
          .trim();
      } catch (err) {
        throw new Error(
          `[isolamento-axonico] não consegui ler AXONICO_BASE_URL do container enlite-api — RECUSANDO assumir isolamento por fallback: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      expect(baseUrlUsadaPeloContainer.length).toBeGreaterThan(0);
      expect(baseUrlUsadaPeloContainer).not.toMatch(/axonico\.ar/);

      // Toda a suíte já rodou: o stub foi de fato exercitado pelos casos que tocam rede (feliz +
      // 2 "ok" do lote). NÃO afirmamos `login > 0` aqui: `AxonicoApiClient` cacheia a sessão em
      // memória (rota memoiza o client — ver `adminIntegrationsRoutes.ts`) e um container de API
      // de vida longa, reaproveitado entre corridas de teste, pode já chegar autenticado — isso é
      // o comportamento CORRETO do re-login (só em 401), não falha de rede.
      expect(stub.requestCounts.comprobantePut).toBeGreaterThan(0);
      expect(stub.requestCounts.pacienteFilter).toBeGreaterThan(0);
    });
  });
});
