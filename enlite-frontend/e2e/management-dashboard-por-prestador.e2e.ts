/**
 * management-dashboard-por-prestador.e2e.ts
 *
 * Prova VISUAL das mudanças de 30/07/2026 no "Gestión a la Vista":
 *   1. funil contado por PRESTADOR (duas vistas, somabilidade declarada)
 *   2. coluna "En progreso", que não existia no painel
 *   3. pacientes activos sem apagados (190, não 192)
 *   4. entrevistas da semana + "N sem data" (o card que mostrava 0 mudo)
 *   5. os números ATUALIZANDO SOZINHOS na tela — a queixa original do Diego
 *      ("as meninas movem os cards e o painel não atualiza")
 *
 * O payload é a saída LITERAL de GetManagementDashboardUseCase rodando contra o banco de
 * PRODUÇÃO em 30/07/2026 (worker-functions/scripts/funnel-por-prestador-proof.ts). Número
 * inventado provaria só que a tela renderiza; número real prova que ela aguenta o que vai
 * receber.
 *
 * ⚠️ ÚNICA EXCEÇÃO ao "literal de 30/07": o bloco `encuadres` foi reconciliado em 17/08/2026,
 * quando a capacidade semanal passou a 30. O valor capturado em 30/07 era `agendados: 7` com
 * `agendadosEstaSemana: 0` — combinação que o backend NÃO consegue emitir (os dois campos
 * recebem a mesma variável), ou seja, nunca foi literal de fato. Reconciliado com a invariante
 * real e com a config vigente. Todo o resto do payload segue intocado, literal de 30/07.
 *
 * Auth: Firebase Identity Toolkit interceptado localmente (mesma técnica de
 * management-dashboard-visual.e2e.ts) — sem emulador, sem conta real.
 *
 * Run: pnpm exec playwright test --project=chromium-admin management-dashboard-por-prestador
 */

import { test, expect, Page, Route } from '@playwright/test';

const MOCK_ADMIN = {
  uid: 'mgmt-prestador-uid',
  email: 'mgmt.prestador@e2e.test',
  role: 'admin',
};

const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN.uid,
      email: MOCK_ADMIN.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

/** Saída literal do caso de uso contra o banco de produção (30/07/2026), com o bloco
 *  `encuadres` reconciliado em 17/08 — ver a ressalva no cabeçalho do arquivo. */
const PROD_PAYLOAD = {
  bigNumbers: {
    equiposArmados: 0,
    equiposPorArmar: 134,
    pacientesActivos: 190,
    vacantesAbiertas: 144,
    vacantesPausadas: 21,
  },
  equipoArmada: { armados: 0, porArmar: 134, semConfig: 5, pendenteClasificacao: 135, pctRespostaRapidaArmado: { num: 0, den: 84, excluidos: 60, pct: 0 } },
  pacientes: {
    activos: 190, ubicacionesActivas: 339,
    solicitudes: 0, entrevistaAgendada: 1, enAdmision: 5, enBusca: 112,
    sobrepoe: true,
  },
  horas: { ativas: 987.5, ativasConSchedule: 38, ativasSinSchedule: 12, totais: 0, aPreencher: 0, coberturaConSchedule: 0, coberturaSinSchedule: 274 },
  prioridades: { completosEsperandoAgendamiento: 2431, registrosIncompletos: 6735, bloqueadosAlPostularse: 355 },
  funnelPorPrestador: {
    total: 2576,
    recorte: 'vagas-vivas',
    periodoDias: null,
    bloqueados: 355,
    porEtapa: {
      somavel: false,
      colunas: {
        INVITED: 466, INICIADO: 182, PRE_SCREENING: 49, IN_PROGRESS: 1347,
        COMPLETED: 604, CONFIRMED: 27, SELECTED: 10, REJECTED: 626,
      },
    },
    consolidado: {
      somavel: true,
      colunas: {
        INVITED: 303, INICIADO: 84, PRE_SCREENING: 23, IN_PROGRESS: 1173,
        COMPLETED: 585, CONFIRMED: 27, SELECTED: 10, REJECTED: 371,
      },
    },
  },
  funnel: {
    invitados: 2615, bloqueados: 668, preScreening: 93, completos: 4,
    agendados: 37, seleccionados: 10, rechazados: 2557,
  },
  // INVARIANTE do backend: no bloco `encuadres` do payload, `pctCapacidadeSemana.agendados` e
  // `agendadosEstaSemana` recebem a MESMA variável `encuadre` (GetManagementDashboardUseCase,
  // montagem de `encuadres`) — produção nunca emite os dois diferentes. Semana zerada: 0/30 = 0%.
  // (Citação por símbolo, não por linha: este próprio PR já deslocou os números uma vez.)
  encuadres: { agendadosEstaSemana: 0, semDataRegistrada: 36, pctCapacidadeSemana: { agendados: 0, capacidade: 30, pct: 0 } },
  cadastros: {
    leads: 7029, completos: 293, alocados: 61, alocadosActivos: 49,
    alocadosCubriendoGuardias: 12, incompletos: 6735, nuevosCompletosMes: 41,
  },
};

/**
 * Mesmo funil DEPOIS de a recrutadora trabalhar: um prestador saiu de "En progreso"
 * para "Agendados", e uma entrevista foi marcada para esta semana.
 */
const PROD_PAYLOAD_DEPOIS = {
  ...PROD_PAYLOAD,
  funnelPorPrestador: {
    ...PROD_PAYLOAD.funnelPorPrestador,
    porEtapa: {
      somavel: false,
      colunas: { ...PROD_PAYLOAD.funnelPorPrestador.porEtapa.colunas, IN_PROGRESS: 1346, CONFIRMED: 28 },
    },
    consolidado: {
      somavel: true,
      colunas: { ...PROD_PAYLOAD.funnelPorPrestador.consolidado.colunas, IN_PROGRESS: 1172, CONFIRMED: 28 },
    },
  },
  // A entrevista marcada nesta semana move os DOIS campos juntos (ver invariante acima): 1/30 = 3,3%.
  encuadres: { agendadosEstaSemana: 1, semDataRegistrada: 36, pctCapacidadeSemana: { agendados: 1, capacidade: 30, pct: 3.3 } },
};

const MOCK_ZONE_ANALYTICS = { zones: [], unresolvedCount: 0 };

async function installFakeFirebaseAuth(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          localId: MOCK_ADMIN.uid,
          email: MOCK_ADMIN.email,
          idToken: FAKE_ID_TOKEN,
          refreshToken: 'fake-refresh-token',
          expiresIn: '3600',
          registered: true,
        }),
      });
      return;
    }
    if (url.includes('token') || url.includes('securetoken')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id_token: FAKE_ID_TOKEN,
          access_token: FAKE_ID_TOKEN,
          expires_in: '3600',
          token_type: 'Bearer',
          refresh_token: 'fake-refresh-token',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [{ localId: MOCK_ADMIN.uid, email: MOCK_ADMIN.email, emailVerified: true }],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
      }),
    });
  });

  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: MOCK_ADMIN.uid,
          email: MOCK_ADMIN.email,
          role: MOCK_ADMIN.role,
          firstName: 'Visual',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installFakeFirebaseAuth(page);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

test.describe('Gestión a la Vista — funil por prestador (prova visual)', () => {
  test.setTimeout(90000);

  test.beforeEach(async ({ page }) => {
    await page.route('**/analytics/dashboard/zone-analytics**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_ZONE_ANALYTICS }),
      }),
    );
  });

  test('a tela mostra o funil por PESSOA, com dado real de produção', async ({ page }) => {
    await page.route('**/analytics/dashboard/management', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: PROD_PAYLOAD }),
      }),
    );

    await loginAsAdmin(page);
    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-content')).toBeVisible({ timeout: 20000 });

    // Total de PESSOAS — número que não existia na tela.
    await expect(page.getByTestId('mgmt-funnel')).toContainText('2576');

    // "En progreso": a maior coluna do Kanban, ausente do painel até agora.
    await expect(page.getByTestId('mgmt-funnel-consolidado-IN_PROGRESS')).toContainText('1173');
    await expect(page.getByTestId('mgmt-funnel-por-etapa-IN_PROGRESS')).toContainText('1347');

    // Pacientes activos sem os apagados (era 192).
    await expect(page.getByTestId('mgmt-big-numbers')).toContainText('190');

    // A lacuna da agenda aparece como lacuna, não como zero mudo.
    await expect(page.getByTestId('mgmt-encuadres-sem-data')).toContainText('36');

    // A página rola num contêiner interno: `fullPage` para no topo. Print da SEÇÃO.
    await page.getByTestId('mgmt-funnel').scrollIntoViewIfNeeded();
    await page.getByTestId('mgmt-funnel').screenshot({
      path: 'e2e/__screenshots__/gestao-a-vista-funil-por-prestador.png',
    });
    await page.getByTestId('mgmt-big-numbers').screenshot({
      path: 'e2e/__screenshots__/gestao-a-vista-numeros-clave.png',
    });
  });

  /**
   * O grid do funil tem 8 colunas. Print a 1280px mostrou a última ("Rechazados") colada
   * na borda — checar se transborda de verdade em larguras reais de uso. Overflow
   * horizontal aqui significa recrutadora sem ver a última coluna.
   */
  test('as 8 colunas cabem na tela, sem transbordo horizontal', async ({ page }) => {
    await page.route('**/analytics/dashboard/management', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: PROD_PAYLOAD }),
      }),
    );

    await loginAsAdmin(page);

    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin/dashboard');
      await expect(page.getByTestId('mgmt-content')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('mgmt-funnel').scrollIntoViewIfNeeded();

      const metrics = await page.evaluate(() => {
        const doc = document.documentElement;
        const ultima = document.querySelector('[data-testid="mgmt-funnel-consolidado-REJECTED"]');
        const r = ultima?.getBoundingClientRect();
        return {
          pageOverflow: doc.scrollWidth - doc.clientWidth,
          ultimaColunaDireita: r ? Math.round(r.right) : -1,
          janela: window.innerWidth,
        };
      });

      console.log(`[${width}px]`, JSON.stringify(metrics));
      expect(metrics.pageOverflow, `overflow horizontal a ${width}px`).toBeLessThanOrEqual(0);
      expect(metrics.ultimaColunaDireita, `última coluna cortada a ${width}px`).toBeLessThanOrEqual(metrics.janela);

      await page.getByTestId('mgmt-funnel').screenshot({
        path: `e2e/__screenshots__/gestao-a-vista-funil-${width}.png`,
      });
    }
  });

  /**
   * A queixa que abriu tudo isto: "estão movendo os cards no Kanban mas não está
   * atualizando o painel". Aqui o payload muda e a tela tem que acompanhar SEM reload.
   */
  test('os números mudam na tela sozinhos, sem recarregar a página', async ({ page }) => {
    let servirDepois = false;
    await page.route('**/analytics/dashboard/management', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: servirDepois ? PROD_PAYLOAD_DEPOIS : PROD_PAYLOAD,
        }),
      }),
    );

    await loginAsAdmin(page);
    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-content')).toBeVisible({ timeout: 20000 });

    // ANTES
    await expect(page.getByTestId('mgmt-funnel-consolidado-IN_PROGRESS')).toContainText('1173');
    await expect(page.getByTestId('mgmt-funnel-consolidado-CONFIRMED')).toContainText('27');
    await page.getByTestId('mgmt-funnel').scrollIntoViewIfNeeded();
    await page.getByTestId('mgmt-funnel').screenshot({
      path: 'e2e/__screenshots__/gestao-a-vista-antes-do-movimento.png',
    });

    // A recrutadora move um card no Kanban (noutra aba) e volta para o painel.
    servirDepois = true;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // DEPOIS — sem reload, sem clique: o número mudou na tela.
    await expect(page.getByTestId('mgmt-funnel-consolidado-CONFIRMED')).toContainText('28', {
      timeout: 15000,
    });
    await expect(page.getByTestId('mgmt-funnel-consolidado-IN_PROGRESS')).toContainText('1172');
    await expect(page.getByTestId('mgmt-funnel')).toContainText('2576'); // total intacto

    await page.getByTestId('mgmt-funnel').screenshot({
      path: 'e2e/__screenshots__/gestao-a-vista-depois-do-movimento.png',
    });
  });

  /**
   * Acordos da call 22/07 (PR #174): as duas linhas de pacientes + percentuais
   * APARECEM, e o filtro de período dispara request novo e MUDA o número em tela.
   */
  test('duas linhas de pacientes visíveis e filtro de período muda os números em tela', async ({ page }) => {
    const PAYLOAD_7D = {
      ...PROD_PAYLOAD,
      funnelPorPrestador: {
        ...PROD_PAYLOAD.funnelPorPrestador,
        total: 214,
        periodoDias: 7,
        consolidado: {
          somavel: true,
          colunas: {
            INVITED: 80, INICIADO: 20, PRE_SCREENING: 10, IN_PROGRESS: 74,
            COMPLETED: 18, CONFIRMED: 7, SELECTED: 2, REJECTED: 3,
          },
        },
        porEtapa: {
          somavel: false,
          colunas: {
            INVITED: 90, INICIADO: 22, PRE_SCREENING: 11, IN_PROGRESS: 80,
            COMPLETED: 20, CONFIRMED: 7, SELECTED: 2, REJECTED: 5,
          },
        },
      },
    };
    const requests: string[] = [];
    await page.route('**/analytics/dashboard/management*', (route) => {
      const url = route.request().url();
      requests.push(url);
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: url.includes('funnelPeriodDays=7') ? PAYLOAD_7D : PROD_PAYLOAD,
        }),
      });
    });

    await loginAsAdmin(page);
    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-content')).toBeVisible({ timeout: 20000 });

    // As duas linhas + percentuais estão NA TELA (não só no DOM: visíveis).
    await expect(page.getByTestId('mgmt-percentuais')).toBeVisible();
    await expect(page.getByTestId('mgmt-rodando')).toBeVisible();
    await expect(page.getByTestId('mgmt-chegando')).toBeVisible();
    await expect(page.getByTestId('mgmt-rodando')).toContainText('339'); // ubicaciones
    await expect(page.getByTestId('mgmt-chegando')).toContainText('112'); // em busca
    await page.getByTestId('mgmt-big-numbers').screenshot({
      path: 'e2e/__screenshots__/gestao-a-vista-duas-linhas.png',
    });

    // Clicar em "7 dias" dispara request com o parâmetro e MUDA o número em tela.
    await page.getByTestId('mgmt-funnel').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('mgmt-funnel')).toContainText('2576');
    await page.getByTestId('mgmt-funnel-period-7').click();
    await expect(page.getByTestId('mgmt-funnel')).toContainText('214', { timeout: 15000 });
    expect(requests.some((u) => u.includes('funnelPeriodDays=7'))).toBe(true);
    await page.getByTestId('mgmt-funnel').screenshot({
      path: 'e2e/__screenshots__/gestao-a-vista-periodo-7d.png',
    });

    // Voltar para "Todo" restaura o total cheio.
    await page.getByTestId('mgmt-funnel-period-todo').click();
    await expect(page.getByTestId('mgmt-funnel')).toContainText('2576', { timeout: 15000 });
  });
});
