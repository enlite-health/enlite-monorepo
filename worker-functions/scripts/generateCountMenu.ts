/**
 * generateCountMenu.ts — gera src/contracts/assistants/count-menu.json a partir do módulo dono
 * do cardápio (`assistantCountMenu.ts`, change 085, DD5). JSON estável: chaves ordenadas, 2 espaços,
 * newline final. Sem rede, sem banco.
 *
 * Uso (de worker-functions/):
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/generateCountMenu.ts
 */
import fs from 'fs';
import path from 'path';
import { COUNT_MENU } from '../src/modules/agentes/domain/assistantCountMenu';

export const COUNT_MENU_PATH = path.resolve(__dirname, '../src/contracts/assistants/count-menu.json');

function ordenar(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(ordenar);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, ordenar((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function gerarCountMenu(): string {
  return JSON.stringify(ordenar(COUNT_MENU), null, 2) + '\n';
}

if (require.main === module) {
  fs.writeFileSync(COUNT_MENU_PATH, gerarCountMenu());
  console.log(`count-menu.json escrito: ${Object.keys(COUNT_MENU).length} entidades`);
}
