import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CellMatrix, cellDiff, cellKey } from '..';
import type { CatalogCategory } from '@infrastructure/http/AdminPermissionsApiService';

vi.mock('react-i18next', () => ({
  // `t(chave, fallback)` — o 2º argumento é o valor CRU quando não há tradução,
  // e o componente depende disso para categoria e recurso desconhecidos.
  useTranslation: () => ({
    t: (k: string, o?: unknown) => (typeof o === 'string' ? `[${o}]` : k),
  }),
}));

const celula = (resource: string, action: string, description?: string | null) => ({
  resource, action, category: 'Trabalhadores', ownerService: 'wf',
  ...(description === undefined ? {} : { description }),
});

const CATALOGO: CatalogCategory[] = [
  {
    category: 'Trabalhadores',
    cells: [
      celula('worker', 'read', 'Ver el prestador en operación.'),
      celula('worker', 'write'),
      celula('worker', 'delete'),
      celula('worker', 'export'),
      celula('worker', 'disable'),
      celula('worker_pii', 'read', 'Ver el dossier: DNI, domicilio, datos sensibles.'),
    ],
  },
  {
    category: 'Vagas e Funil',
    cells: [celula('vacancy', 'read'), celula('vacancy', 'write')],
  },
];

const montar = (over: Partial<Parameters<typeof CellMatrix>[0]> = {}) => {
  const onToggle = vi.fn();
  const utils = render(
    <CellMatrix
      catalog={CATALOGO}
      selected={new Set(['worker:read'])}
      saved={['worker:read']}
      editable
      onToggle={onToggle}
      {...over}
    />,
  );
  return { onToggle, ...utils };
};

const linhaDe = (recurso: string): HTMLElement =>
  screen.getByRole('row', { name: new RegExp(recurso) });

describe('CellMatrix — a matriz que o domínio já descrevia', () => {
  it('uma LINHA por recurso, não uma caixa por célula', () => {
    montar();
    // 6 células de worker/worker_pii viram 2 linhas; 2 de vacancy viram 1
    expect(screen.getAllByRole('row').filter((r) => within(r).queryAllByRole('checkbox').length > 0)).toHaveLength(3);
  });

  it('a coluna que o recurso NÃO tem vira um travessão — não uma caixa desmarcada', () => {
    montar();
    const vacancy = linhaDe('vacancy');
    // vacancy tem read e write; delete/export/other não existem
    expect(within(vacancy).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(vacancy).getAllByRole('cell', { name: 'admin.access.group.cells.na' })).toHaveLength(3);
  });

  it('só nascem as colunas que ALGUÉM usa', () => {
    montar({ catalog: [{ category: 'X', cells: [celula('a', 'read')] }] });
    expect(screen.getByText('admin.access.group.cells.action.read')).toBeInTheDocument();
    expect(screen.queryByText('admin.access.group.cells.action.delete')).not.toBeInTheDocument();
  });

  it('ação rara cai na coluna "outras" em vez de abrir coluna própria', () => {
    montar();
    // `disable` não tem coluna own — entra em `other`
    expect(screen.getByText('admin.access.group.cells.action.other')).toBeInTheDocument();
    expect(within(linhaDe('worker\\b')).getByRole('checkbox', { name: /^worker:disable/ })).toBeInTheDocument();
  });

  it('🔑 a descrição do backend vira o rótulo — a chave crua deixa de ser tudo', () => {
    montar();
    expect(screen.getByRole('checkbox', { name: 'worker_pii:read — Ver el dossier: DNI, domicilio, datos sensibles.' }))
      .toBeInTheDocument();
  });

  it('célula sem descrição cai na própria chave, sem quebrar', () => {
    montar();
    expect(screen.getByRole('checkbox', { name: 'worker:write — worker:write' })).toBeInTheDocument();
  });

  it('categoria e recurso sem tradução mostram o valor CRU em vez de sumir', () => {
    montar({ catalog: [{ category: 'Inventada', cells: [celula('coisa_nova', 'read')] }] });
    expect(screen.getByText('[Inventada]')).toBeInTheDocument();
    expect(screen.getByText('[coisa_nova]')).toBeInTheDocument();
  });

  it('marcar e desmarcar devolve a chave ao chamador', async () => {
    const { onToggle } = montar();
    await userEvent.click(screen.getByRole('checkbox', { name: /^worker:write/ }));
    expect(onToggle).toHaveBeenCalledWith('worker:write');
  });

  it('read: sem checkbox — ✓ para o que o grupo dá, · para o que não dá', () => {
    montar({ editable: false });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^worker:read/)).toHaveTextContent('✓');
    expect(screen.getByLabelText(/^worker:write/)).toHaveTextContent('·');
  });

  it('grupo sem nenhuma célula DIZ isso — numa matriz de ·, mudo seria ambíguo', () => {
    montar({ selected: new Set(), saved: [] });
    expect(screen.getByText('admin.access.group.noCells')).toBeInTheDocument();
  });

  it('catálogo vazio não desenha matriz — avisa que o sync não rodou', () => {
    montar({ catalog: [] });
    expect(screen.queryByTestId('cell-matrix')).not.toBeInTheDocument();
    expect(screen.getByText('admin.access.group.cells.empty')).toBeInTheDocument();
  });

  it('o que mudou e ainda não foi salvo é anunciado a quem não vê a cor', () => {
    montar({ selected: new Set(['worker:write']), saved: ['worker:read'] });
    // worker:read saiu e worker:write entrou = 2 anúncios
    expect(screen.getAllByText('admin.access.group.cells.changed')).toHaveLength(2);
  });
});

describe('cellDiff — o que o rodapé promete antes de salvar', () => {
  it('conta o que entra e o que sai, ordenado', () => {
    const d = cellDiff(['b:read', 'a:read'], new Set(['a:read', 'c:read', 'd:read']));
    expect(d.added).toEqual(['c:read', 'd:read']);
    expect(d.removed).toEqual(['b:read']);
    expect(d.dirty).toBe(true);
  });

  it('conjunto igual não é mudança — o botão de salvar não deve acender', () => {
    const d = cellDiff(['a:read', 'b:read'], new Set(['b:read', 'a:read']));
    expect(d).toEqual({ added: [], removed: [], dirty: false });
  });

  it('esvaziar o grupo conta como remoção, não como "sem mudança"', () => {
    const d = cellDiff(['a:read'], new Set());
    expect(d.removed).toEqual(['a:read']);
    expect(d.dirty).toBe(true);
  });
});

describe('cellKey', () => {
  it('monta a chave canônica que o banco devolve', () => {
    expect(cellKey({ resource: 'worker', action: 'read' })).toBe('worker:read');
  });
});
