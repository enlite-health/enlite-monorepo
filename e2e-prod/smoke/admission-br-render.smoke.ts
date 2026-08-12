/**
 * Render do form público de admissão do BRASIL (/admission-br). Read-only.
 *
 * Este spec nasceu de um gap que o gate de cobertura denunciou: o App de
 * Pacientes subiu com duas páginas públicas (AR e BR) e o monitor só exercitava
 * a AR. O histórico do projeto registra "BR só render verificado" — ou seja,
 * ninguém nunca provou que a página BR continua de pé depois de um deploy.
 *
 * Aqui a gente prova o mínimo honesto, sem criar lead: a página carrega, o form
 * existe, os campos estão lá e o envio nasce bloqueado até o consentimento. A
 * jornada de escrita completa segue só em AR (uma por dia basta; duas dobrariam
 * o resíduo em produção sem dobrar a informação).
 */
import { test, expect } from '@playwright/test';

test('[@route:/admission-br @depth:smoke] form público BR renderiza e nasce bloqueado', async ({ page }) => {
  await page.goto('/admission-br');

  await expect(page.getByTestId('lead-form')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('lead-serviceType')).toBeVisible();
  await expect(page.getByTestId('lead-email')).toBeVisible();
  await expect(page.getByTestId('lead-phone')).toBeVisible();
  await expect(page.getByTestId('lead-consent')).toBeVisible();

  // Mesmo guard da AR: sem consentimento, não dá para enviar.
  await expect(page.getByTestId('lead-submit')).toBeDisabled();

  // O país vem no atributo `data-country` do <main> (não em texto) — se a rota BR
  // renderizar a config AR, o lead nasce no país errado e cai na agenda errada.
  await expect(page.getByTestId('admission-country')).toHaveAttribute('data-country', 'BR');

  // E a página fala português: BR servindo es-AR seria regressão de i18n silenciosa.
  await expect(page.getByTestId('lead-form')).toContainText(/telefone/i);
});

test('[@route:/admission-br @depth:smoke] a agenda BR responde para o país certo', async ({ request }) => {
  const res = await request.get(`${process.env.PROD_API_URL}/api/public/v1/admission/slots?country=BR`);
  expect(res.status()).toBe(200);

  const body = (await res.json()) as { slots?: unknown[] };
  test.info().annotations.push({
    type: 'evidência',
    description: `horários livres na agenda BR: ${body.slots?.length ?? 0}`,
  });
  // Zero horário livre é possível (agenda cheia/feriado) — o que não pode é o
  // endpoint quebrar. A forma da resposta é o gate.
  expect(Array.isArray(body.slots)).toBe(true);
});
