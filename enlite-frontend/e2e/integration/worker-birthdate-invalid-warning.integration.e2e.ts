/**
 * worker-birthdate-invalid-warning.integration.e2e.ts @integration
 *
 * T5.6 (spec 025, decisão do Gabriel 21/09, opção A) — prova, contra o backend e o banco REAIS
 * (stack isolado `spec025aviso`), que um worker REGISTERED cuja data de nascimento gravada é
 * INVÁLIDA (não-ISO, herdada do Defeito 1 — o PUT não validava em runtime) vê um AVISO na tela
 * de perfil pedindo pra recadastrar. Sem WhatsApp/Luz — só UI, e o valor cru inválido NUNCA
 * aparece na tela (o campo vem vazio, não com o lixo salvo).
 *
 *   1. (feliz) worker REGISTERED com `birth_date_encrypted` = "25/31/985" (sintético, formato
 *      livre — não é uma data ISO real, nem existe no calendário) faz login, abre
 *      `/worker/profile?tab=general` e vê o aviso em es-AR ("Tu fecha de nacimiento no es
 *      válida..."). O campo `#birthDate` está VAZIO (não mostra o lixo). O worker clica no campo
 *      (`toBeFocused()` prova o foco real), digita a data nova via teclado (`keyboard.type`, não
 *      `fill()` — e2e-humano-nao-e-fill), sai do campo (blur dispara o autosave), a resposta do
 *      PUT é aguardada, e SÓ ENTÃO a página é RECARREGADA — o aviso sumiu e o valor lido da TELA
 *      (não do estado local) é o que foi digitado.
 *   2. (alternativo) worker REGISTERED com data de nascimento VÁLIDA não vê o aviso — o campo
 *      mostra a data certa.
 *   3. (alternativo) worker INCOMPLETE_REGISTER que NUNCA cadastrou data de nascimento
 *      (`birth_date_encrypted IS NULL`) não vê o aviso de inválida — o campo está vazio, mas sem
 *      o aviso (é "nunca cadastrou", não "cadastrou errado"). REGISTERED exige birth_date NOT
 *      NULL (trigger `fn_guard_registered_status`), então o caso "nunca cadastrou" só existe em
 *      INCOMPLETE_REGISTER — a mesma tela, no mesmo formulário.
 *
 * Mesmo padrão de auth de `worker-profile-fields-persist.integration.e2e.ts`
 * (`installRealRegInterceptors`/`loginNewWorker` — USE_MOCK_AUTH=true, Firebase Identity Toolkit
 * interceptado, `/api/**` passa para o backend real com `Authorization: Bearer mock_*`). O worker
 * é PRÉ-SEMEADO no banco (não criado pela jornada de registro) — `POST /api/workers/init`, que o
 * login dispara, encontra o registro existente e devolve-o sem alterar nada.
 *
 * Stack próprio (`docker-compose.spec025aviso.yml`): Postgres 5541, API 8291, front 5197 — nunca
 * 8089/5439/5173 (stack fixo) nem 5540/8290 (spec025 de T6.4, edição pelo admin).
 *
 * ⚠️ Nenhum valor de data de nascimento REAL — todas sintéticas: "25/31/985" (inválida de
 * propósito), "1958-06-12" (a válida do cenário 2), "15/05/1990" (a que o worker digita no
 * cenário 1).
 */

import { execFileSync } from 'child_process';
import { test, expect, type Page } from '@playwright/test';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

const DB_URL = process.env.SPEC025AVISO_TEST_DB_URL
  ?? 'postgresql://enlite_admin:enlite_password@localhost:5541/enlite_e2e';

const WARNING_TEXT_ES = 'Tu fecha de nacimiento no es válida. Cargala de nuevo.';

// ── SQL helpers — psql direto em 5541 (stack próprio da spec 025, task T5.6) ────────────────

function psql(sql: string): string {
  try {
    return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err: any) {
    throw new Error(`DB error: ${err.stderr?.toString() ?? err.message} | sql=${sql}`);
  }
}
const scalar = (sql: string): string => psql(sql).trim().split('\n')[0] ?? '';
function safeSql(sql: string): void {
  try { psql(sql); } catch (err) { console.error(`[cleanup] falhou (seguindo): ${(err as Error).message}`); }
}

/** `KMSEncryptionService` em modo teste (USE_KMS_ENCRYPTION=false) só decodifica base64. */
function enc(v: string): string {
  return `'${Buffer.from(v, 'utf8').toString('base64')}'`;
}

interface SeedWorkerOpts {
  status: 'REGISTERED' | 'INCOMPLETE_REGISTER';
  /** `null` → `birth_date_encrypted IS NULL` (nunca cadastrou). */
  birthDateRaw: string | null;
}

interface SeedWorkerResult {
  workerId: string;
  authUid: string;
  email: string;
}

/**
 * Semeia um worker completo o bastante para `fn_guard_registered_status` aceitar
 * `status='REGISTERED'` quando pedido (todos os campos + satélites que o trigger exige — ver
 * `migrations/208_update_trigger_guard_registered_status.sql`). Para `INCOMPLETE_REGISTER` o
 * trigger não se aplica, mas os mesmos campos são preenchidos por realismo, exceto
 * `birth_date_encrypted` quando `birthDateRaw === null`.
 */
function seedWorker(opts: SeedWorkerOpts): SeedWorkerResult {
  const uniq = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const authUid = `e2e-bdaviso-${uniq}`;
  const email = `${authUid}@e2e.test`;
  const phone = `+54911${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;
  const birthDateSql = opts.birthDateRaw === null ? 'NULL' : enc(opts.birthDateRaw);

  psql(`
    INSERT INTO workers (
      auth_uid, email, phone, status, country,
      profession, occupation,
      first_name_encrypted, last_name_encrypted, sex_encrypted, gender_encrypted,
      birth_date_encrypted, document_number_encrypted, document_type, languages_encrypted,
      knowledge_level, title_certificate, years_experience,
      experience_types, preferred_types, preferred_age_range,
      created_at, updated_at
    ) VALUES (
      '${authUid}', '${email}', '${phone}', '${opts.status}', 'AR',
      'AT', 'AT',
      ${enc('TestNombre')}, ${enc('TestApellido')}, ${enc('F')}, ${enc('female')},
      ${birthDateSql}, ${enc('12345678')}, 'DNI', ${enc('["es"]')},
      'SECONDARY', 'AT_CERT', '3_5',
      ARRAY['adicciones']::varchar[], ARRAY['adultos']::varchar[], ARRAY['adults']::varchar[],
      NOW(), NOW()
    )
  `);

  const workerId = scalar(`SELECT id FROM workers WHERE auth_uid = '${authUid}'`);
  if (!workerId) throw new Error(`Falha ao semear worker (auth_uid=${authUid})`);

  psql(`
    INSERT INTO worker_service_areas (worker_id, country, address_line, latitude, longitude, radius_km, created_at, updated_at)
    VALUES ('${workerId}', 'AR', 'Av. Corrientes 1234, CABA', -34.6037, -58.3816, 20, NOW(), NOW())
  `);
  psql(`
    INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone, created_at, updated_at)
    VALUES ('${workerId}', 1, '09:00', '17:00', 'America/Argentina/Buenos_Aires', NOW(), NOW())
  `);
  psql(`
    INSERT INTO worker_documents (
      worker_id, resume_cv_url, identity_document_url, identity_document_back_url,
      criminal_record_url, at_certificate_url, documents_status, created_at, updated_at
    ) VALUES (
      '${workerId}',
      'https://storage.example.com/resume.pdf',
      'https://storage.example.com/identity-front.pdf',
      'https://storage.example.com/identity-back.pdf',
      'https://storage.example.com/criminal.pdf',
      'https://storage.example.com/at_cert.pdf',
      'submitted', NOW(), NOW()
    )
  `);

  return { workerId, authUid, email };
}

function cleanupWorker(workerId: string): void {
  safeSql(`DELETE FROM worker_documents WHERE worker_id='${workerId}'`);
  safeSql(`DELETE FROM worker_availability WHERE worker_id='${workerId}'`);
  safeSql(`DELETE FROM worker_service_areas WHERE worker_id='${workerId}'`);
  safeSql(`DELETE FROM workers WHERE id='${workerId}'`);
}

// ── Fluxo de login + navegação (mesmo padrão de worker-profile-fields-persist) ───────────────

async function loginAndOpenGeneralInfo(page: Page, w: SeedWorkerResult): Promise<void> {
  await loginNewWorker(page, w.authUid, w.email);
  await page.goto('/worker/profile?tab=general', { waitUntil: 'networkidle', timeout: 30_000 });
}

// ── Testes ────────────────────────────────────────────────────────────────────────────────

test.describe('@integration Worker profile — aviso de data de nascimento inválida (spec 025, T5.6)', () => {
  test.setTimeout(90_000);
  const seeded: SeedWorkerResult[] = [];

  test.afterAll(() => {
    for (const w of seeded) cleanupWorker(w.workerId);
  });

  test('REGISTERED com data inválida: aviso aparece, campo vazio, digita e salva → aviso some e o valor lido é o digitado', async ({ page }) => {
    const w = seedWorker({ status: 'REGISTERED', birthDateRaw: '25/31/985' });
    seeded.push(w);

    await loginAndOpenGeneralInfo(page, w);

    // 1) Aviso visível, em es-AR.
    await expect(page.getByText(WARNING_TEXT_ES)).toBeVisible({ timeout: 20_000 });

    // 2) O campo NUNCA mostra o valor inválido — vem vazio, não o lixo salvo.
    const birthDate = page.locator('#birthDate');
    await expect(birthDate).toHaveValue('');

    // 3) Corrige: clique real (prova de foco) + teclado (não fill() — o campo é texto mascarado,
    //    não input[type=date] segmentado, então digitar em sequência é seguro aqui).
    await birthDate.click();
    await expect(birthDate).toBeFocused();
    await page.keyboard.type('15051990');
    await expect(birthDate).toHaveValue('15/05/1990');

    // 4) Sai do campo → autosave dispara o PUT. Espera a resposta real do backend antes de
    //    recarregar (sem isso o reload poderia correr uma corrida com o autosave debounced).
    const [putResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/workers/me/general-info') && r.request().method() === 'PUT'),
      page.locator('#lastName').click(), // blur do birthDate, foco em outro campo do mesmo form
    ]);
    expect(putResponse.status()).toBe(200);

    // 5) Recarrega — a prova de que o servidor gravou e o veredito virou 'ok', não o estado local.
    await page.reload({ waitUntil: 'networkidle' });

    await expect(page.getByText(WARNING_TEXT_ES)).not.toBeVisible();
    await expect(page.locator('#birthDate')).toHaveValue('15/05/1990', { timeout: 20_000 });
  });

  test('REGISTERED com data válida: não vê o aviso', async ({ page }) => {
    const w = seedWorker({ status: 'REGISTERED', birthDateRaw: '1958-06-12' });
    seeded.push(w);

    await loginAndOpenGeneralInfo(page, w);

    await expect(page.locator('#birthDate')).toHaveValue('12/06/1958', { timeout: 20_000 });
    await expect(page.getByText(WARNING_TEXT_ES)).not.toBeVisible();
  });

  test('INCOMPLETE_REGISTER sem data cadastrada: campo vazio, mas SEM o aviso de inválida', async ({ page }) => {
    const w = seedWorker({ status: 'INCOMPLETE_REGISTER', birthDateRaw: null });
    seeded.push(w);

    await loginAndOpenGeneralInfo(page, w);

    // Dá tempo do hydrate rodar (mesma janela usada pela regressão "campos somem").
    await page.waitForTimeout(500);

    await expect(page.locator('#birthDate')).toHaveValue('');
    await expect(page.getByText(WARNING_TEXT_ES)).not.toBeVisible();
  });
});
