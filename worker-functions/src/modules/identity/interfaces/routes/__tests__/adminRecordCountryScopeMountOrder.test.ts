/**
 * Ordem de montagem do guard global de escopo de pais (hotfix 18/11/2026; bloqueio do gate no #893).
 *
 * O guard so protege o que vem DEPOIS dele na pilha do Express. `createWorkerDocumentsRoutes` era montado em `/api` ANTES
 * dele e servia `/api/admin/workers/:id/additional-documents` sem checar pais. Regra travada aqui: no `src/index.ts`, o guard
 * e o PRIMEIRO mount de rota (nenhum `app.use|get|post|...('/...')` nem `create*Routes(` antes dele) e vem depois do
 * `dbSessionMiddleware`. Escolha deliberada: teste ESTATICO sobre o texto de index.ts (o app real sobe servidor, pool e
 * Firebase; inspecionar a pilha em runtime exigiria bootar tudo). Cobre qualquer router novo — com path em template ou em
 * varias linhas — sem depender de eu lembrar de adicionar o caminho dele a uma lista.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '../../../../../index.ts'), 'utf8');
const GUARD = /app\.use\(\s*['"`]\/api\/admin['"`]\s*,\s*createAdminRecordCountryScopeRoutes\(/g;
const guardAt = (): number => {
  const hits = [...src.matchAll(GUARD)];
  expect(hits).toHaveLength(1); // montado uma vez so
  return hits[0].index as number;
};
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('guard global de escopo de pais — ordem de montagem em index.ts', () => {
  it('vem depois do dbSessionMiddleware', () => {
    const db = src.indexOf('app.use(dbSessionMiddleware)');
    expect(db).toBeGreaterThan(-1);
    expect(guardAt()).toBeGreaterThan(db);
  });

  it('e o PRIMEIRO mount de rota: nada de app.<verbo>("/...") nem create*Routes( antes dele', () => {
    const antes = stripComments(src.slice(0, guardAt()));
    const montagens = antes.match(/app\.(use|get|post|put|patch|delete|all)\(\s*['"`]\/[^'"`]*['"`]/g) ?? [];
    const routers = antes.match(/\bcreate\w*Routes?\(|\bcreate\w*Router\(/g) ?? [];
    expect({ montagens, routers }).toEqual({ montagens: [], routers: [] });
  });
});
