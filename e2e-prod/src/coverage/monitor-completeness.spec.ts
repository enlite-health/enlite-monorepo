/**
 * monitor-completeness.spec.ts — GUARD de completude da IMAGEM do runner (não do schedule).
 *
 * Garante, de forma estrutural, que TODO spec da suíte ENTRA na imagem (`COPY . .`) e que o
 * CMD da imagem não filtra `--project` — ou seja, que nada impede um teste novo de rodar
 * quando o Job é disparado sem overrides (disparo manual, ou um Scheduler que não filtre).
 * Sem este guard, é fácil regredir: alguém cherry-picka um `COPY smoke/` ou crava
 * `--project=smoke` DENTRO do CMD do Dockerfile, e aí NENHUM schedule — nem o manual —
 * conseguiria rodar a suíte inteira (foi o que aconteceu: o email mandava só 52 =
 * smoke+coverage, sem as 4 jornadas + 25 admin).
 *
 * ⚠️ O que este guard NÃO garante mais: que TODO teste roda DIARIAMENTE. Desde a divisão
 * diário/semanal (commit c22a00bf), o Cloud Scheduler `e2e-prod-smoke-daily` sobrescreve os
 * `args` do container via `overrides.containerOverrides[]` pra rodar só smoke+admin+
 * coverage-gate+unit; `regression` passou a ter agendamento PRÓPRIO semanal
 * (`e2e-prod-regression-weekly`, domingo 4h AR) — ambos em `scripts/deploy-monitor.sh`. Esse
 * filtro vive no CORPO do Scheduler (fora do Dockerfile), então este guard não o enxerga: um
 * projeto novo pode ficar de fora dos DOIS agendamentos (nem diário, nem semanal) sem que
 * este teste acuse nada. Fechar essa lacuna — cruzar `deploy-monitor.sh` × `playwright.
 * config.ts` — é conserto separado, fora do escopo deste guard hoje.
 *
 * Invariantes exigidas do Dockerfile do runner:
 *   1. Copia a suíte INTEIRA (`COPY . .`), não dirs cherry-picked → todo spec novo entra
 *      na imagem sozinho.
 *   2. O CMD roda `playwright test` SEM filtro `--project` → o disparo manual (e qualquer
 *      Scheduler que não sobrescreva `args`) roda todos os projetos do config.
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
