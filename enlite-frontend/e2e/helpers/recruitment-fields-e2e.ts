/**
 * Spec 027 Fase 3 (D508 c): o portão "ativar recrutamento" exige 5 campos no serviço contratado
 * (profissões, sexo, experiência, jornada, dia de pagamento ao prestador). Os specs que ATIVAM um serviço
 * precisam semeá-los. Valores sintéticos, sem texto clínico.
 *
 * - `RECRUITMENT_FIELDS_E2E`: corpo de `POST/PATCH .../contracted-services` (API).
 * - `RECRUITMENT_SQL_COLUMNS` / `RECRUITMENT_SQL_VALUES`: para `INSERT INTO patient_contracted_services` direto no banco.
 * - `preencherRecrutamentoPelaTela`: o mesmo, pelo formulário do serviço (click + teclado reais).
 */
import type { Page } from '@playwright/test';

export const RECRUITMENT_FIELDS_E2E = {
  requiredProfessions: ['AT'],
  requiredSex: 'BOTH',
  requiredExperience: 'experiencia e2e',
  workSchedule: 'part-time',
  paymentDay: 'dia 5',
} as const;

export const RECRUITMENT_SQL_COLUMNS = 'required_professions, required_sex, required_experience, work_schedule, payment_day';
export const RECRUITMENT_SQL_VALUES = `ARRAY['AT'], 'BOTH', 'experiencia e2e', 'part-time', 'dia 5'`;

/** Preenche os 5 campos que o portão exige, pelo formulário aberto do serviço `index` (gesto humano). */
export async function preencherRecrutamentoPelaTela(page: Page, index: number): Promise<void> {
  await page.getByTestId(`svc-profession-AT-${index}`).click({ force: true });
  await page.getByTestId(`svc-requiredSex-${index}`).selectOption('BOTH', { force: true });
  await page.getByTestId(`svc-workSchedule-${index}`).selectOption('part-time', { force: true });
  for (const [id, texto] of [[`svc-requiredExperience-${index}`, 'experiencia e2e'], [`svc-paymentDay-${index}`, 'dia 5']] as const) {
    await page.getByTestId(id).click({ force: true });
    await page.keyboard.type(texto);
  }
}
