/**
 * Caminhos de ERRO do fluxo público de admissão, contra PRODUÇÃO.
 *
 * Regra da suíte: erro de NEGÓCIO se testa real (prod rejeita input ruim de
 * verdade, sem efeito colateral); erro de INFRA se monitora. Aqui tudo é
 * negócio — nenhum destes payloads chega a criar paciente.
 *
 * Cobre as duas frentes que o usuário encontra quando erra:
 *   • a TELA barrando antes de enviar (checkbox de consentimento, email inválido)
 *   • a API barrando quando alguém chama direto (Zod strict, país inválido,
 *     paciente inexistente, horário inválido)
 *
 * Contratos confirmados no código, não presumidos:
 *   POST /leads               → 201 sucesso · 400 body inválido
 *   GET  /admission/slots     → 200 { slots } · 400 país inválido
 *   POST /admission/book      → 200 · 400 body · 404 PATIENT_NOT_FOUND · 409 SLOT_TAKEN
 */
import { test, expect, request, type APIRequestContext } from '@playwright/test';
import { PROD_API_URL } from '../src/support/env';

const BOGUS_UUID = '00000000-0000-4000-8000-000000000000';

let api: APIRequestContext;

test.beforeAll(async () => {
  // Endpoints públicos: contexto SEM autenticação, como um visitante qualquer.
  api = await request.newContext({ baseURL: PROD_API_URL });
});

test.afterAll(async () => {
  await api.dispose();
});

async function anotar(res: { status: () => number; json: () => Promise<unknown> }, esperado: number) {
  const status = res.status();
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  test.info().annotations.push({
    type: 'validacao',
    description: `status=${status} error=${body?.error ?? '(sem corpo)'} (esperado ${esperado})`,
  });
  return { status, body };
}

// ── API pública: intake de lead ───────────────────────────────────────────────

// Payload VÁLIDO exceto pelo campo que cada teste quebra de propósito (D108:
// country e consent viraram obrigatórios; sem eles no base, todo body 400aria
// pelo motivo errado e nenhum teste provaria a regra que dá nome a ele).
const LEAD_VALIDO = {
  serviceType: 'cuidadores',
  requesterType: 'patient',
  email: 'gabriel+e2e-invalid@gmail.com',
  phone: '+54 9 11 5555 0000',
  country: 'AR',
  consent: true,
} as const;

test('[@route:POST /api/public/v1/leads @depth:error] email inválido → 400', async () => {
  const res = await api.post('/api/public/v1/leads', {
    data: { ...LEAD_VALIDO, email: 'nao-e-email' },
  });
  const { status } = await anotar(res, 400);
  expect(status).toBe(400);
});

test('[@route:POST /api/public/v1/leads @depth:error] telefone vazio → 400', async () => {
  const res = await api.post('/api/public/v1/leads', {
    data: { ...LEAD_VALIDO, phone: '' },
  });
  const { status } = await anotar(res, 400);
  expect(status).toBe(400);
});

test('[@route:POST /api/public/v1/leads @depth:error] serviceType fora do vocabulário → 400', async () => {
  const res = await api.post('/api/public/v1/leads', {
    data: { ...LEAD_VALIDO, serviceType: 'astronautas' },
  });
  const { status } = await anotar(res, 400);
  expect(status).toBe(400);
});

test('[@route:POST /api/public/v1/leads @depth:error] campo extra é rejeitado (schema strict) → 400', async () => {
  const res = await api.post('/api/public/v1/leads', {
    data: {
      ...LEAD_VALIDO,
      // superfície pública: nada além do contrato entra
      isTest: true,
      status: 'ACTIVE',
    },
  });
  const { status } = await anotar(res, 400);
  expect(status, 'o schema é .strict() — campo extra não pode passar').toBe(400);
});

test('[@route:POST /api/public/v1/leads @depth:error] país fora de AR|BR → 400', async () => {
  const res = await api.post('/api/public/v1/leads', {
    data: { ...LEAD_VALIDO, country: 'US' },
  });
  const { status } = await anotar(res, 400);
  expect(status).toBe(400);
});

test('[@route:POST /api/public/v1/leads @depth:error] sem país → 400 (nunca default AR silencioso, D108)', async () => {
  const { country: _pais, ...semPais } = LEAD_VALIDO;
  const res = await api.post('/api/public/v1/leads', { data: semPais });
  const { status } = await anotar(res, 400);
  expect(status, 'lead sem país não pode nascer AR por default').toBe(400);
});

test('[@route:POST /api/public/v1/leads @depth:error] sem consentimento → 400 (gate é o servidor, D108)', async () => {
  const { consent: _consent, ...semConsent } = LEAD_VALIDO;
  const res = await api.post('/api/public/v1/leads', { data: semConsent });
  const { status } = await anotar(res, 400);
  expect(status, 'POST direto sem consent não pode gravar lead contatável').toBe(400);
});

test('[@route:POST /api/public/v1/leads @depth:error] consent=false → 400 (recusa nunca vira cadastro)', async () => {
  const res = await api.post('/api/public/v1/leads', {
    data: { ...LEAD_VALIDO, consent: false },
  });
  const { status } = await anotar(res, 400);
  expect(status).toBe(400);
});

// ── API pública: agenda ───────────────────────────────────────────────────────

test('[@route:GET /api/public/v1/admission/slots @depth:error] país inválido → 400', async () => {
  const res = await api.get('/api/public/v1/admission/slots?country=US');
  const { status } = await anotar(res, 400);
  expect(status).toBe(400);
});

test('[@route:GET /api/public/v1/admission/slots @depth:error] sem país → 400', async () => {
  const res = await api.get('/api/public/v1/admission/slots');
  const { status } = await anotar(res, 400);
  expect(status).toBe(400);
});

test('[@route:POST /api/public/v1/admission/book @depth:error] paciente inexistente → 404 PATIENT_NOT_FOUND', async () => {
  // Horário no futuro e bem-formado: o que falha é o PACIENTE, não o slot.
  const amanha = new Date(Date.now() + 24 * 3600_000);
  amanha.setUTCHours(14, 0, 0, 0);
  const res = await api.post('/api/public/v1/admission/book', {
    data: { patientId: BOGUS_UUID, slotStartISO: amanha.toISOString(), country: 'AR' },
  });
  const { status, body } = await anotar(res, 404);
  expect(status).toBe(404);
  expect(body.error).toBe('PATIENT_NOT_FOUND');
});

test('[@route:POST /api/public/v1/admission/book @depth:error] body inválido → 400', async () => {
  const res = await api.post('/api/public/v1/admission/book', {
    data: { patientId: 'not-a-uuid', slotStartISO: 'ontem', country: 'AR' },
  });
  const { status } = await anotar(res, 400);
  expect(status).toBe(400);
});

// ── A TELA barrando antes de enviar ───────────────────────────────────────────

test('[@route:/admission-ar @depth:error] sem consentimento o envio fica bloqueado', async ({ page }) => {
  let enviou = false;
  page.on('request', (r) => {
    if (r.url().includes('/api/public/v1/leads') && r.method() === 'POST') enviou = true;
  });

  await page.goto('/admission-ar');
  await expect(page.getByTestId('lead-form')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('lead-serviceType').selectOption('cuidadores');
  await page.getByTestId('lead-requesterType-patient').check();
  await page.getByTestId('lead-email').fill('gabriel+e2e-consent@gmail.com');
  await page.getByTestId('lead-phone').fill('+54 9 11 5555 0000');

  // O guard real é o BOTÃO DESABILITADO (`disabled={!consentChecked}`), não uma
  // mensagem de erro: sem o checkbox o submit nunca roda, então o zod nem chega
  // a reclamar. Asserir a mensagem seria testar um mecanismo que não existe.
  const submit = page.getByTestId('lead-submit');
  await expect(submit, 'sem consentimento o envio tem que estar bloqueado').toBeDisabled();

  await submit.click({ force: true }).catch(() => undefined);
  await expect(page.getByTestId('slot-picker')).toHaveCount(0);
  expect(enviou, 'a tela deixou passar um cadastro sem consentimento').toBe(false);

  // E marcar o checkbox destrava — prova que o gate é o consentimento mesmo,
  // e não outro campo faltando.
  await page.getByTestId('lead-consent').check();
  await expect(submit).toBeEnabled();
});

test('[@route:/admission-ar @depth:error] email inválido não avança para a agenda', async ({ page }) => {
  await page.goto('/admission-ar');
  await expect(page.getByTestId('lead-form')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('lead-serviceType').selectOption('cuidadores');
  await page.getByTestId('lead-requesterType-patient').check();
  await page.getByTestId('lead-email').fill('nao-e-email');
  await page.getByTestId('lead-phone').fill('+54 9 11 5555 0000');
  await page.getByTestId('lead-consent').check();
  await page.getByTestId('lead-submit').click();

  await expect(page.getByTestId('slot-picker')).toHaveCount(0);
});
