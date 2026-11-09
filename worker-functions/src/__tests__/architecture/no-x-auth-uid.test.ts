/**
 * T207(b) (change acesso-do-cliente-areas-e-login-unico, D650 / F21).
 * A identidade das rotas da própria conta vem SÓ do token (`selfUid(req)` → `req.user.uid`).
 * Nenhum código de produção em `src` pode citar o header `x-auth-uid`; teste novo ou fixture fica fora do alvo
 * (qualquer `__tests__`, `*.test.ts`).
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');

function listar(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : listar(p);
    return /\.(ts|tsx|js)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

describe('arquitetura: o servidor não lê x-auth-uid (D650)', () => {
  const arquivos = listar(SRC);

  it('varre arquivos de produção (controle: contagem > 0)', () => {
    expect(arquivos.length).toBeGreaterThan(100);
  });

  it('nenhum arquivo de produção em src cita x-auth-uid', () => {
    const achados = arquivos.filter((f) => /x-auth-uid/i.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(achados).toEqual([]);
  });
});
