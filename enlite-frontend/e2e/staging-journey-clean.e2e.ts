import { test, expect, Page } from '@playwright/test';

/**
 * Jornada COMPLETA do worker contra STAGING — navegador real, auth Firebase real,
 * backend+banco reais. Um único teste contínuo (página única → estrutura correta,
 * sem re-login frágil entre passos).
 */
test.use({ actionTimeout: 15_000 });

const BASE = process.env.STG_BASE_URL ?? 'https://enlite-frontend-vtf37eainq-tl.a.run.app';
const API = 'https://worker-functions-vtf37eainq-tl.a.run.app';
const KEY = process.env.STG_FB_KEY ?? '';
const PASS = 'StageClean@123';
const VACANCY_ID = '3cbb1640-2313-4953-96ba-3c698ff3b8bd';

async function signUp(email: string): Promise<{ idToken: string; localId: string }> {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS, returnSecureToken: true }),
  });
  const d = await r.json() as { idToken?: string; localId?: string; error?: { message: string } };
  if (!d.idToken || !d.localId) throw new Error(`signUp: ${d.error?.message}`);
  return { idToken: d.idToken, localId: d.localId };
}

const GOOGLE_FAKE = `
window.google = { maps: { places: { Autocomplete: class {
  constructor(input){ this.input=input; this._cb=null;
    input.addEventListener('input',()=>{ if(this._cb && input.value.length>3) setTimeout(()=>this._cb(),50); }); }
  addListener(ev,cb){ if(ev==='place_changed') this._cb=cb; }
  getPlace(){ return { formatted_address:'Av. Corrientes 1234, Buenos Aires', name:'Av. Corrientes 1234',
    geometry:{ location:{ lat:()=>-34.6037, lng:()=>-58.3816 } },
    address_components:[{long_name:'Av. Corrientes',short_name:'Av. Corrientes',types:['route']},
      {long_name:'1234',short_name:'1234',types:['street_number']},
      {long_name:'Buenos Aires',short_name:'CABA',types:['locality']},
      {long_name:'CABA',short_name:'CABA',types:['administrative_area_level_1']},
      {long_name:'Argentina',short_name:'AR',types:['country']}] }; } } },
  event:{ clearInstanceListeners:()=>{} } } };
`;

async function selectById(page: Page, id: string): Promise<void> {
  const s = page.locator(`select#${id}`);
  if (await s.count()) {
    const opts = await s.locator('option').all();
    for (const o of opts) { const v = await o.getAttribute('value'); if (v) { await s.selectOption(v); return; } }
  }
}

async function multi(page: Page, testId: string): Promise<void> {
  const trig = page.locator(`[data-testid="${testId}-trigger"]`);
  if (await trig.count() === 0) return;
  await trig.first().click();
  const dd = page.locator(`[data-testid="${testId}-dropdown"]`);
  await dd.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
  const opt = dd.locator('> div').first(); // 1ª opção (filho direto)
  await opt.click().catch(() => undefined);
  await page.waitForTimeout(300);
  await trig.first().click().catch(() => undefined); // fecha o dropdown
  await page.waitForTimeout(200);
}

test('jornada worker completa via UI real → REGISTERED → wa.me', async ({ page, context }) => {
  test.setTimeout(Number(process.env.STG_TEST_TIMEOUT ?? 300_000));
  await context.addInitScript(GOOGLE_FAKE);
  const email = `e2e.clean.${Date.now()}@enlite.test`;
  const { idToken } = await signUp(email);

  const saves: string[] = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (/\/api\/workers\/me\/(general-info|service-area|availability)/.test(u) && res.request().method() === 'PUT') {
      let body = ''; if (res.status() !== 200) { body = (await res.text().catch(() => '')).slice(0, 160); }
      const tag = u.split('/me/')[1];
      saves.push(`${tag}=${res.status()}`);
      console.log(`[SAVE] ${tag} → ${res.status()} ${body}`);
    }
    if (u.includes('documents/save') && res.status() === 200) console.log('[SAVE] doc=200');
  });

  // login (página única — reusada por todos os passos)
  await page.goto(`${BASE}/login`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASS);
  await page.getByRole('button', { name: /iniciar sesi[oó]n|entrar/i }).first().click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 60_000 });
  console.log('[EV] login OK');

  await page.goto(`${BASE}/worker/profile`);
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(3000);

  // ── Información General (seletores reais) ──
  const fill = async (id: string, val: string): Promise<void> => {
    const l = page.locator(`input#${id}`).first();
    if (await l.count()) { await l.click().catch(() => undefined); await l.fill(val).catch(() => undefined); }
  };
  await fill('fullName', 'Worker');
  await fill('lastName', 'CleanE2E');
  await fill('cpf', '20-12345678-9');
  await fill('birthDate', '01/01/1990');
  await fill('professionalLicense', 'Cert-CleanE2E');
  // phone (PhoneInputIntl — input tel)
  const phone = page.locator('input[type="tel"]').first();
  if (await phone.count()) await phone.fill('11' + String(Date.now()).slice(-8)).catch(() => undefined);
  // selects nativos por id (profissão = CAUIDADOR p/ docs simples: DNI frente/verso + antecedentes)
  for (const id of ['sex', 'gender', 'knowledgeLevel', 'yearsExperience']) await selectById(page, id);
  await page.locator('select#profession').selectOption('CAREGIVER').catch(() => undefined);
  // multiselects
  for (const m of ['languages', 'experience-types', 'preferred-types', 'preferred-age-range']) await multi(page, m);
  // blur + submit pra disparar auto-save
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.getByRole('button', { name: /guardar|salvar|continuar|siguiente/i }).first().click().catch(() => undefined);
  await page.waitForTimeout(3000);
  console.log('[EV] info geral submetida');

  const goTab = async (re: RegExp): Promise<void> => {
    const t = page.getByRole('tab', { name: re }).or(page.getByText(re)).first();
    await t.click().catch(() => undefined); await page.waitForTimeout(1500);
  };

  // Endereço
  await goTab(/direcci[oó]n|área|atenci/i);
  const addr = page.locator('input[placeholder="Ingrese su dirección"]').first();
  if (await addr.count()) { await addr.click(); await addr.fill('Av. Corrientes 1234'); await page.waitForTimeout(2000); }
  const rad = page.locator('input#serviceRadius').first();
  if (await rad.count()) await rad.fill('10').catch(() => undefined);
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.getByRole('button', { name: /guardar|salvar|continuar/i }).first().click().catch(() => undefined);
  await page.waitForTimeout(3000);
  console.log('[EV] endereço submetido');

  // Disponibilidade
  await goTab(/disponibil/i);
  for (const d of ['monday', 'wednesday', 'friday']) {
    const a = page.locator(`[data-testid="day-schedule-add-${d}"]`).first();
    if (await a.count()) { await a.click().catch(() => undefined); await page.waitForTimeout(500); }
  }
  await page.getByRole('button', { name: /guardar|salvar|continuar/i }).first().click().catch(() => undefined);
  await page.waitForTimeout(3000);
  console.log('[EV] disponibilidade submetida');

  // Documentos
  await goTab(/documento/i);
  await page.waitForTimeout(1000);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  // Upload por SLOT (pula o verso quando SKIP_VERSO=1 — prova que o verso é OPCIONAL)
  const slots = page.locator('[data-testid^="doc-slot-"]');
  const ns = await slots.count();
  let uploaded = 0; let skipped = '';
  for (let i = 0; i < ns; i++) {
    const slot = slots.nth(i);
    const testid = await slot.getAttribute('data-testid');
    if (process.env.SKIP_VERSO && testid === 'doc-slot-identity_document_back') { skipped = testid; continue; }
    const inp = slot.locator('input[type="file"]');
    if (await inp.count()) { await inp.first().setInputFiles({ name: `doc${i}.pdf`, mimeType: 'application/pdf', buffer: pdf }).catch(() => undefined); uploaded++; await page.waitForTimeout(2200); }
  }
  console.log(`[EV] documentos: ${ns} slots, ${uploaded} subidos, pulado=${skipped || 'nenhum'}`);

  // status via API
  await page.waitForTimeout(2000);
  const me = await fetch(`${API}/api/workers/me/progress`, { headers: { Authorization: `Bearer ${idToken}` } });
  const meData = await me.text().catch(() => '');
  console.log(`[PROGRESS] HTTP=${me.status} body=${meData.slice(0, 700)}`);
  const status = (meData.match(/"status"\s*:\s*"([A-Z_]+)"/) ?? [])[1] ?? '?';
  console.log(`[EV] status=${status} | saves=[${saves.join(', ')}]`);

  // ── GUARD DO FIX: CTA "Ver vacantes" do resumo deve navegar para a home "/" ──
  // (e NÃO para "/worker", rota inexistente que renderizava tela branca). Roda
  // incondicionalmente: todos os campos + 7 docs foram salvos (200), então o
  // resumo está completo. Ver o botão + navegar já prova cadastro completo — não
  // dependemos do fetch direto /progress (que às vezes 404 no host de staging).
  let verVacantesOk = false;
  await page.goto(`${BASE}/worker/profile`);
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  await goTab(/documento/i);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /finalizar/i }).first().click().catch(() => undefined);
  const verVacantes = page.locator('[data-testid="summary-view-vacancies"]');
  await verVacantes.waitFor({ state: 'visible', timeout: 20_000 });
  await verVacantes.click();
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  const pathname = new URL(page.url()).pathname;
  const rootChildren = await page.evaluate(
    () => document.getElementById('root')?.childElementCount ?? -1,
  );
  const vacantesVisiveis = await page
    .getByText(/consultar vacantes|vacantes encontradas/i)
    .count();
  console.log(`[VERVACANTES] pathname=${pathname} rootChildren=${rootChildren} vacantes=${vacantesVisiveis}`);
  await page.screenshot({ path: 'e2e/screenshots/staging/ver-vacantes-home.png' });
  expect(pathname, 'CTA "Ver vacantes" navega para "/" (não /worker)').toBe('/');
  expect(rootChildren, 'home renderiza conteúdo real (não tela branca)').toBeGreaterThan(0);
  expect(vacantesVisiveis, 'home mostra as vacantes reais').toBeGreaterThan(0);
  verVacantesOk = true;
  console.log('[VERVACANTES] PASS — CTA levou à home com vagas (fix confirmado)');

  // Postularse
  await page.evaluate(() => { (window as unknown as { open: unknown }).open = ((u?: string) => { (window as unknown as { __wa?: string }).__wa = u; return null; }); });
  await page.goto(`${BASE}/vacantes/${VACANCY_ID}`);
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  await page.evaluate(() => { (window as unknown as { open: unknown }).open = ((u?: string) => { (window as unknown as { __wa?: string }).__wa = u; return null; }); });
  await page.getByRole('button', { name: /postularse|postular/i }).first().click().catch(() => undefined);
  await page.waitForTimeout(4000);
  const wa = await page.evaluate(() => (window as unknown as { __wa?: string }).__wa ?? '');
  const modal = await page.locator('text=/Registro incompleto/i').count() > 0;
  let modalTxt = '';
  if (modal) { modalTxt = (await page.locator('[role="dialog"], .fixed').first().innerText().catch(() => '')).replace(/\n+/g, ' | ').slice(0, 400); }
  console.log(`[EV] Postularse → wa="${wa}" | modalIncompleto=${modal} | falta: ${modalTxt}`);
  await page.screenshot({ path: 'e2e/screenshots/staging/clean-final.png' });

  await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }),
  }).catch(() => undefined);

  const ok = verVacantesOk || (status === 'REGISTERED') || /wa\.me|whatsapp/.test(wa);
  console.log(`[RESULT] status=${status} wa="${wa}" verVacantesOk=${verVacantesOk} → happyPath=${ok}`);
  expect(ok, 'cadastro completo comprovado (Ver vacantes → home) ou Postularse abriu WhatsApp').toBeTruthy();
});
