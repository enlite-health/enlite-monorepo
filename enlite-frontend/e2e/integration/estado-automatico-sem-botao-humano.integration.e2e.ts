/**
 * estado-automatico-sem-botao-humano.integration.e2e.ts @integration — estado-automatico-do-paciente, F5 (D6): a TELA sem o botão manual de estado.
 *
 * Stack real (Vite + API docker com mock auth, engine ABAC OFF → `cells === null`) + Postgres real, SEM `page.route` de dado (`loginComoStaffMock` só
 * intercepta o Identity Toolkit e troca o header). Gestos de uma pessoa: click, `keyboard.type`, arrasto de MOUSE; valores lidos da TELA e do BANCO.
 *
 *  1  Kanban — o card de Búsqueda não tem atributo de arrasto; `dragTo` e o arrasto de mouse para "Activo" não mandam escrita nenhuma e, depois de
 *     recarregar, o card segue em Búsqueda (banco e trilha iguais); o servidor, chamado direto com `kanban`/`admin_panel`, também recusa (422 NOT_MANUAL);
 *  2  Ficha — não há select de estado; só as AÇÕES dos estados humanos (Pausar, Suspender, Dar de alta, Dar de baja); nenhuma leva a Búsqueda, Reemplazo
 *     ou Activo; Pausar (ação humana) continua funcionando de ponta a ponta e a trilha grava `admin_panel`.
 * A cadeia do fluxo automático pela tela (item 4 do `a-testar`) roda DE NOVO sem o botão em `estado-automatico-cadeia-humano.integration.e2e.ts` (F4);
 * os dois arquivos entram juntos no `grep:` do `pr-gate.yml`.
 *
 * Outbound mapeado: só leituras e escritas em Postgres pela API; nenhum canal real (WhatsApp, Talentum, Ana Care, Google, Short.io). Fixtures sintéticas
 * (sobrenome " QA"), nenhum texto clínico. Screenshot por passo (anexo) + vídeo.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { tokenFor, type MockUser } from '../helpers/abac-stack-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import { escolherNoCombo } from '../helpers/combobox';
import { backendUrl } from '../helpers/lancamento-e2e-helper';

const STAFF: MockUser = { uid: 'e2e-int-admin-f5-sem-botao', email: 'admin.f5.sem.botao@e2e.test', role: 'admin', country: 'AR' };
const STAMP = Date.now().toString().slice(-6);

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

const statusDe = (id: string): string => runSQL(`SELECT status FROM patients WHERE id = '${id}'`).trim();
const trilhaDe = (id: string): number => Number(runSQL(`SELECT count(*) FROM patient_status_history WHERE patient_id = '${id}'`).trim());

async function anexar(page: Page, info: TestInfo, nome: string): Promise<void> {
  await info.attach(nome, { body: await page.screenshot({ animations: 'disabled', caret: 'hide' }), contentType: 'image/png' });
}

/** O card do paciente está NESTA coluna do Kanban (lido da tela, depois de carregar o board). */
async function cardNaColuna(page: Page, patientId: string, coluna: string): Promise<void> {
  await page.goto('/admin/patients/kanban');
  await expect(page.getByTestId('patient-kanban-board')).toBeVisible({ timeout: 30_000 });
  const card = page.getByTestId(`kanban-column-${coluna}`).getByTestId(`patient-kanban-card-${patientId}`);
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await card.scrollIntoViewIfNeeded();
}

test.describe('estado-automatico-sem-botao-humano: a tela sem arrasto e sem select de estado @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('Kanban: o card não é arrastável e arrastar para "Activo" não muda nada depois de recarregar', async ({ page, request }, testInfo) => {
    const { patientId } = insertTestPatient({ status: 'SEARCHING', firstName: 'F5SemBotao', lastName: `Kanban${STAMP} QA` });
    try {
      const escritas: string[] = [];
      page.on('request', (r) => {
        if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(r.method()) && /\/api\/admin\/patients\//.test(r.url())) escritas.push(`${r.method()} ${r.url()}`);
      });
      await loginComoStaffMock(page, STAFF, 'E2E F5 Sem Botao');
      await cardNaColuna(page, patientId, 'SEARCHING');
      const antes = { status: statusDe(patientId), trilha: trilhaDe(patientId) };
      expect(antes.status).toBe('SEARCHING');

      // Sem atributo de arrasto: nem o wrapper antigo (`kanban-draggable-*`), nem `aria-roledescription` do dnd-kit.
      await expect(page.getByTestId(`kanban-draggable-${patientId}`)).toHaveCount(0);
      const embrulho = page.getByTestId(`kanban-card-${patientId}`);
      await expect(embrulho).toHaveCount(1);
      await expect(embrulho).not.toHaveAttribute('aria-roledescription', /.+/);
      await expect(embrulho).not.toHaveAttribute('draggable', /.+/);
      await anexar(page, testInfo, '1-card-sem-arrasto');

      const card = page.getByTestId(`patient-kanban-card-${patientId}`);
      const ativo = page.getByTestId('kanban-column-ACTIVE');
      await card.dragTo(ativo); // o gesto genérico do Playwright
      await dndKitDrag(page, card, ativo); // e o de mouse que o dnd-kit exigiria (PointerSensor, 8 px)
      await anexar(page, testInfo, '2-depois-de-arrastar');

      expect(escritas, 'nenhuma escrita sai da página').toEqual([]);
      await expect(page.getByRole('dialog').filter({ hasNotText: 'Notificaciones' })).toHaveCount(0);
      await cardNaColuna(page, patientId, 'SEARCHING'); // recarregado: continua em Búsqueda
      await expect(page.getByTestId('kanban-column-ACTIVE').getByTestId(`patient-kanban-card-${patientId}`)).toHaveCount(0);
      expect({ status: statusDe(patientId), trilha: trilhaDe(patientId) }).toEqual(antes);

      // O servidor também recusa, direto (pelas duas origens): a tela não é a única trava.
      for (const changeSource of ['kanban', 'admin_panel']) {
        const r = await request.put(`${backendUrl()}/api/admin/patients/${patientId}/status`, {
          headers: { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' },
          data: { status: 'ACTIVE', changeSource },
        });
        expect(r.status(), `PUT ACTIVE ${changeSource}`).toBe(422);
        expect(((await r.json()) as { code: string }).code).toBe('PATIENT_STATUS_NOT_MANUAL');
      }
      expect({ status: statusDe(patientId), trilha: trilhaDe(patientId) }).toEqual(antes);
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('Ficha: não há select de estado — só as ações dos estados humanos; Pausar continua de ponta a ponta', async ({ page }, testInfo) => {
    const { patientId } = insertTestPatient({ status: 'ACTIVE', firstName: 'F5SemBotao', lastName: `Ficha${STAMP} QA` });
    try {
      await loginComoStaffMock(page, STAFF, 'E2E F5 Sem Botao');
      await page.goto(`/admin/patients/${patientId}`);
      await expect(page.getByTestId('patient-status-control')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('patient-status-actions')).toBeVisible({ timeout: 20_000 }); // a lista vem do SERVIDOR
      await expect(page.getByTestId('patient-status-badge')).toContainText('Activo'); // o estado atual é lido da tela

      // Nada de select nem de "Guardar": o estado não se escolhe à mão.
      await expect(page.getByTestId('patient-status-select')).toHaveCount(0);
      await expect(page.getByTestId('patient-status-save')).toHaveCount(0);
      await expect(page.getByTestId('patient-status-control').locator('select')).toHaveCount(0);

      // As ações do servidor (controle positivo) e nenhuma que leve a Búsqueda, Reemplazo ou Activo.
      const acoes = page.locator('[data-testid^="patient-status-action-"]:not([data-testid$="-form"]):not([data-testid$="-error"])');
      await expect(page.getByTestId('patient-status-action-pausar')).toBeVisible();
      for (const nome of ['pausar', 'suspender', 'dar_alta', 'dar_baja']) await expect(page.getByTestId(`patient-status-action-${nome}`)).toBeVisible();
      for (const nome of ['retomar', 'reativar']) await expect(page.getByTestId(`patient-status-action-${nome}`)).toHaveCount(0); // só existem em En espera/Suspendido/Baja
      await expect(acoes).toHaveCount(4);
      for (const rotulo of await acoes.allTextContents()) expect(rotulo).not.toMatch(/b[uú]squeda|reemplazo|activo/i);
      await anexar(page, testInfo, '3-ficha-so-com-acoes');

      // O que é humano continua: Pausar com motivo (click + escolher na lista).
      await page.getByTestId('patient-status-action-pausar').click();
      await escolherNoCombo(page, page.getByTestId('patient-status-action-reason'), 'Obra social'); // INSURER
      await page.getByTestId('patient-status-action-confirm').click();
      await expect(page.getByTestId('patient-status-badge')).toContainText('En espera', { timeout: 20_000 });
      await expect.poll(() => statusDe(patientId)).toBe('ON_HOLD');
      expect(runSQL(`SELECT old_value || '|' || new_value || '|' || change_source FROM patient_status_history WHERE patient_id = '${patientId}' ORDER BY created_at DESC, id DESC LIMIT 1`).trim())
        .toBe('ACTIVE|ON_HOLD|admin_panel');
      await anexar(page, testInfo, '4-pausado');
    } finally {
      cleanupTestPatient(patientId);
    }
  });
});
