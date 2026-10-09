/**
 * admissao-049-aba.integration.e2e.ts @integration — spec 049 (aba "Admisión" da ficha do paciente), F9.
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por
 * SQL), clique/teclado de humano (`loginAs`, `keyboard.type`, valor lido da tela). As fronteiras externas são DUBLÊS dentro da
 * API (`ADMISSION_EXTERNALS=fake` no `docker-compose.group-simulation.yml`: Calendar, Meet, Twilio, Cloud Tasks, Tactiq, Vertex
 * e cofre) — NENHUM canal real: nada de Google, WhatsApp, Tactiq ou Vertex; só Postgres.
 *
 *  feliz  — operadora abre a aba, "Nueva agenda", escolhe um responsável VINCULADO, digita data e hora, agenda -> a reunião
 *           aparece na lista com os selos (status, confirmação, lembrete, importação, documento) -> cancela pelo diálogo ->
 *           a linha vira "Cancelada" e o banco concorda.
 *  alt 1  — responsável SEM vínculo Tactiq aparece DESABILITADO com o motivo e o clique não o seleciona (nenhum POST sai);
 *           forçando pela API o servidor recusa com 409 TACTIQ_LINK_REQUIRED; e responsável OCUPADO: o erro aparece na tela e
 *           NADA é criado (0 linhas em `admission_appointments`, conferido no banco).
 *  alt 2  — staff SÓ com `patient_admission:read`: a lista abre, o botão "Nueva agenda" NÃO existe no DOM e o POST direto leva
 *           403 `missing_cell`, com o banco inalterado.
 *
 * ⚠️ Precisa do engine ABAC LIGADO (alt 2 mede AUSÊNCIA por falta de célula; com o engine OFF `cells===null` mostra tudo) e da
 * API com `ADMISSION_EXTERNALS=fake` — por isso o nome entra no `--grep` do job `integration-e2e-group-simulation` do
 * `_frontend-integration.yml` (e NÃO no `grep:` do `pr-gate.yml`, que roda com o engine OFF).
 *
 * Vínculo Tactiq (`/admin/mi-cuenta/tactiq`, `TactiqLinkPage`) — segundo bloco deste arquivo, mesmo `--grep admissao-049`:
 *  feliz  — sem vínculo, "Vincular Tactiq" -> o POST REAL devolve `authorizeUrl` e o navegador navega até ele (só o domínio
 *           externo do Tactiq é interceptado, para nada sair da máquina; o `state` fica no banco).
 *  alt 1  — volta do callback com `?tactiq=error&reason=...` mostra o banner de erro, a URL é limpa e o estado segue "Sin vincular".
 *  alt 2  — vínculo `linked` (semeado no banco) mostra o estado, as datas e o banner de sucesso.
 *  alt 3  — quem só tem `own_tactiq_link:read` vê a tela mas não tem o botão (e o POST direto leva 403).
 *
 * Rodar local = o job do CI: `ABAC_API_URL`, `ABAC_TEST_DB_URL`, `E2E_PG_CONTAINER`, `E2E_BACKEND_URL`.
 * Dados SINTÉTICOS (paciente "BlocoC", e-mails @example.test, telefone fictício).
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep } from '../helpers/patient-detail-c-helper';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, ABAC_API_URL, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const PHONE = '+5491100000049';

const ANA = `ana.e2e049-${RUN_ID}@example.test`;
const OCUPADA = `ocupado.mari.e2e049-${RUN_ID}@example.test`;
const SEM_VINCULO = `sem.vinculo.e2e049-${RUN_ID}@example.test`;
const HOSTS = [ANA, OCUPADA, SEM_VINCULO];

const BOOK_ROUTE = /\/api\/admin\/patients\/[0-9a-f-]+\/admission-appointments$/;

/** Dia civil de Buenos Aires + N dias: `YYYY-MM-DD` (o que o input date guarda) e `MMDDYYYY` (o que uma pessoa digita no Chrome en-US). */
function diaEmBuenosAires(n: number): { iso: string; digitado: string } {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = hoje.split('-').map(Number);
  const iso = new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  return { iso, digitado: `${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(0, 4)}` };
}

/** Um dia futuro ÚNICO por chamada (a trava é UNIQUE(host_email, slot_start) e o banco sobrevive entre rodadas). */
let proximoDia = 20 + Math.floor(Math.random() * 400);
const diaLivre = (): { iso: string; digitado: string } => diaEmBuenosAires(++proximoDia);

/** Digita data e hora como uma pessoa (clique no campo + teclado) e LÊ o valor da tela. */
async function digitarDataEHora(page: Page, dia: { iso: string; digitado: string }): Promise<void> {
  const data = page.getByTestId('admission-date-input');
  await data.click({ position: { x: 28, y: 30 } }); // na borda esquerda: cai no 1º segmento (mês), de onde uma pessoa começa a digitar
  await expect(data).toBeFocused();
  await page.keyboard.type(dia.digitado);
  await expect(data).toHaveValue(dia.iso);
  const hora = page.getByTestId('admission-time-input');
  await hora.click({ position: { x: 28, y: 30 } }); // 1º segmento (hora)
  await expect(hora).toBeFocused();
  await page.keyboard.type('1100AM');
  await expect(hora).toHaveValue('11:00');
}

async function abrirAba(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Admisión', exact: true }).click();
  await expect(page.getByTestId('admission-tab')).toBeVisible({ timeout: 15_000 });
}

const linhasDoPaciente = (patientId: string): number =>
  Number(scalar(`SELECT count(*) FROM admission_appointments WHERE patient_id = '${patientId}'`));

test.use({ viewport: { width: 1600, height: 1100 }, video: 'on' });

test.describe('admissao-049 — aba Admisión: nova agenda, vínculo Tactiq, cancelar e célula (spec 049) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let operadoraGroupId = '';
  let leitoraGroupId = '';
  const operadoraUid = `e2e-049-operadora-${RUN_ID}`;
  const leitoraUid = `e2e-049-leitora-${RUN_ID}`;
  const operadora = { uid: operadoraUid, email: `${operadoraUid}@e2e.test`, role: 'admin', country: 'AR' };
  const leitora = { uid: leitoraUid, email: `${leitoraUid}@e2e.test`, role: 'admin', country: 'AR' };
  const CELULAS_VER: Array<[string, string]> = [
    ['patient', 'read'], ['patient_identity', 'read'], ['patient_admission', 'read'],
  ];

  test.beforeAll(() => {
    seed = seedActivatablePatient(749000);
    // Telefone + consentimento: sem eles a confirmação não vira "enviada" e o selo não prova o caminho feliz.
    safeSql(`UPDATE patients SET phone_whatsapp = '${PHONE}', has_consent = true WHERE id = '${seed.patientId}'`);

    psql(`INSERT INTO interview_hosts (email, display_name, country, active) VALUES
            ('${ANA}', 'Ana E2E049', 'AR', true), ('${OCUPADA}', 'Mari E2E049', 'AR', true), ('${SEM_VINCULO}', 'Sem Vinculo E2E049', 'AR', true)`);
    // ANA e OCUPADA vinculadas; SEM_VINCULO não tem linha em `tactiq_links` (estado `missing`). Token: tabela à parte, não usada aqui.
    psql(`INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ('${ANA}', 'tq-e049-ana-${RUN_ID}', 'linked'), ('${OCUPADA}', 'tq-e049-mari-${RUN_ID}', 'linked')`);

    operadoraGroupId = seedStaffInGroup({ uid: operadoraUid, email: operadora.email, groupName: `Adm049 Operadora ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of CELULAS_VER) grantCell(operadoraGroupId, r, a);
    grantCell(operadoraGroupId, 'patient_admission', 'create');
    grantCell(operadoraGroupId, 'patient_admission', 'update');
    leitoraGroupId = seedStaffInGroup({ uid: leitoraUid, email: leitora.email, groupName: `Adm049 Leitora ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of CELULAS_VER) grantCell(leitoraGroupId, r, a);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM admission_appointments WHERE patient_id = '${seed.patientId}'`);
    safeSql(`DELETE FROM tactiq_links WHERE lower(host_email) = ANY(ARRAY[${HOSTS.map((h) => `'${h}'`).join(',')}])`);
    safeSql(`DELETE FROM interview_hosts WHERE email = ANY(ARRAY[${HOSTS.map((h) => `'${h}'`).join(',')}])`);
    safeSql(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupStaffAndGroup(operadoraUid, operadoraGroupId);
    cleanupStaffAndGroup(leitoraUid, leitoraGroupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Adm049 % ${RUN_ID}'`);
  });

  test('feliz: abre a aba -> "Nueva agenda" com responsável vinculado -> a reunião aparece na lista com os selos -> cancela pelo diálogo -> "Cancelada" e o banco concorda', async ({ page }, testInfo) => {
    await loginAs(page, operadora);
    await abrirAba(page, seed.patientId);
    await expect(page.getByTestId('admission-empty')).toBeVisible();
    expect(linhasDoPaciente(seed.patientId), 'começa sem reunião').toBe(0);

    await page.getByTestId('admission-new-button').click();
    await expect(page.getByTestId('admission-new-modal')).toBeVisible();
    // Controle positivo: o roster mostra os 3 responsáveis semeados (a ausência da trava abaixo não é lista vazia).
    for (const h of HOSTS) await expect(page.getByTestId(`admission-host-${h.toLowerCase()}`)).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId('admission-new-submit')).toBeDisabled(); // sem responsável escolhido nem data

    // O responsável VINCULADO é selecionável: clica na caixa e LÊ o estado marcado.
    await page.getByTestId(`admission-host-${ANA.toLowerCase()}`).click();
    await expect(page.getByTestId(`admission-host-radio-${ANA.toLowerCase()}`)).toBeChecked();
    const dia = diaLivre();
    await digitarDataEHora(page, dia);
    await expect(page.getByTestId('admission-tz-note')).toContainText('60 minutos');
    await expect(page.getByTestId('admission-new-submit')).toBeEnabled();

    const reservou = page.waitForResponse((r) => r.request().method() === 'POST' && BOOK_ROUTE.test(r.url()));
    await page.getByTestId('admission-new-submit').click();
    const resposta = await reservou;
    expect(resposta.status()).toBe(201);
    const apptId = ((await resposta.json()) as { data: { appointmentId: string } }).data.appointmentId;
    expect(apptId).toMatch(/^[0-9a-f-]{36}$/);

    // A reunião aparece na lista: horário de parede do país (11:00 – 12:00), responsável, status e os selos.
    await expect(page.getByTestId('admission-new-modal')).toHaveCount(0);
    const linha = page.getByTestId(`admission-row-${apptId}`);
    await expect(linha).toBeVisible({ timeout: 15_000 });
    await expect(linha).toHaveAttribute('data-status', 'booked');
    await expect(page.getByTestId(`admission-when-${apptId}`)).toContainText('11:00');
    await expect(page.getByTestId(`admission-when-${apptId}`)).toContainText('12:00');
    await expect(page.getByTestId(`admission-host-${apptId}`)).toContainText(ANA);
    await expect(page.getByTestId(`admission-status-${apptId}`)).toHaveText('Agendada');
    await expect(page.getByTestId(`admission-seals-${apptId}`)).toBeVisible();
    for (const seal of ['confirmation', 'reminder', 'import', 'document']) {
      await expect(page.getByTestId(`admission-seal-${seal}-${apptId}`)).toBeVisible();
    }
    // Selos lidos da tela (nunca "Sin envío" nos dois envios: o dublê do WhatsApp aceitou a confirmação e o lembrete foi programado).
    await expect(page.getByTestId(`admission-seal-confirmation-chip-${apptId}`)).toHaveText(/Enviado|Entregado/);
    await expect(page.getByTestId(`admission-seal-reminder-chip-${apptId}`)).toHaveText(/Programado/);
    await expect(page.getByTestId(`admission-document-none-${apptId}`)).toBeVisible();
    // O link do Meet é o do dublê (nada saiu da máquina) e só aparece em reunião FUTURA.
    await expect(page.getByTestId(`admission-meet-${apptId}`)).toHaveAttribute('href', /^https:\/\/meet\.google\.com\/fak-e049-/);
    expect(scalar(`SELECT status || '|' || host_email FROM admission_appointments WHERE id = '${apptId}'`)).toBe(`booked|${ANA}`);
    expect(linhasDoPaciente(seed.patientId)).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('1-feliz-lista-com-selos.png'), fullPage: true });

    // Cancelar: o diálogo é da página (não `window.confirm`); voltar não cancela; confirmar cancela.
    page.on('dialog', () => { throw new Error('window.confirm/alert não pode ser usado'); });
    await page.getByTestId(`admission-cancel-${apptId}`).click();
    await expect(page.getByTestId('admission-cancel-dialog')).toBeVisible();
    await page.getByTestId('admission-cancel-dialog-back').click();
    await expect(page.getByTestId('admission-cancel-dialog')).toHaveCount(0);
    expect(scalar(`SELECT status FROM admission_appointments WHERE id = '${apptId}'`)).toBe('booked');

    await page.getByTestId(`admission-cancel-${apptId}`).click();
    await page.getByTestId('admission-cancel-dialog-confirm').click();
    await expect(page.getByTestId(`admission-status-${apptId}`)).toHaveText('Cancelada', { timeout: 15_000 });
    await expect(linha).toHaveAttribute('data-status', 'cancelled');
    await expect(page.getByTestId(`admission-cancel-${apptId}`)).toHaveCount(0); // reunião cancelada não tem mais "Cancelar"
    await expect(page.getByTestId(`admission-meet-${apptId}`)).toHaveCount(0); // nem link do Meet
    expect(scalar(`SELECT status FROM admission_appointments WHERE id = '${apptId}'`)).toBe('cancelled');
    await page.screenshot({ path: testInfo.outputPath('2-feliz-cancelada.png'), fullPage: true });
  });

  test('alt 1: responsável SEM vínculo Tactiq aparece desabilitado com o motivo (e o POST direto leva 409); responsável OCUPADO dá erro na tela e nada é criado', async ({ page, request }, testInfo) => {
    const antes = linhasDoPaciente(seed.patientId);
    await loginAs(page, operadora);
    await abrirAba(page, seed.patientId);
    await page.getByTestId('admission-new-button').click();
    await expect(page.getByTestId('admission-new-modal')).toBeVisible();
    await expect(page.getByTestId(`admission-host-${ANA.toLowerCase()}`)).toHaveCount(1, { timeout: 15_000 });

    // Sem vínculo: desabilitado, com o motivo visível; o clique NÃO o seleciona e nenhum POST sai.
    let posts = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && BOOK_ROUTE.test(r.url())) posts += 1; });
    const sem = SEM_VINCULO.toLowerCase();
    await expect(page.getByTestId(`admission-host-${sem}`)).toHaveAttribute('data-disabled', 'true');
    await expect(page.getByTestId(`admission-host-radio-${sem}`)).toBeDisabled();
    await expect(page.getByTestId(`admission-host-reason-${sem}`)).toHaveText('Sin Tactiq vinculado');
    // Controle positivo: o vinculado do MESMO roster não tem motivo e está habilitado.
    await expect(page.getByTestId(`admission-host-${ANA.toLowerCase()}`)).toHaveAttribute('data-disabled', 'false');
    await expect(page.getByTestId(`admission-host-reason-${ANA.toLowerCase()}`)).toHaveCount(0);
    await page.getByTestId(`admission-host-${sem}`).click({ force: true });
    await expect(page.getByTestId(`admission-host-radio-${sem}`)).not.toBeChecked();
    await digitarDataEHora(page, diaLivre());
    await expect(page.getByTestId('admission-new-submit'), 'sem responsável selecionável o botão não habilita').toBeDisabled();
    expect(posts, 'nenhum POST saiu').toBe(0);
    await page.screenshot({ path: testInfo.outputPath('3-alt1-sem-vinculo-desabilitado.png') });

    // Forçando pela API o SERVIDOR é quem impõe a trava: 409 TACTIQ_LINK_REQUIRED, nada criado.
    const forcado = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/admission-appointments`, {
      headers: { Authorization: `Bearer ${tokenFor(operadora)}` },
      data: { hostEmail: SEM_VINCULO, slotStartISO: `${diaLivre().iso}T11:00` },
    });
    expect(forcado.status()).toBe(409);
    expect(await forcado.json()).toMatchObject({ code: 'TACTIQ_LINK_REQUIRED' });
    expect(linhasDoPaciente(seed.patientId)).toBe(antes);

    // Responsável OCUPADO (vinculado, mas a agenda dele está tomada no dublê do Calendar): o erro aparece e NADA é criado.
    await page.getByTestId(`admission-host-${OCUPADA.toLowerCase()}`).click();
    await expect(page.getByTestId(`admission-host-radio-${OCUPADA.toLowerCase()}`)).toBeChecked();
    await expect(page.getByTestId('admission-new-submit')).toBeEnabled();
    const tentou = page.waitForResponse((r) => r.request().method() === 'POST' && BOOK_ROUTE.test(r.url()));
    await page.getByTestId('admission-new-submit').click();
    expect((await tentou).status()).toBe(409);
    await expect(page.getByTestId('admission-book-error')).toHaveText('Ese horario ya está ocupado para el responsable. Elegí otro.');
    await expect(page.getByTestId('admission-new-modal')).toBeVisible(); // o modal segue aberto para escolher outro horário
    expect(linhasDoPaciente(seed.patientId), 'ocupado: 0 linhas novas depois do clique').toBe(antes);
    await page.screenshot({ path: testInfo.outputPath('4-alt1-ocupado-erro.png') });
  });

  test('alt 2: staff SÓ com patient_admission:read vê a lista mas o botão "Nueva agenda" não existe; o POST direto leva 403 e o banco fica inalterado', async ({ page, request }, testInfo) => {
    const antes = linhasDoPaciente(seed.patientId);
    await loginAs(page, leitora);
    await abrirAba(page, seed.patientId);
    // Controle positivo: a aba e a lista abrem (a ausência do botão não é aba quebrada) — a reunião cancelada do feliz está lá.
    await expect(page.locator('[data-testid^="admission-row-"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('admission-new-button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nueva agenda' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('5-alt2-sem-botao.png') });

    const direto = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/admission-appointments`, {
      headers: { Authorization: `Bearer ${tokenFor(leitora)}` },
      data: { hostEmail: ANA, slotStartISO: `${diaLivre().iso}T11:00` },
    });
    expect(direto.status()).toBe(403);
    expect(await direto.json()).toMatchObject({ code: 'missing_cell' });
    expect(linhasDoPaciente(seed.patientId), 'banco inalterado').toBe(antes);
    // Quem tem a célula leva a rota ao 201 com o MESMO corpo (a recusa acima é da célula, não do corpo): controle positivo.
    const comCelula = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/admission-appointments`, {
      headers: { Authorization: `Bearer ${tokenFor(operadora)}` },
      data: { hostEmail: ANA, slotStartISO: `${diaLivre().iso}T11:00` },
    });
    expect(comCelula.status()).toBe(201);
    expect(linhasDoPaciente(seed.patientId)).toBe(antes + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Vínculo do Tactiq do PRÓPRIO operador (TactiqLinkPage) — e2e de tela, API e Postgres reais.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TACTIQ_EXTERNO = 'https://fake-tactiq.example.test/**';
const PAGINA_TACTIQ = '/admin/mi-cuenta/tactiq';

test.describe('admissao-049 — vínculo Tactiq do operador: vincular, volta do callback e célula (spec 049) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  const mk = (nome: string) => {
    const uid = `e2e-049-tq-${nome}-${RUN_ID}`;
    return { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };
  };
  const vinculadora = mk('novo'); // sem linha em tactiq_links (estado `missing`)
  const jaVinculada = mk('linked'); // linha `linked` semeada
  const soLeitura = mk('leitura'); // só own_tactiq_link:read
  const todas = [vinculadora, jaVinculada, soLeitura];
  const grupos: Record<string, string> = {};

  test.beforeAll(() => {
    for (const u of todas) {
      grupos[u.uid] = seedStaffInGroup({ uid: u.uid, email: u.email, groupName: `Adm049 Tq ${u.uid}`, country: 'AR' }).groupId;
      grantCell(grupos[u.uid], 'own_tactiq_link', 'read');
      if (u !== soLeitura) grantCell(grupos[u.uid], 'own_tactiq_link', 'create');
    }
    psql(`INSERT INTO tactiq_links (host_email, firebase_uid, status, linked_at, last_check_at, last_check_outcome)
          VALUES ('${jaVinculada.email}', '${jaVinculada.uid}', 'linked', now() - interval '3 days', now() - interval '2 hours', 'ok')`);
  });

  test.afterAll(() => {
    for (const u of todas) {
      safeSql(`DELETE FROM tactiq_oauth_states WHERE firebase_uid = '${u.uid}'`);
      safeSql(`DELETE FROM tactiq_links WHERE lower(host_email) = '${u.email}'`);
      cleanupStaffAndGroup(u.uid, grupos[u.uid]);
    }
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Adm049 Tq %${RUN_ID}'`);
  });

  test('feliz: sem vínculo, "Vincular Tactiq" faz o POST real e o navegador vai ao authorizeUrl do Tactiq (state gravado no banco)', async ({ page }, testInfo) => {
    // Fronteira externa: o domínio do Tactiq não pode ser alcançado. Só ele é interceptado; a API (POST) é a real.
    const destinos: string[] = [];
    await page.route(TACTIQ_EXTERNO, async (route) => {
      destinos.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body data-testid="tactiq-externo">Tactiq (dublê de fronteira)</body></html>' });
    });
    await loginAs(page, vinculadora);
    await page.goto(PAGINA_TACTIQ);
    await expect(page.getByTestId('tactiq-link-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tactiq-state')).toHaveText('Sin vincular');
    await expect(page.getByTestId('tactiq-linked-at')).toHaveCount(0);
    await expect(page.getByTestId('tactiq-link-button')).toHaveText('Vincular Tactiq');
    expect(Number(scalar(`SELECT count(*) FROM tactiq_oauth_states WHERE firebase_uid = '${vinculadora.uid}'`))).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('6-tactiq-feliz-sem-vinculo.png') });

    const post = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/admin\/me\/tactiq-link$/.test(r.url()));
    await page.getByTestId('tactiq-link-button').click();
    expect((await post).status()).toBe(200);
    await expect(page.getByTestId('tactiq-externo')).toBeVisible({ timeout: 15_000 });
    // O destino é lido da barra do navegador: o `authorizeUrl` do Tactiq com o `state` e o desafio PKCE (S256).
    const url = new URL(page.url());
    expect(url.origin).toBe('https://fake-tactiq.example.test');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')?.length ?? 0).toBeGreaterThan(20);
    expect(destinos).toHaveLength(1);
    // O banco concorda: 1 state do operador, ainda não consumido, com validade futura; nenhum vínculo foi criado.
    expect(scalar(`SELECT count(*) || '|' || count(*) FILTER (WHERE consumed_at IS NULL AND expires_at > now()) FROM tactiq_oauth_states WHERE firebase_uid = '${vinculadora.uid}'`)).toBe('1|1');
    expect(scalar(`SELECT count(*) FROM tactiq_links WHERE lower(host_email) = '${vinculadora.email}'`)).toBe('0');
  });

  test('alt 1: volta do callback com ?tactiq=error mostra o banner de erro, limpa a URL e o estado segue "Sin vincular"', async ({ page }, testInfo) => {
    await loginAs(page, vinculadora);
    await page.goto(`${PAGINA_TACTIQ}?tactiq=error&reason=exchange_failed`);
    await expect(page.getByTestId('tactiq-banner-error')).toHaveText('No pudimos completar la vinculación con Tactiq. Probá de nuevo.');
    await expect(page.getByTestId('tactiq-banner-linked')).toHaveCount(0);
    await expect(page.getByTestId('tactiq-state')).toHaveText('Sin vincular');
    await expect(page).toHaveURL(new RegExp(`${PAGINA_TACTIQ}$`)); // F5 não repete o erro
    await expect(page.getByTestId('tactiq-link-button')).toBeEnabled(); // dá para tentar de novo
    await page.screenshot({ path: testInfo.outputPath('7-tactiq-alt1-erro.png') });
    await page.reload();
    await expect(page.getByTestId('tactiq-state')).toBeVisible();
    await expect(page.getByTestId('tactiq-banner-error')).toHaveCount(0);
    expect(scalar(`SELECT count(*) FROM tactiq_links WHERE lower(host_email) = '${vinculadora.email}'`)).toBe('0');
  });

  test('alt 2: vínculo `linked` mostra estado e datas (e o banner de sucesso na volta) e o token nunca aparece na resposta', async ({ page }, testInfo) => {
    await loginAs(page, jaVinculada);
    await page.goto(`${PAGINA_TACTIQ}?tactiq=linked`);
    await expect(page.getByTestId('tactiq-banner-linked')).toHaveText('Listo: tu cuenta de Tactiq quedó vinculada.');
    await expect(page.getByTestId('tactiq-state')).toHaveText('Vinculado');
    await expect(page.getByTestId('tactiq-linked-at')).not.toHaveText('—');
    await expect(page.getByTestId('tactiq-last-check-at')).not.toHaveText('—');
    await expect(page.getByTestId('tactiq-link-button')).toHaveText('Volver a vincular');
    await page.screenshot({ path: testInfo.outputPath('8-tactiq-alt2-vinculado.png') });
    // O estado vem do banco real: o token nunca chega à tela nem à resposta.
    const corpo = await page.request.get(`${ABAC_API_URL}/api/admin/me/tactiq-link`, { headers: { Authorization: `Bearer ${tokenFor(jaVinculada)}` } });
    expect(JSON.stringify(await corpo.json())).not.toMatch(/token/i);
  });

  test('alt 3: quem só tem `own_tactiq_link:read` vê a tela mas não tem o botão, e o POST direto leva 403 sem criar state', async ({ page }, testInfo) => {
    await loginAs(page, soLeitura);
    await page.goto(PAGINA_TACTIQ);
    await expect(page.getByTestId('tactiq-state')).toHaveText('Sin vincular'); // controle positivo: a tela abriu
    await expect(page.getByTestId('tactiq-link-button')).toHaveCount(0);
    const direto = await page.request.post(`${ABAC_API_URL}/api/admin/me/tactiq-link`, { headers: { Authorization: `Bearer ${tokenFor(soLeitura)}` } });
    expect(direto.status()).toBe(403);
    expect(Number(scalar(`SELECT count(*) FROM tactiq_oauth_states WHERE firebase_uid = '${soLeitura.uid}'`))).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('9-tactiq-alt3-so-leitura.png') });
  });
});
