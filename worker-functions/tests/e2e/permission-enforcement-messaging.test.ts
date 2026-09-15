import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  limparTrilhaDrenada,
  aguardarTrilhaQuieta,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

/**
 * A4 — três famílias pequenas (`admin.messaging` 7 · `admin.integrations` 1 ·
 * `admin.test_fixtures` 1). HTTP real, banco real.
 *
 * 🚨 **NENHUM TESTE AQUI PODE TOCAR CANAL REAL** (memória `teste-nunca-toca-canal-real`;
 * incidente de 04/08, quando um handover de teste caiu no grupo real do time).
 * A garantia é ESTRUTURAL, não de disciplina: os controllers de mensageria são
 * substituídos por marcadores, então **nenhum caminho deste arquivo alcança
 * Twilio, Periskope ou o Ana Care**. O objeto do teste é a DECISÃO de permissão,
 * que acontece antes do handler; substituir o handler não enfraquece o que se
 * mede — e é o que garante que um DENY mal escrito não vire mensagem enviada.
 *
 * O que este arquivo prova, específico do A4:
 *
 *  1. **`messaging:send` ≠ `messaging:write`** — a decisão deste PR. Quem
 *     dispara NÃO reescreve o template que todos usam, e quem cura template não
 *     dispara. Cada linha de `message_templates` amarra um slug ao `content_sid`
 *     (o HSM aprovado pela Meta), então editar muda o que TODO envio futuro faz.
 *  2. **`messaging:read` não abre nem um nem outro.**
 *  3. **As duas células NOVAS fora do seed 206** (`integration:execute`,
 *     `test_fixtures:execute`) — semeadas à mão aqui, como `patient:delete` foi
 *     na 2ª família; em produção nascem quando o A7 ligar o sync do catálogo.
 *  4. **D-P4 pela ação**: `execute` é sensível → ALLOW vai à trilha.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('A4 — famílias de mensageria, integração e fixtures (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const U = {
    /** `messaging:send` + `messaging:read` — quem dispara. NÃO edita template. */
    disparo: 'perm-a4-e2e-disparo',
    /** `messaging:write` + `messaging:read` — quem cura template. NÃO dispara. */
    curadoria: 'perm-a4-e2e-curadoria',
    /** as duas células novas. */
    manutencao: 'perm-a4-e2e-manutencao',
  };
  const GRUPOS = {
    disparo: 'Perm A4 E2E Disparo',
    curadoria: 'Perm A4 E2E Curadoria',
    manutencao: 'Perm A4 E2E Manutenção',
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
      ...(metodo !== 'GET' && metodo !== 'DELETE' ? { body: '{}' } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /**
   * As três células NOVAS do A4. Removidas na ENTRADA e na SAÍDA (mesmo motivo
   * de `patient:delete` na 2ª família): se um processo morrer no meio, a linha
   * sobreviveria e `permissions-iam-schema` — que afirma a matriz exata de 41
   * células — passaria a falhar em toda rodada seguinte, sem se curar sozinha.
   */
  // Categoria IGUAL à que `RESOURCE_CATEGORY` declara (`PermissionCell.ts`) —
  // era 'Mensageria'/'Integrações'/'Manutenção', que o sync jamais produziria.
  // O painel agrupa a matriz POR CATEGORIA: fixture divergente põe a célula
  // numa gaveta que não existe na tela.
  const NOVAS: Array<[string, string, string]> = [
    ['messaging', 'create', 'Comunicação'],
    ['messaging', 'update', 'Comunicação'],
    ['integration', 'execute', 'Operações'],
    ['test_fixtures', 'execute', 'Operações'],
  ];

  async function removerCelulasNovas(): Promise<void> {
    for (const [recurso, acao] of NOVAS) {
      await pool.query(
        `DELETE FROM iam.group_permissions WHERE permission_id IN
           (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`,
        [recurso, acao],
      );
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [recurso, acao]);
    }
  }

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await removerCelulasNovas();
  }

  async function semear(): Promise<void> {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'perm-a4-disparo@e2e.local',    'admin', 'ACTIVE', true, $4),
         ($2, 'perm-a4-curadoria@e2e.local',  'admin', 'ACTIVE', true, $4),
         ($3, 'perm-a4-manutencao@e2e.local', 'admin', 'ACTIVE', true, $4)`,
      [U.disparo, U.curadoria, U.manutencao, TENANT_E2E],
    );

    for (const [recurso, acao, categoria] of NOVAS) {
      await pool.query(
        `INSERT INTO iam.permissions (resource, action, description, category) VALUES ($1, $2, $3, $4)`,
        [recurso, acao, `${recurso}:${acao} (célula nova da D116)`, categoria],
      );
    }

    await grupoComCelulas(pool, {
      nome: GRUPOS.disparo,
      uid: U.disparo,
      celulas: [
        ['messaging', 'send'],
        ['messaging', 'read'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.curadoria,
      uid: U.curadoria,
      celulas: [
        ['messaging', 'create'],
        ['messaging', 'update'],
        ['messaging', 'read'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.manutencao,
      uid: U.manutencao,
      celulas: [
        ['integration', 'execute'],
        ['test_fixtures', 'execute'],
      ],
    });
  }

  async function subirApp(familiasEnforced: string): Promise<AppDeFamilia> {
    const { createMessagingRoutes } = await import('@modules/notification/interfaces/routes/messagingRoutes');
    const { createAdminIntegrationsRoutes } = await import(
      '@modules/integration/interfaces/routes/adminIntegrationsRoutes'
    );
    const { createTestFixturesRoutes } = await import('../../src/interfaces/routes/testFixturesRoutes');

    const marca = (nome: string) => (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: nome });
    // 🚨 Marcadores no lugar dos controllers de mensageria: é o que impede
    // qualquer caminho deste arquivo de alcançar Twilio/Periskope/Ana Care.
    const controllerFalso = {
      sendVacancyMatch: marca('sendVacancyMatch'),
      sendDirect: marca('sendDirect'),
      listTemplates: marca('listTemplates'),
      createTemplate: marca('createTemplate'),
      updateTemplate: marca('updateTemplate'),
      deleteTemplate: marca('deleteTemplate'),
      bulkDispatchIncomplete: marca('bulkDispatchIncomplete'),
    };

    return montarAppDeFamilia({
      enforcedRoutes: familiasEnforced,
      montarRotas: ({ app: express, auth, permissions }) => {
        const messaging = createMessagingRoutes({} as never, {} as never, permissions);
        // Troca os handlers reais pelos marcadores DEPOIS da montagem: os guards
        // de célula (que são o objeto do teste) continuam os de PRODUÇÃO.
        //
        // A chave é `MÉTODO path`, não só o path: `/templates` é GET e POST, e
        // `/templates/:slug` é PUT e DELETE. Chaveando só por caminho, POST
        // receberia o handler do GET — a troca "funcionaria" e o teste passaria,
        // porque os casos daquelas rotas só afirmam 403. O contador abaixo é o
        // que impede esse erro de voltar calado.
        let trocados = 0;
        for (const camada of (messaging as unknown as {
          stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }>;
        }).stack) {
          const rota = camada.route;
          if (!rota) continue;
          const metodo = Object.keys(rota.methods).find((m) => rota.methods[m])?.toUpperCase();
          const nome = NOME_POR_ROTA[`${metodo} ${rota.path}`];
          if (!nome) continue;
          rota.stack[rota.stack.length - 1].handle = controllerFalso[nome as keyof typeof controllerFalso] as never;
          trocados += 1;
        }
        if (trocados !== 7) {
          throw new Error(
            `esperava trocar 7 handlers de mensageria e troquei ${trocados} — ` +
              'algum handler REAL ficaria de pé, e este arquivo não pode alcançar Twilio/Periskope',
          );
        }
        express.use('/api/admin/messaging', messaging);
        express.use('/api/admin', createAdminIntegrationsRoutes(auth, permissions));
        express.use(
          '/api/admin/test-fixtures',
          createTestFixturesRoutes({ cleanup: marca('cleanup') } as never, auth, permissions),
        );
      },
    });
  }

  /** `MÉTODO path` do router → método do controller (para a troca acima). */
  const NOME_POR_ROTA: Record<string, string> = {
    'POST /whatsapp/vacancy-match': 'sendVacancyMatch',
    'POST /whatsapp/direct': 'sendDirect',
    'GET /templates': 'listTemplates',
    'POST /templates': 'createTemplate',
    'PUT /templates/:slug': 'updateTemplate',
    'DELETE /templates/:slug': 'deleteTemplate',
    'POST /bulk-dispatch-incomplete': 'bulkDispatchIncomplete',
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await semear();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.messaging;admin.integrations;admin.test_fixtures');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    app = await subirApp('admin.messaging;admin.integrations;admin.test_fixtures');
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

  describe('messaging:send ≠ messaging:write — a decisão deste PR', () => {
    it('quem DISPARA não reescreve o template que todo mundo usa', async () => {
      const negado = await chamar('PUT', '/api/admin/messaging/templates/complete_register_ofc', U.disparo);
      expect(negado.status).toBe(403);
      expect(negado.body).toMatchObject({ code: 'missing_cell' });
    });

    it('… e não cria nem desativa template', async () => {
      expect((await chamar('POST', '/api/admin/messaging/templates', U.disparo)).status).toBe(403);
      expect((await chamar('DELETE', '/api/admin/messaging/templates/x', U.disparo)).status).toBe(403);
    });

    it('quem CURA template não dispara mensagem', async () => {
      for (const caminho of [
        '/api/admin/messaging/whatsapp/vacancy-match',
        '/api/admin/messaging/whatsapp/direct',
        '/api/admin/messaging/bulk-dispatch-incomplete',
      ]) {
        const res = await chamar('POST', caminho, U.curadoria);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'missing_cell' });
      }
    });

    it('cada um faz o SEU: disparo dispara, curadoria edita', async () => {
      expect(await chamar('POST', '/api/admin/messaging/whatsapp/direct', U.disparo)).toMatchObject({
        status: 200,
        body: { chegou: 'sendDirect' },
      });
      expect(await chamar('PUT', '/api/admin/messaging/templates/x', U.curadoria)).toMatchObject({
        status: 200,
        body: { chegou: 'updateTemplate' },
      });
    });

    it('a curadoria alcança as TRÊS rotas de escrita, cada uma no seu handler', async () => {
      // Também é o que prova que a troca de handlers é por MÉTODO+caminho: com
      // chave só de caminho, POST cairia em `listTemplates` e DELETE em
      // `updateTemplate`, e este caso ficaria vermelho.
      expect(await chamar('POST', '/api/admin/messaging/templates', U.curadoria)).toMatchObject({
        status: 200,
        body: { chegou: 'createTemplate' },
      });
      expect(await chamar('DELETE', '/api/admin/messaging/templates/x', U.curadoria)).toMatchObject({
        status: 200,
        body: { chegou: 'deleteTemplate' },
      });
      expect(await chamar('PUT', '/api/admin/messaging/templates/x', U.curadoria)).toMatchObject({
        status: 200,
        body: { chegou: 'updateTemplate' },
      });
    });

    it('o disparo alcança as TRÊS rotas de envio, cada uma no seu handler', async () => {
      expect(await chamar('POST', '/api/admin/messaging/whatsapp/vacancy-match', U.disparo)).toMatchObject({
        status: 200,
        body: { chegou: 'sendVacancyMatch' },
      });
      expect(await chamar('POST', '/api/admin/messaging/bulk-dispatch-incomplete', U.disparo)).toMatchObject({
        status: 200,
        body: { chegou: 'bulkDispatchIncomplete' },
      });
    });

    it('LISTAR template é messaging:read — os dois têm, e é o que compartilham', async () => {
      for (const uid of [U.disparo, U.curadoria]) {
        expect(await chamar('GET', '/api/admin/messaging/templates', uid)).toMatchObject({
          status: 200,
          body: { chegou: 'listTemplates' },
        });
      }
    });
  });

  describe('as duas células NOVAS fora do seed 206', () => {
    it('quem cura template não roda o backfill do Ana Care', async () => {
      expect((await chamar('POST', '/api/admin/integrations/anacare/backfill', U.curadoria)).status).toBe(403);
    });

    it('quem tem integration:execute roda', async () => {
      expect(await chamar('POST', '/api/admin/integrations/anacare/backfill', U.manutencao)).toMatchObject({
        status: 200,
      });
    });

    it('a limpeza de fixtures exige test_fixtures:execute — apaga dado', async () => {
      expect((await chamar('POST', '/api/admin/test-fixtures/cleanup', U.disparo)).status).toBe(403);
      expect(await chamar('POST', '/api/admin/test-fixtures/cleanup', U.manutencao)).toMatchObject({
        status: 200,
        body: { chegou: 'cleanup' },
      });
    });
  });

  describe('trilha — D-P4 pela ação', () => {
    it('o ALLOW de integration:execute é registrado; o de messaging:read não', async () => {
      await limparTrilhaDrenada(pool, [U.manutencao, U.disparo]);

      await chamar('POST', '/api/admin/integrations/anacare/backfill', U.manutencao);
      await chamar('GET', '/api/admin/messaging/templates', U.disparo);
      // A leitura abaixo já não depende de timing fixo — `aguardarTrilhaQuieta`
      // poll até a contagem ficar estável, em vez de dormir e torcer.
      const trilha = {
        rows: await aguardarTrilhaQuieta(pool, [U.manutencao, U.disparo], 1, 'user_id, resource, action, decision'),
      };

      // ⚠️ A asserção é sobre a ALEGAÇÃO, não sobre o tamanho da tabela.
      //
      // A versão anterior exigia `toEqual([...uma linha...])` — e isso afirmava,
      // sem querer, que NENHUMA outra linha poderia existir para estes dois uids.
      // É falso por duas razões, e as duas apareceram no CI (13 linhas recebidas
      // onde se esperava 1):
      //   · `execute` está em SENSITIVE_ACTIONS, então o `test_fixtures:execute`
      //     dos casos acima É gravado — comportamento CERTO, não ruído;
      //   · `record()` é fire-and-forget por desenho ("a escrita não devolve
      //     promessa"), então INSERT em voo de um caso anterior chega DEPOIS do
      //     DELETE daqui. Contar linha é uma corrida que não dá para vencer.
      // O que este caso existe para provar é o D-P4 pela AÇÃO: ação sensível
      // permitida vira linha; leitura comum não vira. É isso que se afirma.
      expect(trilha.rows).toContainEqual(
        expect.objectContaining({
          user_id: U.manutencao,
          resource: 'integration',
          action: 'execute',
          decision: 'ALLOW',
        }),
      );
      expect(
        trilha.rows.filter((r) => r.resource === 'messaging' && r.action === 'read' && r.decision === 'ALLOW'),
      ).toEqual([]);
    });
  });

  describe('rollout por família — o que torna este PR seguro de mergear', () => {
    it('com as famílias FORA de PERMISSION_ENFORCED_ROUTES, quem não tem célula passa', async () => {
      const outra = await subirApp('admin.users');
      try {
        expect(await chamar('PUT', '/api/admin/messaging/templates/x', U.disparo, outra)).toMatchObject({
          status: 200,
          body: { chegou: 'updateTemplate' },
        });
      } finally {
        await outra.fechar();
      }
    });
  });

  it('sem credencial → 401 antes de qualquer decisão de permissão', async () => {
    expect((await chamar('GET', '/api/admin/messaging/templates', null)).status).toBe(401);
  });
});
