import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  limparTrilhaDrenada,
  aguardarTrilhaQuieta,
  contarTrilhaEstavel,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

/**
 * A TERCEIRA FAMÍLIA VIRADA — HTTP REAL, BANCO REAL (task 3.5/3.8, design 6).
 *
 * O contrato genérico (sem grupo → `no_group`, conta em admissão →
 * `account_not_active`, cache × invalidação) é provado em
 * `permission-enforcement-admin-users`, e a granularidade read×write em
 * `-admin-patients`. **Este arquivo prova o que é específico de `admin.workers`:**
 *
 *  1. **O CAMINHO DA LUZ** — 4 das 31 rotas são `requireStaffOrApiKey` e quem as
 *     consome é o triage-service por CHAVE DE API. O principal é
 *     `service:<nome>`, que não existe em `users`: sem o desvio de principal de
 *     serviço, virar esta família derrubaria a Luz em produção com 403. Aqui a
 *     chave é REAL (`ENLITE_API_KEYS` + `MultiAuthService` de produção, com
 *     `USE_MOCK_AUTH` desligado no bloco) — um dublê provaria o dublê.
 *  2. **`worker_pii:read` × `worker:read`** — a distinção mais cara da família:
 *     listar prestadores não é ver telefone e documento. Desde a D286 fase 2
 *     (06/09) a FICHA abre com `worker:read` e sai PROJETADA por container
 *     (contato, dossiê, documentos, encuadres) — a célula continua separando
 *     quem vê PII de quem não vê, só que no builder, não na porta. `by-phone`
 *     (a Luz, principal de serviço) continua na porta.
 *  3. **`worker:export`** — exportar a base inteira não é um caso de `read`.
 *  4. **`worker_document:validate`** — validar documento não é `read` nem `write`.
 *  5. **D-P4**: `worker_pii` e `worker_document` são sensíveis, então o acesso
 *     PERMITIDO também vira linha na trilha (não só a negativa).
 *  6. **O app do prestador não é da família**: as 9 rotas `/api/workers/me/*`
 *     moram no MESMO arquivo das 4 rotas admin de documentos adicionais e NÃO
 *     declaram célula. É o erro que o dia da virada tornaria irreversível.
 *  7. Família fora de `PERMISSION_ENFORCED_ROUTES` não muda nada — o que torna
 *     este PR seguro de mergear.
 *
 * ⚠️ Mock do jest é PROIBIDO aqui. A única substituição são os controllers
 * (precisam de GCS/Firebase/Talentum e não são o objeto do teste): os handlers
 * devolvem 200 com um marcador, então "passou" e "não passou" são inequívocos.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/** A chave que o triage-service usaria. Só existe dentro desta suíte. */
const API_KEY_E2E = 'enlite_e2e_triage_key';

describe('família admin.workers sob a decisão real por célula (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const U = {
    /** `worker:read` apenas — vê a LISTA, não abre a ficha. */
    lista: 'perm-wrk-e2e-lista',
    /** `worker:read|write` + `worker_pii:read` — a recrutadora completa, sem documento. */
    recrutadora: 'perm-wrk-e2e-recrutadora',
    /** só documentos (`worker_document:read|write|delete|validate`) — a mesa de validação. */
    documentos: 'perm-wrk-e2e-documentos',
    /** `worker:export` e nada mais. */
    exportadora: 'perm-wrk-e2e-exportadora',
  };
  const GRUPOS = {
    lista: 'Perm Wrk E2E Lista',
    recrutadora: 'Perm Wrk E2E Recrutadora',
    documentos: 'Perm Wrk E2E Documentos',
    exportadora: 'Perm Wrk E2E Exportadora',
  };

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(chave: string, valor: string): void {
    if (!(chave in envAnterior)) envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string | null,
    alvo: AppDeFamilia = app,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${alvo.url}${caminho}`, {
      method: metodo,
      headers: {
        ...(uid ? { Authorization: tokenMock(uid) } : {}),
        'Content-Type': 'application/json',
      },
      ...(metodo === 'POST' || metodo === 'PUT' || metodo === 'PATCH' ? { body: '{}' } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
  }

  async function semear(): Promise<void> {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'perm-wrk-lista@e2e.local',       'admin', 'ACTIVE', true, $5),
         ($2, 'perm-wrk-recrutadora@e2e.local', 'admin', 'ACTIVE', true, $5),
         ($3, 'perm-wrk-documentos@e2e.local',  'admin', 'ACTIVE', true, $5),
         ($4, 'perm-wrk-exportadora@e2e.local', 'admin', 'ACTIVE', true, $5)`,
      [U.lista, U.recrutadora, U.documentos, U.exportadora, TENANT_E2E],
    );

    await grupoComCelulas(pool, { nome: GRUPOS.lista, uid: U.lista, celulas: [['worker', 'read']] });
    await grupoComCelulas(pool, {
      nome: GRUPOS.recrutadora,
      uid: U.recrutadora,
      celulas: [
        ['worker', 'read'],
        ['worker', 'create'],
        ['worker', 'update'],
        ['worker_pii', 'read'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.documentos,
      uid: U.documentos,
      celulas: [
        ['worker_document', 'read'],
        ['worker_document', 'create'],
        ['worker_document', 'update'],
        ['worker_document', 'delete'],
        ['worker_document', 'validate'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.exportadora,
      uid: U.exportadora,
      celulas: [['worker', 'export']],
    });
  }

  /** Handlers-marcador: só dizem que chegaram. */
  function controllersMarcadores() {
    const marca = (nome: string) => (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: nome });
    return {
      workers: {
        getWorkerByPhone: marca('getWorkerByPhone'),
        exportWorkers: marca('exportWorkers'),
        getWorkerById: marca('getWorkerById'),
        listWorkers: marca('listWorkers'),
      },
      aux: {
        getWorkerDateStats: marca('getWorkerDateStats'),
        listCaseOptions: marca('listCaseOptions'),
        getFilterOptions: marca('getFilterOptions'),
        syncTalentumWorkers: marca('syncTalentumWorkers'),
      },
      testFlag: { updateTestFlag: marca('updateTestFlag') },
      profile: { updateProfile: marca('updateProfile') },
      serviceArea: { updateServiceArea: marca('updateServiceArea') },
      tags: {
        list: marca('tags.list'),
        create: marca('tags.create'),
        update: marca('tags.update'),
        delete: marca('tags.delete'),
        assign: marca('tags.assign'),
        remove: marca('tags.remove'),
      },
      timeline: { getTimeline: marca('getTimeline') },
      docs: {
        getUploadSignedUrl: marca('docs.upload-url'),
        saveDocumentPath: marca('docs.save'),
        getViewSignedUrl: marca('docs.view-url'),
        deleteDocument: marca('docs.delete'),
        validateDocument: marca('docs.validate'),
        invalidateDocument: marca('docs.invalidate'),
      },
      meDocs: {
        getDocuments: marca('me.getDocuments'),
        getUploadSignedUrl: marca('me.upload-url'),
        saveDocumentPath: marca('me.save'),
        getViewSignedUrl: marca('me.view-url'),
        deleteDocument: marca('me.delete'),
      },
      meAdditional: {
        list: marca('me.additional.list'),
        getUploadUrl: marca('me.additional.upload-url'),
        save: marca('me.additional.save'),
        remove: marca('me.additional.remove'),
      },
      adminAdditional: {
        list: marca('admin.additional.list'),
        getUploadUrl: marca('admin.additional.upload-url'),
        save: marca('admin.additional.save'),
        remove: marca('admin.additional.remove'),
      },
      contexto: {
        currentInterview: marca('currentInterview'),
        availableVacancies: marca('availableVacancies'),
        ingestFromUrl: marca('ingestFromUrl'),
      },
    };
  }

  /**
   * Monta as QUATRO peças da família (é isso que faz dela uma família só) mais
   * o lado self-service do prestador, que divide arquivo com uma delas.
   */
  async function subirApp(
    familiasEnforced: string,
    auth?: import('@modules/identity').AuthMiddleware,
  ): Promise<AppDeFamilia> {
    const { createAdminWorkerRoutes, createAdminWorkerDocumentsRoutes, createWorkerDocumentsRoutes } =
      await import('@modules/worker');
    const { createWorkerContextRoutes } = await import('@modules/matching/interfaces/routes/workerContextRoutes');
    const c = controllersMarcadores();

    return montarAppDeFamilia({
      enforcedRoutes: familiasEnforced,
      ...(auth ? { auth } : {}),
      montarRotas: ({ app: express, auth: authReal, permissions }) => {
        express.use(
          '/api/admin',
          createAdminWorkerRoutes(
            {
              workers: c.workers, aux: c.aux, testFlag: c.testFlag, profile: c.profile,
              serviceArea: c.serviceArea, tags: c.tags, timeline: c.timeline,
            } as never,
            authReal,
            permissions,
          ),
        );
        express.use('/api/admin', createAdminWorkerDocumentsRoutes(c.docs as never, authReal, permissions));
        express.use(
          '/api',
          createWorkerDocumentsRoutes(
            c.meDocs as never, c.meAdditional as never, c.adminAdditional as never, authReal, permissions,
          ),
        );
        express.use('/api/admin', createWorkerContextRoutes(c.contexto as never, authReal, permissions));
      },
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await semear();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.workers');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    app = await subirApp('admin.workers');
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await pool.end();
    for (const [chave, valor] of Object.entries(envAnterior)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  });

  describe('worker_pii:read × worker:read — a distinção mais cara da família', () => {
    it('quem tem worker:read lista prestadores', async () => {
      expect(await chamar('GET', '/api/admin/workers', U.lista)).toMatchObject({
        status: 200,
        body: { chegou: 'listWorkers' },
      });
    });

    it('… e ABRE a ficha (D286 fase 2): a rota exige worker:read; o dossiê sai projetado', async () => {
      // Até 06/09 a ficha inteira exigia `worker_pii:read`. Agora a célula da rota é a operacional
      // e quem segura DNI/nascimento/endereço é a projeção por container no builder — a prova
      // disso é o espião de decrypt = 0 em `AdminWorkersDetailBuilder.test.ts`, não este stub.
      expect(await chamar('GET', '/api/admin/workers/abc-123', U.lista)).toMatchObject({
        status: 200,
        body: { chegou: 'getWorkerById' },
      });
    });

    it('a recrutadora, que tem worker_pii:read, também abre a ficha', async () => {
      expect(await chamar('GET', '/api/admin/workers/abc-123', U.recrutadora)).toMatchObject({
        status: 200,
        body: { chegou: 'getWorkerById' },
      });
    });

    it('by-phone continua exigindo worker_pii:read — é o dossiê da Luz (principal de serviço, sem projeção)', async () => {
      // O mapa da 0.6 dizia `worker:read`. Se voltar a dizer, este caso fica vermelho: por aqui o
      // principal de serviço recebe a ficha INTEIRA (`cells = null`, D113), então a célula da rota
      // é a única barreira para um humano com célula fraca.
      const negado = await chamar('GET', '/api/admin/workers/by-phone', U.lista);
      expect(negado.status).toBe(403);
      expect(negado.body).toMatchObject({ code: 'missing_cell' });

      expect(await chamar('GET', '/api/admin/workers/by-phone', U.recrutadora)).toMatchObject({
        status: 200,
        body: { chegou: 'getWorkerByPhone' },
      });
    });

    it.each([
      ['GET', '/api/admin/workers/stats', 'getWorkerDateStats'],
      ['GET', '/api/admin/workers/filter-options', 'getFilterOptions'],
      ['GET', '/api/admin/workers/abc-123/timeline', 'getTimeline'],
    ])('%s %s continua em worker:read (não é PII)', async (metodo, caminho, handler) => {
      expect(await chamar(metodo, caminho, U.lista)).toMatchObject({ status: 200, body: { chegou: handler } });
    });
  });

  describe('escrita e as células que não são o óbvio', () => {
    it('quem só lê NÃO edita o perfil do prestador', async () => {
      expect((await chamar('PATCH', '/api/admin/workers/abc-123/profile', U.lista)).status).toBe(403);
    });

    it('a recrutadora, com worker:write, edita', async () => {
      expect(await chamar('PATCH', '/api/admin/workers/abc-123/profile', U.recrutadora)).toMatchObject({
        status: 200,
        body: { chegou: 'updateProfile' },
      });
    });

    it('exportar a base NÃO é ler: worker:read inteiro não abre o export', async () => {
      expect((await chamar('GET', '/api/admin/workers/export', U.recrutadora)).status).toBe(403);
    });

    it('… e quem tem worker:export exporta, sem nenhuma outra célula', async () => {
      expect(await chamar('GET', '/api/admin/workers/export', U.exportadora)).toMatchObject({
        status: 200,
        body: { chegou: 'exportWorkers' },
      });
    });

    it('sincronizar com o Talentum é talentum:write — não worker:write', async () => {
      expect((await chamar('POST', '/api/admin/workers/sync-talentum', U.recrutadora)).status).toBe(403);
    });
  });

  describe('worker_document — recurso próprio, quatro ações', () => {
    it('a recrutadora (worker:*) não toca documento', async () => {
      expect((await chamar('POST', '/api/admin/workers/abc-123/documents/view-url', U.recrutadora)).status).toBe(403);
    });

    it.each([
      ['POST', '/api/admin/workers/abc-123/documents/view-url', 'docs.view-url'],
      ['POST', '/api/admin/workers/abc-123/documents/save', 'docs.save'],
      ['DELETE', '/api/admin/workers/abc-123/documents/dni', 'docs.delete'],
      ['POST', '/api/admin/workers/abc-123/documents/dni/validate', 'docs.validate'],
      ['DELETE', '/api/admin/workers/abc-123/documents/dni/validate', 'docs.invalidate'],
      ['GET', '/api/admin/workers/abc-123/additional-documents', 'admin.additional.list'],
      ['DELETE', '/api/admin/workers/abc-123/additional-documents/d1', 'admin.additional.remove'],
    ])('a mesa de validação faz %s %s', async (metodo, caminho, handler) => {
      expect(await chamar(metodo, caminho, U.documentos)).toMatchObject({
        status: 200,
        body: { chegou: handler },
      });
    });

    it('validar documento é célula PRÓPRIA: quem só lê e escreve documento não valida', async () => {
      const soLeituraEscrita = 'perm-wrk-e2e-doc-parcial';
      const grupo = 'Perm Wrk E2E Doc Parcial';
      await pool.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
           VALUES ($1, 'perm-wrk-doc-parcial@e2e.local', 'admin', 'ACTIVE', true, $2)`,
        [soLeituraEscrita, TENANT_E2E],
      );
      await grupoComCelulas(pool, {
        nome: grupo,
        uid: soLeituraEscrita,
        celulas: [
          ['worker_document', 'read'],
          ['worker_document', 'create'],
          ['worker_document', 'update'],
        ],
      });
      try {
        expect(
          (await chamar('POST', '/api/admin/workers/abc-123/documents/dni/validate', soLeituraEscrita)).status,
        ).toBe(403);
        expect(
          await chamar('POST', '/api/admin/workers/abc-123/documents/save', soLeituraEscrita),
        ).toMatchObject({ status: 200, body: { chegou: 'docs.save' } });
      } finally {
        await limparIamFixtures(pool, { uids: [soLeituraEscrita], grupos: [grupo] });
      }
    });
  });

  describe('o app do PRESTADOR não é da família (o erro que a virada tornaria irreversível)', () => {
    it.each([
      ['GET', '/api/workers/me/documents', 'me.getDocuments'],
      ['POST', '/api/workers/me/documents/save', 'me.save'],
      ['GET', '/api/workers/me/additional-documents', 'me.additional.list'],
      ['DELETE', '/api/workers/me/additional-documents/d1', 'me.additional.remove'],
    ])('%s %s passa mesmo sem NENHUMA célula de documento', async (metodo, caminho, handler) => {
      // U.lista tem só `worker:read` — se estas rotas tivessem célula de
      // documento declarada, cairiam em 403 aqui e no dia da virada.
      expect(await chamar(metodo, caminho, U.lista)).toMatchObject({ status: 200, body: { chegou: handler } });
    });
  });

  describe('trilha (D-P4: worker_pii e worker_document são sensíveis)', () => {
    it('a negativa em worker_pii vira linha DENY (na rota que ainda a exige: by-phone)', async () => {
      await limparTrilhaDrenada(pool, [U.lista]);

      await chamar('GET', '/api/admin/workers/by-phone?phone=%2B5491100000000', U.lista);
      const trilha = await aguardarTrilhaQuieta(pool, [U.lista], 1, 'resource, action, decision');
      expect(trilha).toEqual([
        expect.objectContaining({
          resource: 'worker_pii',
          action: 'read',
          decision: 'DENY',
        }),
      ]);
    });

    it('o acesso PERMITIDO ao dossiê também é registrado', async () => {
      await limparTrilhaDrenada(pool, [U.recrutadora]);

      await chamar('GET', '/api/admin/workers/by-phone?phone=%2B5491100000000', U.recrutadora);
      const trilha = await aguardarTrilhaQuieta(pool, [U.recrutadora], 1, 'resource, action, decision');
      expect(trilha).toEqual([
        expect.objectContaining({ resource: 'worker_pii', action: 'read', decision: 'ALLOW' }),
      ]);
    });

    it('listar prestadores NÃO enche a trilha — worker:read não é sensível', async () => {
      await limparTrilhaDrenada(pool, [U.lista]);

      await chamar('GET', '/api/admin/workers', U.lista);
      const n = await contarTrilhaEstavel(pool, [U.lista]);
      expect(n).toBe(0);
    });
  });

  describe('O CAMINHO DA LUZ — chave de API real, sem mock de autenticação', () => {
    let appChave: AppDeFamilia;

    beforeAll(async () => {
      // A chave é lida na CONSTRUÇÃO da estratégia (`loadFromEnv`) — por isso a
      // env vem antes do `new MultiAuthService`. E `USE_MOCK_AUTH` sai do ar
      // neste bloco: em modo mock o `requireStaffOrApiKey` faz short-circuit e
      // o caminho da chave nunca roda — testar ali provaria o mock.
      setEnv('ENLITE_API_KEYS', `triage-service:${API_KEY_E2E}`);
      setEnv('USE_MOCK_AUTH', 'false');

      const identity = await import('@modules/identity');
      const multi = new identity.MultiAuthService({ enableApiKeys: true, enableGoogleIdToken: false } as never);
      const auth = new identity.AuthMiddleware(
        multi,
        new identity.SimplifiedAuthorizationEngine(),
        undefined as never,
      );
      appChave = await subirApp('admin.workers', auth);
    }, 30000);

    afterAll(async () => {
      await appChave?.fechar();
      process.env.USE_MOCK_AUTH = 'true';
    });

    async function comChave(metodo: string, caminho: string) {
      const res = await fetch(`${appChave.url}${caminho}`, {
        method: metodo,
        headers: { Authorization: `Bearer ${API_KEY_E2E}`, 'Content-Type': 'application/json' },
        ...(metodo === 'POST' ? { body: '{}' } : {}),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    }

    it.each([
      ['GET', '/api/admin/workers/by-phone', 'getWorkerByPhone'],
      ['GET', '/api/admin/workers/abc-123/current-interview', 'currentInterview'],
      ['GET', '/api/admin/workers/abc-123/available-vacancies', 'availableVacancies'],
      ['POST', '/api/admin/workers/abc-123/documents/ingest-from-url', 'ingestFromUrl'],
    ])('%s %s atravessa a família ENFORÇADA (é o triage-service, não uma pessoa)', async (metodo, caminho, handler) => {
      expect(await comChave(metodo, caminho)).toMatchObject({ status: 200, body: { chegou: handler } });
    });

    it('a chave NÃO vira linha na trilha de permissão — não houve decisão de grupo', async () => {
      // `LIKE 'service:%'` — não há uid fixo para drenar por igualdade, então
      // a limpeza usa o padrão diretamente (o conjunto de uids de serviço é
      // pequeno e só este teste escreve nele).
      let anterior = -1;
      for (let i = 0; i < 20; i += 1) {
        const r = await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM iam.permission_audit_log WHERE user_id LIKE 'service:%'`,
        );
        const n = Number(r.rows[0].n);
        if (n === anterior) break;
        anterior = n;
        await new Promise((res) => setTimeout(res, 200));
      }
      await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id LIKE 'service:%'`);

      await comChave('GET', '/api/admin/workers/abc-123/current-interview');

      let atual = 0;
      anterior = -1;
      for (let i = 0; i < 20; i += 1) {
        const r = await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM iam.permission_audit_log WHERE user_id LIKE 'service:%'`,
        );
        atual = Number(r.rows[0].n);
        if (atual === anterior) break;
        anterior = atual;
        await new Promise((res) => setTimeout(res, 200));
      }
      expect(atual).toBe(0);
    });

    it('chave inválida segue barrada — o desvio é para SERVIÇO AUTENTICADO, não para qualquer um', async () => {
      const res = await fetch(`${appChave.url}/api/admin/workers/by-phone`, {
        headers: { Authorization: 'Bearer enlite_chave_que_nao_existe' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('rollout por família — o que torna este PR seguro de mergear', () => {
    it('com admin.workers FORA de PERMISSION_ENFORCED_ROUTES, quem não tem célula nenhuma passa', async () => {
      const outra = await subirApp('admin.users');
      try {
        const res = await fetch(`${outra.url}/api/admin/workers/abc-123`, {
          headers: { Authorization: tokenMock(U.exportadora) },
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ chegou: 'getWorkerById' });
      } finally {
        await outra.fechar();
      }
    });
  });

  it('sem credencial → 401 antes de qualquer decisão de permissão', async () => {
    expect((await chamar('GET', '/api/admin/workers', null)).status).toBe(401);
  });
});
