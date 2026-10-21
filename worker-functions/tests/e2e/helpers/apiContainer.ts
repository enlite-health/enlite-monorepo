import { execSync } from 'child_process';

/**
 * Resolve o container da API para `docker logs`. Sem nome fixo: o nome do container muda com o
 * projeto do compose (CI sobe sem `-p`; a stack local pode usar override).
 *
 * Ordem: `E2E_API_CONTAINER` (override explícito) → rótulo do compose `service=api`.
 * Se nada for achado, LANÇA — estes testes provam "nenhuma chamada saiu para o modelo" lendo o
 * log; sem o log não há prova, e isso tem de falhar alto (nunca skip, nunca passar em silêncio).
 */
export function resolveApiContainer(): string {
  const override = process.env.E2E_API_CONTAINER?.trim();
  if (override) return override;

  let names: string[] = [];
  try {
    names = execSync(
      `docker ps --filter "label=com.docker.compose.service=api" --format '{{.Names}}'`,
    )
      .toString()
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean);
  } catch (err) {
    throw new Error(
      `Não consegui listar containers (docker ps falhou): ${(err as Error).message}. ` +
        `Sem o log do container da API estes testes não provam nada. Defina E2E_API_CONTAINER.`,
    );
  }
  if (names.length === 0) {
    throw new Error(
      'Não achei o container da API (nenhum container com label com.docker.compose.service=api ' +
        'rodando). Sem o log dele estes testes não provam nada. Suba a stack ou defina E2E_API_CONTAINER.',
    );
  }
  return names[0];
}

export function apiContainerLogs(): string {
  return execSync(`docker logs ${resolveApiContainer()}`, { maxBuffer: 1024 * 1024 * 80 }).toString();
}
