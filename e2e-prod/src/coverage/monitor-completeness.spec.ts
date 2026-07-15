/**
 * monitor-completeness.spec.ts — GUARD de completude do monitor diário.
 *
 * Garante, de forma estrutural, que TODO teste da suíte é executado pelo Cloud Run Job
 * diário (e, por consequência, entra no email — o reporter lista toda a run). Sem este
 * guard, é fácil regredir: alguém cherry-picka um `COPY smoke/` ou filtra `--project=smoke`
 * no Dockerfile e, silenciosamente, jornadas novas param de rodar no schedule (foi o que
 * aconteceu: o email mandava só 52 = smoke+coverage, sem as 4 jornadas + 25 admin).
 *
 * Invariantes exigidas do Dockerfile do runner:
 *   1. Copia a suíte INTEIRA (`COPY . .`), não dirs cherry-picked → todo spec novo entra
 *      na imagem sozinho.
 *   2. O CMD roda `playwright test` SEM filtro `--project` → todo projeto do config roda,
 *      logo todo teste novo em qualquer projeto roda sozinho.
 *
 * Roda no projeto `coverage-gate` (sempre presente no run diário). Se alguém quebrar a
 * automação, o PRÓPRIO monitor fica vermelho — o alarme é o mesmo do resto da suíte.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/coverage → ../../ = raiz do e2e-prod (onde vive o Dockerfile).
const E2E_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Linhas úteis do Dockerfile (sem comentários nem vazias). */
function dockerfileLines(): string[] {
  return readFileSync(join(E2E_ROOT, 'Dockerfile'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

test('o runner diário copia a suíte inteira e roda TODOS os projetos (teste novo entra sozinho)', () => {
  const lines = dockerfileLines();

  // Invariante 1: COPY . . (suíte inteira). Cherry-pick de dir (ex.: `COPY smoke/`) reprova.
  const hasWholeSuiteCopy = lines.some((l) => /^COPY\s+\.\s+\.\s*$/.test(l));
  expect(
    hasWholeSuiteCopy,
    'Dockerfile deve usar `COPY . .` (suíte inteira) — cherry-pick de dir faz spec novo NÃO entrar na imagem',
  ).toBe(true);

  // Invariante 2: o CMD roda playwright test SEM filtro --project (roda todos os projetos).
  const cmdLine = lines.find((l) => l.startsWith('CMD') && l.includes('playwright'));
  expect(cmdLine, 'Dockerfile deve ter um CMD que roda `playwright test`').toBeTruthy();
  expect(
    cmdLine!.includes('--project'),
    'CMD do runner NÃO pode filtrar --project — com filtro, teste novo em projeto não-listado some do schedule/email',
  ).toBe(false);
});
