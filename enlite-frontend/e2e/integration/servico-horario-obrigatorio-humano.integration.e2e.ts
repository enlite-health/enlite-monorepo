/**
 * servico-horario-obrigatorio-humano.integration.e2e.ts @integration — decisão do Gabriel, 07/09/2026
 *
 * A regra: o horário do serviço contratado CONTINUA opcional para salvar, mas o paciente não muda
 * de status para activo/búsqueda/reemplazo sem ele. Este spec prova que o OPERADOR é avisado — em
 * TELA, com mouse e teclado reais (nada de `fill`/`evaluate`: a régua humana da D287).
 *
 * O que ele mede, na ordem em que o operador encontra:
 *   1. no formulário, salvar sem horário CONTINUA funcionando, mas a tela avisa em âmbar o que
 *      vai acontecer depois (avisar na carga é mais barato que descobrir na ativação);
 *   2. na tabela do card, "Sin horario" aparece em âmbar, não em cinza neutro;
 *   3. o checklist da ficha lista "Horario del servicio", e clicar na pílula ABRE o serviço certo;
 *   4. o botão "Activar paciente" recusa e NOMEIA o que falta;
 *   5. depois de preencher o horário, o mesmo botão ativa.
 *
 * API e Postgres reais (stack docker), login real pelo emulador do Firebase.
 */
import { test, expect } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import { loginComoHumano } from '../helpers/login-humano';

const STAFF_EMAIL = `e2e.horario.${Date.now()}@enlite.health`;

/** Login como um humano: clica no campo, digita, clica no botão. Sem `fill`. */

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Horário obrigatório para mudar de status — o operador é avisado EM TELA @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let seed: { patientId: string; addressId: string; stamp: string };

  // faixa própria de `case_number` (700000–789999): não colide com o C (900000) nem com o humano (800000)
  test.beforeAll(() => { seed = seedActivatablePatient(700000); });
  test.afterAll(() => { cleanupPatientDeep(seed.patientId); });

  test('salvar sem horário avisa em âmbar, a ativação é recusada nomeando o que falta, e preencher o horário destrava', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Humano');
    await page.goto(`/admin/patients/${seed.patientId}`);

    // ── 1. O formulário: o aviso aparece ANTES de salvar, com o horário vazio ──
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    await page.getByTestId('new-service-btn').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toBeVisible();

    const avisoForm = page.getByTestId('svc-schedule-none-1');
    await expect(avisoForm).toBeVisible();
    await expect(avisoForm).toHaveAttribute('role', 'alert');
    await expect(avisoForm).toContainText('todavía no tiene horario');
    await expect(avisoForm).toContainText('activo, búsqueda ni reemplazo');
    // Validação visual (regra do CLAUDE.md da raiz): o aviso é uma peça NOVA de tela, e o texto
    // sozinho não guarda a moldura âmbar nem o ícone.
    await expect(avisoForm).toHaveScreenshot('aviso-horario-formulario.png');

    // o campo segue OPCIONAL: o rótulo diz "(opcional)", não tem asterisco
    const rotulo = page.locator('label[for="svc-schedule-1"]');
    await expect(rotulo).toContainText('(opcional)');
    await expect(rotulo.locator('.text-red-500')).toHaveCount(0);

    // ── 2. Salvar SEM horário continua funcionando (a decisão de 05/09 não foi revogada) ──
    await page.getByTestId('svc-code-1').selectOption('AT');
    await page.getByTestId('svc-addressId-1').selectOption(seed.addressId);
    const createService = page.waitForResponse((r) => r.request().method() === 'POST' && /\/contracted-services$/.test(r.url()));
    await page.getByTestId('contracted-service-new-save').click();
    const svcBody = (await (await createService).json()) as { data: { id: string } };
    const serviceId = svcBody.data.id;
    // 06/09: salvar NÃO fecha — o drawer troca para a EDIÇÃO do recém-criado. O aviso âmbar
    // continua ali, porque o serviço segue sem horário.
    await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('svc-schedule-none-1')).toBeVisible();
    await page.getByLabel('Cerrar').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).not.toBeVisible();

    // ── 3. A tabela: "Sin horario" em ÂMBAR, não um traço cinza ──
    const celulaSemHorario = page.locator('[data-testid^="contracted-service-schedule-missing-"]').first();
    await expect(celulaSemHorario).toBeVisible();
    await expect(celulaSemHorario).toHaveText('Sin horario');
    await expect(celulaSemHorario).toHaveClass(/text-amber-700/);
    // A CLASSE não prova a cor: o `Text` emite `text-gray-800` por default e vence pela ordem de
    // emissão do Tailwind. A 1ª versão desta célula passou no teste unitário e apareceu CINZA na
    // tela (medido: rgb(115,115,115)). Aqui a régua é a cor computada, não o atributo.
    const corHorario = await celulaSemHorario.evaluate((el) => getComputedStyle(el).color);
    expect(corHorario).toBe('rgb(180, 83, 9)'); // amber-700
    // A linha inteira, para a regressão pegar também o que a cor sozinha não conta.
    await expect(page.locator('[data-testid^="contracted-service-row-"]').first())
      .toHaveScreenshot('tabela-sin-horario-ambar.png');

    // ── 4. O checklist da ficha nomeia a pendência e LEVA até ela ──
    // a pílula bloqueante tem testid fixo (`completeness-item`); o código vem no TEXTO
    const pilula = page.getByTestId('completeness-item').filter({ hasText: 'Horario del servicio' });
    await expect(pilula).toBeVisible();
    await expect(page.getByTestId('completeness-checklist'))
      .toHaveScreenshot('checklist-com-horario.png');
    await pilula.click();
    // clicar na pílula abre o drawer JÁ no serviço que está sem horário — a prova de que é ELE
    // (e não um "+ Nuevo") é o serviço vir hidratado: o select de código fica travado na edição.
    const drawer = page.getByTestId('patient-contracted-services-edit-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('svc-code-1')).toBeDisabled();
    await expect(page.getByTestId('svc-schedule-none-1')).toBeVisible();

    // ── 5. Preencher o horário como humano: clicar no dia, e o aviso some ──
    await page.getByTestId('day-schedule-add-monday').click();
    // o aviso âmbar some assim que existe um slot — o operador vê a pendência sair na hora
    await expect(page.getByTestId('svc-schedule-none-1')).toHaveCount(0);
    // Esperar a resposta REAL do PATCH antes de fechar: clicar em "Cerrar" com o formulário ainda
    // sujo abre o "¿Descartar los cambios?" — o app está certo, o teste é que ia rápido demais.
    const salvou = page.waitForResponse(
      (r) => /\/contracted-services\//.test(r.url()) && r.request().method() === 'PATCH' && r.ok(),
      { timeout: 20_000 },
    );
    await page.locator('[data-testid^="contracted-service-save-"]').first().click();
    await salvou;
    await page.getByLabel('Cerrar').click();
    await expect(drawer).not.toBeVisible({ timeout: 15_000 });

    // ── 6. A pendência sai do checklist e a célula deixa de ser âmbar ──
    await expect(page.getByTestId('completeness-item').filter({ hasText: 'Horario del servicio' })).toHaveCount(0);
    await expect(page.locator('[data-testid^="contracted-service-schedule-missing-"]')).toHaveCount(0);

    // ── 7. Com horário, "Activar reclutamiento" (ícone do serviço, spec 018 PR-6 ADR-5) ativa ──
    // Recarrega como o operador faria: o pedido de foco do checklist sobrevive ao refetch do card
    // (o `useRef` do `useAutoOpenDrawer` zera na remontagem) e reabre o drawer no fallback
    // "+ Nuevo". É o comportamento que o SERVICE_ADDRESS já tinha desde 06/09 — anotado como
    // achado à parte, não consertado aqui.
    await page.reload();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toHaveCount(0);
    // O reload volta pra aba PADRÃO (Datos Clínicos) — o ícone é POR SERVIÇO, mora dentro de
    // "Servicio Contratado", e não sobrevive à remontagem como o botão do cabeçalho antigo sobrevivia.
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    await expect(page.getByTestId('servicos-contratados-card')).toBeVisible();
    const activated = page.waitForResponse((r) => r.request().method() === 'POST' && /\/activate-recruitment$/.test(r.url()));
    await page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`).click();
    expect((await activated).status()).toBe(201);
    // ativado: o ícone vira "Ver vacante" (o serviço agora tem vaga viva)
    await expect(page.getByTestId(`contracted-service-view-vacancy-${serviceId}`)).toBeVisible({ timeout: 20_000 });
  });

  test('sem horário, "Activar reclutamiento" fica DESABILITADO e o tooltip NOMEIA o que falta (spec 018, PR-6, ADR-5)', async ({ page }) => {
    // paciente próprio: o do teste anterior já foi ativado
    const s2 = seedActivatablePatient(710000);
    try {
      // serviço com endereço e SEM horário, direto no banco (o caminho que o operador teria feito)
      // `runSQL` (psql -tAc) devolve a linha do id SEGUIDA da tag de status ("INSERT 0 1") — -t não
      // suprime essa segunda linha para INSERT/RETURNING (só para SELECT). Primeira linha é o id.
      const svcId = runSQL(
        `INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
         VALUES ('${s2.patientId}', 'AT', true, 'AR', 'e2e-horario', 'e2e-horario', '${s2.addressId}', NULL) RETURNING id`,
      ).split('\n')[0].trim();

      await loginComoHumano(page, STAFF_EMAIL, 'E2E Humano');
      await page.goto(`/admin/patients/${s2.patientId}`);
      // O ícone é POR SERVIÇO, mora dentro de "Servicio Contratado" — diferente do botão antigo
      // no cabeçalho, que era visível em qualquer aba.
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
      await expect(page.getByTestId('servicos-contratados-card')).toBeVisible();

      // Diferença de UX do PR-6: a régua real continua sendo o backend (422 PATIENT_NOT_READY),
      // mas o ícone antecipa na tela — DESABILITADO, sem sequer disparar o request — e o `title`
      // (tooltip nativo) nomeia o item com a MESMA palavra do checklist. Não há mais um clique
      // seguido de erro: o clique nem sai do componente quando falta código do gate.
      const icone = page.getByTestId(`contracted-service-activate-recruitment-${svcId}`);
      await expect(icone).toBeVisible({ timeout: 15_000 });
      await expect(icone).toBeDisabled();
      await expect(icone).toHaveAttribute('title', /Horario del servicio/);

      // e o paciente NÃO foi ativado — nenhum request chegou a sair
      const status = runSQL(`SELECT status FROM patients WHERE id = '${s2.patientId}'`).trim();
      expect(status).toBe('PENDING_ADMISSION');
      const vagas = runSQL(`SELECT count(*) FROM job_postings WHERE patient_id = '${s2.patientId}'`).trim();
      expect(vagas).toBe('0');
    } finally {
      cleanupPatientDeep(s2.patientId);
    }
  });

  // ── Os dois caminhos que o Gabriel pediu para ver EM TELA, e que só tinham unit + e2e de API ──

  // Spec 018, PR-6, ADR-5 (migration 428 + `usePatientKanban.ts`): soltar em "Activo" não é
  // mais um alvo de drop, SEJA QUAL FOR o motivo (antes desta rodada de mudanças, faltar
  // horário fazia o backend recusar com 422 e o toast nomeava o horário; a 428 tirou
  // funil→ACTIVE do catálogo por completo, então o Kanban intercepta ANTES de qualquer request
  // — `usePatientKanban.ts` devolve `KANBAN_ACTIVATION_MOVED_TO_SERVICE` sem chamar
  // `PUT /status`). Esta prova também cobre a task 6.9 (Kanban não manda ACTIVE direto): o
  // teste de rede abaixo mostra que NENHUM `PUT /status` sai do navegador.
  test('arrastar o card para "Activo" no Kanban NÃO ativa mais — o toast aponta o caminho novo, sem chamar a API', async ({ page }) => {
    const s3 = seedActivatablePatient(720000);
    try {
      // serviço com endereço e SEM horário — irrelevante agora: o drop nem chega a testar isso.
      runSQL(
        `INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
         VALUES ('${s3.patientId}', 'AT', true, 'AR', 'e2e-horario', 'e2e-horario', '${s3.addressId}', NULL)`,
      );
      await loginComoHumano(page, STAFF_EMAIL, 'E2E Humano');
      await page.goto('/admin/patients/kanban');

      const card = page.locator(`[data-testid="kanban-draggable-${s3.patientId}"]`);
      await expect(card).toBeVisible({ timeout: 30_000 });
      const destino = page.locator('[data-testid="kanban-column-ACTIVE"]'); // coluna "Activo"
      await expect(destino).toBeVisible();

      const cardBB = await card.boundingBox();
      const destinoBB = await destino.boundingBox();
      if (!cardBB || !destinoBB) throw new Error('bounding boxes nulas para o drag');

      // Nenhum PUT /status pode sair do navegador — a prova de que o Kanban intercepta ANTES
      // de qualquer chamada de rede, não que a API recusou.
      let putStatusChamado = false;
      page.on('request', (req) => {
        if (req.method() === 'PUT' && /\/status$/.test(req.url())) putStatusChamado = true;
      });

      // Arraste de MOUSE de verdade (dnd-kit: o PointerSensor tem constraint de 8px)
      const x = cardBB.x + cardBB.width / 2;
      const y = cardBB.y + cardBB.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.waitForTimeout(80);
      await page.mouse.move(x + 15, y + 5, { steps: 8 });
      await page.mouse.move(destinoBB.x + 50, destinoBB.y + destinoBB.height / 2, { steps: 30 });
      await page.mouse.up();

      // O toast aponta o caminho novo — "Activar reclutamiento" no serviço contratado da ficha.
      const toast = page.getByRole('status').filter({ hasText: 'Activar reclutamiento' });
      await expect(toast).toBeVisible({ timeout: 20_000 });
      await expect(toast).toContainText('servicio contratado');
      await expect(toast).toHaveScreenshot('toast-kanban-recusado.png');

      expect(putStatusChamado).toBe(false);

      // E o banco NÃO mudou — o card nunca saiu do funil
      const status = runSQL(`SELECT status FROM patients WHERE id = '${s3.patientId}'`).trim();
      expect(status).toBe('PENDING_ADMISSION');
    } finally {
      cleanupPatientDeep(s3.patientId);
    }
  });

  test('no select de estado da ficha, ir para "Reemplazo" é RECUSADO nomeando o que falta', async ({ page }) => {
    const s4 = seedActivatablePatient(725000);
    try {
      // paciente JÁ ativo (o select clínico só aparece com status ACTIVE), com serviço sem horário
      runSQL(`UPDATE patients SET status = 'ACTIVE' WHERE id = '${s4.patientId}'`);
      runSQL(
        `INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
         VALUES ('${s4.patientId}', 'AT', true, 'AR', 'e2e-horario', 'e2e-horario', '${s4.addressId}', NULL)`,
      );
      await loginComoHumano(page, STAFF_EMAIL, 'E2E Humano');
      await page.goto(`/admin/patients/${s4.patientId}`);

      const select = page.getByTestId('patient-status-select');
      await expect(select).toBeVisible({ timeout: 30_000 });
      // REPLACEMENT (reemplazo), não SEARCHING: a FSM não tem `ACTIVE → SEARCHING` (seed da 315),
      // e ela é consultada ANTES da completude — a 1ª versão deste teste pedia uma transição
      // inexistente e recebia "Transición no permitida", que é outra recusa.
      await select.selectOption('REPLACEMENT');
      await page.getByTestId('patient-status-save').click();

      const erro = page.getByTestId('patient-status-error');
      await expect(erro).toBeVisible({ timeout: 20_000 });
      await expect(erro).toContainText('Horario del servicio');
      await expect(erro).toHaveScreenshot('erro-select-ficha.png');

      // o banco não mudou
      const status = runSQL(`SELECT status FROM patients WHERE id = '${s4.patientId}'`).trim();
      expect(status).toBe('ACTIVE');
    } finally {
      cleanupPatientDeep(s4.patientId);
    }
  });
});
