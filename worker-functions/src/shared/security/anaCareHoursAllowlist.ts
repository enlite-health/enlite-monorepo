/**
 * src/shared/security/anaCareHoursAllowlist.ts
 *
 * Porte PRD da "Conferência de horas do Ana Care" (feature `feat/anacare-horas-prd-allowlist`):
 * no `main` não existe engine ABAC (célula `anacare_hours:read`/`:validate` só existe na `stage`).
 * Gate de acesso aqui é allowlist ESTÁTICA de e-mail corporativo, via env var
 * `ANACARE_HOURS_ALLOWED_EMAILS` (separador `;`), decidida pelo Gabriel — sem prazo de morte, sem
 * dono documentado, sem trilha de auditoria de leitura (fora do escopo desta fase, ver decisões do
 * porte).
 *
 * Helper PURO e compartilhado entre:
 *   - `modules/anacare-hours/interfaces/middleware/requireAnaCareHoursAllowlist.ts` (gate das 5 rotas)
 *   - `modules/identity/application/GetAdminProfileUseCase.ts` (flag `canAccessAnaCareHours` no perfil)
 * Fica em `shared/` (não dentro de `anacare-hours/`) para não criar dependência de `identity` →
 * `anacare-hours` (identity é a camada mais de baixo nível; a ordem inversa já existe:
 * `anacare-hours` depende de `identity` para auth).
 */

const ANACARE_HOURS_ALLOWED_EMAILS_ENV = 'ANACARE_HOURS_ALLOWED_EMAILS';

function parseAllowedEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env[ANACARE_HOURS_ALLOWED_EMAILS_ENV];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(';')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

/**
 * Normaliza (trim + lowercase) e compara contra a allowlist. `email` ausente/vazio nunca passa,
 * mesmo com a env vazia ou ausente (fail-closed).
 */
export function isAnaCareHoursAllowedEmail(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  return parseAllowedEmails(env).has(normalized);
}

export { ANACARE_HOURS_ALLOWED_EMAILS_ENV };
