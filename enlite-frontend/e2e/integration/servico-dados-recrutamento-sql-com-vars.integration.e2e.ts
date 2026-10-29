/**
 * servico-dados-recrutamento-sql-com-vars.integration.e2e.ts @integration — spec 058 B (regra 10).
 * Controle do helper `sqlComVars`: valor com aspa simples vira DADO, nunca SQL. O nome contém
 * `servico-dados-recrutamento`, token que o `grep:` do `pr-gate.yml` já roda no projeto `integration`.
 */
import { test, expect } from '@playwright/test';
import { sqlComVars } from '../helpers/sql-com-vars';

test('sqlComVars: valor com aspa simples passa intacto e não quebra o SQL (controle da regra 10)', () => {
  const nome = "o'brien";
  expect(sqlComVars(`SELECT :'v'`, { v: nome })).toBe(nome);
  const hostil = "x'; SELECT 1; --";
  expect(sqlComVars(`SELECT :'v'`, { v: hostil })).toBe(hostil); // vira dado, não SQL
  expect(sqlComVars(`SELECT 1`)).toBe('1'); // sem vars também funciona
});
