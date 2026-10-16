/**
 * spec 050 F27 (R-53, A27-4): toda troca de token do Tactiq passa pelo `TactiqLinkService` (a única porta, dentro da trava por responsável).
 * Varre o código de produção: `oauth.refresh` e `accessTokenFor` fora dele = 0, com o controle de que dentro dele há a troca e ≥ 2 pontos de trava.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const SRC = resolve(__dirname, '../../../..');
const PADRAO = /oauth\.refresh|accessTokenFor/;

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : arquivos(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}
const ocorrencias = (p: string): number => readFileSync(p, 'utf8').split('\n').filter((l) => PADRAO.test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//')).length;

describe('F27 A27-4 — o TactiqLinkService é a única porta para um token do Tactiq', () => {
  const todos = arquivos(SRC);
  const servico = todos.find((p) => p.endsWith('/matching/application/TactiqLinkService.ts')) as string;

  it('CONTROLE POSITIVO: dentro do serviço há a troca única (a varredura enxerga o padrão) e ≥ 2 pontos de trava', () => {
    expect(todos.length).toBeGreaterThan(100);
    expect(ocorrencias(servico)).toBeGreaterThanOrEqual(1);
    expect(readFileSync(servico, 'utf8').match(/withSessionAdvisoryLock\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('fora do serviço: 0 usos de `oauth.refresh` e de `accessTokenFor` em código de produção', () => {
    const fora = todos.filter((p) => p !== servico && ocorrencias(p) > 0);
    expect(fora).toEqual([]);
  });
});
