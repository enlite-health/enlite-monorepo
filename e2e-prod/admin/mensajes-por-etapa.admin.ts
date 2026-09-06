/**
 * Mensagem por etapa (DEC-12 / PEND-14) — monitor DIÁRIO contra produção.
 *
 * ── POR QUE ESTE SPEC NÃO CONFIGURA NADA ────────────────────────────────────
 * Configurar uma etapa em produção é ARMAR um envio real: a próxima tarjeta que
 * um humano mover dispara a mensagem para uma cuidadora de verdade. E a lição já
 * está escrita em `regression/kanban-staff.regression.ts`: um spec do monitor que
 * só é seguro enquanto uma config estiver `false` está *inerte, não seguro* — ele
 * vira envio real às 3h da manhã do dia seguinte à virada da chave.
 *
 * Por isso tudo aqui é seguro POR MECANISMO, não por estado:
 *   · leitura (`GET`) e navegação, que não escrevem;
 *   · e no caminho de escrita, SÓ REJEIÇÕES — `QUALIFIED` (409, built-in),
 *     MARKETING (400 CATEGORY) e deny-list (400 DENY_LIST). Nenhuma delas grava,
 *     hoje ou depois, porque o controller barra ANTES do `UPDATE`.
 * Um `PUT` "que hoje é no-op" seria a armadilha exata do aviso acima: no dia em
 * que o Javier ligar uma etapa, ele passaria a DESLIGÁ-LA todo dia às 3h.
 *
 * ── O QUE ESTE SPEC PROVA ───────────────────────────────────────────────────
 *  1. a tela renderiza as 9 etapas e a coluna da mensagem;
 *  2. a modal abre e mostra o TEXTO da mensagem (não o slug) — que é a razão de
 *     a modal existir; e mostra os bloqueados agrupados pelo motivo;
 *  3. o contrato da rota: `body` e `bodyTwilio` chegam, e a elegibilidade é
 *     coerente — todo elegível tem texto aprovado e tantos nomes quanto slots;
 *  4. as três rejeições de escrita continuam rejeitando.
 *
 * ── O QUE ELE NÃO PROVA (limite honesto) ────────────────────────────────────
 *  · Não prova que a busca do texto na Content API funciona HOJE: ela só roda
 *    para template com `body_twilio` nulo, e depois do primeiro preenchimento não
 *    há mais o que buscar. O que ele pega é a consequência — elegível sem texto.
 *  · Não prova o envio: nenhuma etapa está configurada, e configurar é ato do
 *    Gabriel, não de um teste.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { newAdminApiContext } from '../src/support/adminApi';

interface TemplateOption {
  slug: string;
  body: string | null;
  bodyTwilio: string | null;
  category: string | null;
  eligible: boolean;
  reason: string | null;
  placeholders: string[];
}
interface StageRow { stage: string; templateSlug: string | null; enabled: boolean; builtin: string | null }

/** Slots `{{n}}` distintos do corpo aprovado — mesma conta que o backend faz. */
function slotsDe(body: string | null): string[] {
  if (!body) return [];
  return [...new Set([...body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]))];
}

let api: APIRequestContext;
/** Config de PRE_SCREENING ANTES das rejeições — a comparação é contra ela, não contra "null". */
let configAntes: StageRow | undefined;

test.beforeAll(async () => {
  api = await newAdminApiContext();
  const { data } = await (await api.get('/api/admin/funnel-stage-messages')).json();
  configAntes = (data.stages as StageRow[]).find((s) => s.stage === 'PRE_SCREENING');
});
test.afterAll(async () => { await api.dispose(); });

test('[@route:/admin/mensajes-por-etapa @depth:smoke] a tela lista as 9 etapas do Kanban', async ({ page }) => {
  await page.goto('/admin/mensajes-por-etapa');
  await expect(page.getByTestId('fsm-table')).toBeVisible({ timeout: 30_000 });

  const linhas = page.locator('[data-testid^="fsm-row-"]');
  await expect(linhas).toHaveCount(9);
  // QUALIFIED é built-in (convite de entrevista) e não se configura aqui.
  await expect(page.getByTestId('fsm-row-QUALIFIED')).toContainText(/Incorporada/i);
});

test('[@route:/admin/mensajes-por-etapa @depth:smoke] a modal mostra o TEXTO da mensagem, não o slug', async ({ page }) => {
  await page.goto('/admin/mensajes-por-etapa');
  await expect(page.getByTestId('fsm-table')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('fsm-open-PRE_SCREENING').click();
  await expect(page.getByTestId('fsm-modal')).toBeVisible();

  // Há pelo menos uma opção escolhível, e ela mostra texto — a razão da modal.
  const opcoes = page.locator('[data-testid^="fsm-option-"]');
  await expect(opcoes.first()).toBeVisible();
  await opcoes.first().click();
  await expect(page.getByTestId('fsm-preview')).toBeVisible();
  await expect(page.getByTestId('fsm-preview')).not.toHaveText('');

  // Os bloqueados aparecem agrupados pelo MOTIVO, sem clique.
  await expect(page.getByTestId('fsm-blocked-list')).toBeVisible();

  // Sai sem gravar nada.
  await page.getByTestId('fsm-modal-cancel').click();
  await expect(page.getByTestId('fsm-modal')).toHaveCount(0);
});

test('[@route:GET /api/admin/funnel-stage-messages @depth:smoke] contrato: 9 etapas, e todo elegível tem texto aprovado com os slots batendo', async () => {
  const res = await api.get('/api/admin/funnel-stage-messages');
  expect(res.status()).toBe(200);
  const { data } = (await res.json()) as { data: { country: string; stages: StageRow[]; templates: TemplateOption[] } };

  expect(data.country).toBe('AR');
  expect(data.stages).toHaveLength(9);
  expect(data.stages.find((s) => s.stage === 'QUALIFIED')?.builtin).toBe('interview_invite');

  // Os dois textos chegam à tela (sem eles não existe prévia).
  expect(data.templates.length).toBeGreaterThan(0);
  expect(data.templates.every((t) => 'body' in t && 'bodyTwilio' in t)).toBe(true);

  // INVARIANTE da elegibilidade: quem pode ser escolhido tem texto aprovado, e a
  // Meta pede exatamente tantos slots quantos nomes o sistema preenche. É o que
  // impede o envio de morrer com "Content Variables parameter is invalid".
  for (const t of data.templates.filter((x) => x.eligible)) {
    expect(t.bodyTwilio, `elegível sem texto aprovado: ${t.slug}`).toBeTruthy();
    expect(slotsDe(t.bodyTwilio).length, `slots ≠ variáveis em ${t.slug}`).toBe(t.placeholders.length);
    expect(t.reason).toBeNull();
  }

  // E ninguém elegível carrega um motivo de bloqueio.
  expect(data.templates.filter((t) => t.eligible && t.reason !== null)).toEqual([]);
});

test('[@route:PUT /api/admin/funnel-stage-messages/:stage @depth:error] QUALIFIED é built-in → 409, sem gravar', async () => {
  const res = await api.put('/api/admin/funnel-stage-messages/QUALIFIED', {
    data: { template_slug: 'qualified_reprogram_confirm', enabled: true },
  });
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toMatch(/built-in/i);
});

test('[@route:PUT /api/admin/funnel-stage-messages/:stage @depth:error] template MARKETING → 400 CATEGORY (lex C5), sem gravar', async () => {
  // Escolhe do próprio catálogo de produção um MARKETING — o teste não inventa slug.
  const lista = await (await api.get('/api/admin/funnel-stage-messages')).json();
  const marketing = (lista.data.templates as TemplateOption[]).find((t) => t.reason === 'CATEGORY');
  test.skip(!marketing, 'nenhum template MARKETING ativo no catálogo');

  const res = await api.put('/api/admin/funnel-stage-messages/PRE_SCREENING', {
    data: { template_slug: marketing!.slug, enabled: true },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).details?.reason).toBe('CATEGORY');
});

test('[@route:PUT /api/admin/funnel-stage-messages/:stage @depth:error] lembrete/cobrança → 400 DENY_LIST (lex C6), sem gravar', async () => {
  const lista = await (await api.get('/api/admin/funnel-stage-messages')).json();
  const negado = (lista.data.templates as TemplateOption[]).find((t) => t.reason === 'DENY_LIST');
  test.skip(!negado, 'nenhum template na deny-list ativo no catálogo');

  const res = await api.put('/api/admin/funnel-stage-messages/PRE_SCREENING', {
    data: { template_slug: negado!.slug, enabled: true },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).details?.reason).toBe('DENY_LIST');
});

test('[@route:PUT /api/admin/funnel-stage-messages/:stage @depth:error] nenhuma das rejeições mudou a configuração de produção', async () => {
  // Fecha o ciclo: as chamadas acima passaram pelo controller e NADA foi gravado.
  //
  // A comparação é contra o estado LIDO NO INÍCIO, não contra `null`: asserir
  // "está desconfigurado" faria este teste ficar vermelho no dia em que o Javier
  // ligasse a etapa — vermelho por configuração legítima, que é o oposto de um
  // monitor. O que se afirma é a INVARIÂNCIA, não o valor.
  const { data } = await (await api.get('/api/admin/funnel-stage-messages')).json();
  const depois = (data.stages as StageRow[]).find((s) => s.stage === 'PRE_SCREENING')!;
  expect(depois.templateSlug).toBe(configAntes?.templateSlug ?? null);
  expect(depois.enabled).toBe(configAntes?.enabled ?? false);
});
