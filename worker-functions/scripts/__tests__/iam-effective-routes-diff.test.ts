import { diffFotos, rotasPermitidasPorGrupo, type FotoRotas } from '../iam-effective-routes-diff';

describe('rotasPermitidasPorGrupo', () => {
  const rotas = [
    { method: 'POST', path: '/api/admin/patients/:id/responsibles', cell: 'patient_family:write', status: 'declared' },
    { method: 'PATCH', path: '/api/admin/patients/:id/responsibles/:rid', cell: 'patient_family:write', status: 'declared' },
    { method: 'DELETE', path: '/api/admin/users/:id', cell: 'user_management:delete', status: 'declared' },
    { method: 'GET', path: '/api/admin/patients', cell: null, status: 'declared' },
    { method: 'POST', path: '/api/admin/segredo', cell: 'top_secret:write', status: 'undeclared' },
  ];

  it('grupo com a célula vê as rotas que ela governa, ordenadas por "METHOD path"', () => {
    const out = rotasPermitidasPorGrupo(rotas, [{ name: 'Recrutador', cells: new Set(['patient_family:write']) }]);
    expect(out.Recrutador).toEqual([
      'PATCH /api/admin/patients/:id/responsibles/:rid',
      'POST /api/admin/patients/:id/responsibles',
    ]);
  });

  it('grupo sem nenhuma célula em comum devolve lista vazia (nunca omite a chave)', () => {
    const out = rotasPermitidasPorGrupo(rotas, [{ name: 'Vazio', cells: new Set() }]);
    expect(out.Vazio).toEqual([]);
  });

  it('rota sem célula (cell=null) nunca entra — não é rota governada por nenhum grupo', () => {
    const out = rotasPermitidasPorGrupo(rotas, [{ name: 'G', cells: new Set(['patient_family:write', 'user_management:delete']) }]);
    expect(out.G.every((r) => !r.includes('/api/admin/patients "'))).toBe(true);
    expect(out.G).not.toContain('GET /api/admin/patients');
  });

  it('rota UNDECLARED nunca conta como permitida, mesmo se o grupo tivesse a célula por coincidência', () => {
    const out = rotasPermitidasPorGrupo(rotas, [{ name: 'G', cells: new Set(['top_secret:write']) }]);
    expect(out.G).toEqual([]);
  });

  it('vários grupos independentes — o filtro de um não vaza para o outro', () => {
    const out = rotasPermitidasPorGrupo(rotas, [
      { name: 'A', cells: new Set(['patient_family:write']) },
      { name: 'B', cells: new Set(['user_management:delete']) },
    ]);
    expect(out.A).toHaveLength(2);
    expect(out.B).toEqual(['DELETE /api/admin/users/:id']);
  });
});

describe('diffFotos', () => {
  const foto = (rotasPorGrupo: Record<string, string[]>, totalGrupos = Object.keys(rotasPorGrupo).length): FotoRotas => ({
    geradoEm: '2026-09-15T00:00:00.000Z',
    totalGrupos,
    totalRotasGovernadas: 0,
    rotasPorGrupo,
  });

  it('0 diferenças quando as duas fotos batem exatamente (o caso esperado nesta rodada A1)', () => {
    const a = foto({ Recrutador: ['POST /x'], 'Acesso Master': ['POST /x', 'DELETE /y'] });
    const b = foto({ Recrutador: ['POST /x'], 'Acesso Master': ['POST /x', 'DELETE /y'] });
    expect(diffFotos(a, b)).toEqual([]);
  });

  it('rota GANHA aparece em `added` — é a sabotagem que a task pede para detectar (V3, alias removido)', () => {
    const a = foto({ Recrutador: ['POST /x'] });
    const b = foto({ Recrutador: ['POST /x', 'PATCH /x/:id'] });
    expect(diffFotos(a, b)).toEqual([{ group: 'Recrutador', added: ['PATCH /x/:id'], removed: [] }]);
  });

  it('rota PERDIDA aparece em `removed` — ninguém pode perder acesso nesta rodada', () => {
    const a = foto({ Recrutador: ['POST /x', 'PATCH /x/:id'] });
    const b = foto({ Recrutador: ['POST /x'] });
    expect(diffFotos(a, b)).toEqual([{ group: 'Recrutador', added: [], removed: ['PATCH /x/:id'] }]);
  });

  it('grupo que só existe numa das fotos conta como diferença total (criado ou apagado entre as duas)', () => {
    const a = foto({ Recrutador: ['POST /x'] });
    const b = foto({ Recrutador: ['POST /x'], Financeiro: ['GET /y'] });
    expect(diffFotos(a, b)).toEqual([{ group: 'Financeiro', added: ['GET /y'], removed: [] }]);
  });

  it('diffs vêm ordenados por nome do grupo, e cada lista interna ordenada', () => {
    const a = foto({});
    const b = foto({ Zeta: ['GET /z'], Alfa: ['GET /b', 'GET /a'] });
    expect(diffFotos(a, b).map((d) => d.group)).toEqual(['Alfa', 'Zeta']);
    expect(diffFotos(a, b)[0].added).toEqual(['GET /a', 'GET /b']);
  });
});
