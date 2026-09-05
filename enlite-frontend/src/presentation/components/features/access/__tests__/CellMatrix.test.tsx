import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CellMatrix, cellDiff, cellKey } from '..';
import { montaBloco } from '../cellMatrixModel';
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

/** O recorte que o Gabriel desenhou: Trabajadores + Vacantes y embudo. */
const CATALOGO: CatalogCategory[] = [
  {
    category: 'Trabalhadores',
    cells: [
      celula('worker', 'read', 'Ver el prestador en operación.'),
      celula('worker', 'write'),
      celula('worker', 'delete'),
      celula('worker', 'export'),
      celula('worker_contact', 'read', 'Ver el contacto: nombre y teléfono.'),
      celula('worker_pii', 'read', 'Ver el dossier: DNI, domicilio, datos sensibles.'),
      celula('worker_document', 'read'),
      celula('worker_document', 'write'),
      celula('worker_document', 'delete'),
      celula('worker_document', 'validate'),
    ],
  },
  {
    category: 'Vagas e Funil',
    cells: [
      celula('vacancy', 'read'), celula('vacancy', 'write'), celula('vacancy', 'delete'),
      celula('funnel', 'read'), celula('funnel', 'write'),
    ],
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

const bloco = (nome: string): HTMLElement => screen.getByRole('region', { name: nome });
const colunasDo = (nome: string): (string | null)[] =>
  within(bloco(nome)).getAllByRole('columnheader').slice(1).map((h) => h.textContent);

describe('CellMatrix — colunas por categoria, avulso fora da grade', () => {
  it('🔒 o recorte desenhado: Trabajadores rende Ver · Crear · Elim. · Expor. · Valid.', () => {
    montar();
    expect(colunasDo('[Trabalhadores]')).toEqual(['[read]', '[write]', '[delete]', '[export]', '[validate]']);
    // TODO recurso é linha, na ordem do catálogo — inclusive os de uma célula
    // só. O dossiê vem em 3º, como desenhado; alfabético o enterraria.
    const linhas = within(bloco('[Trabalhadores]')).getAllByRole('rowheader').map((h) => h.textContent);
    expect(linhas).toEqual([
      '[worker]worker', '[worker_contact]worker_contact',
      '[worker_pii]worker_pii', '[worker_document]worker_document',
    ]);
  });

  it('🔒 cada categoria tem AS SUAS colunas — Vacantes não herda Expor. nem Valid.', () => {
    montar();
    expect(colunasDo('[Vagas e Funil]')).toEqual(['[read]', '[write]', '[delete]']);
    // é o ponto da poda: com colunas globais, `funnel` teria 2 travessões a mais
    expect(within(bloco('[Vagas e Funil]')).getAllByRole('cell', { name: 'admin.access.group.cells.na' }))
      .toHaveLength(1); // só funnel:delete
  });

  it('🔒 recurso de UMA célula é LINHA, com cabeçalho em cima da caixa', () => {
    // Tirar da grade (#296) deixava a caixa sem coluna: ninguém sabia se
    // aquele checkbox era "Ver". Revertido com a tela na mão.
    montar({ catalog: [{ category: 'Analytics', cells: [celula('analytics', 'read', 'Ver relatórios.')] }] });
    // as três base aparecem mesmo sem célula: simetria entre categorias
    expect(colunasDo('[Analytics]')).toEqual(['[read]', '[write]', '[delete]']);
    expect(within(bloco('[Analytics]')).getByRole('rowheader')).toHaveTextContent('[analytics]analytics');
    expect(screen.getByRole('checkbox', { name: 'analytics:read — Ver relatórios.' })).toBeInTheDocument();
    // e as duas que ela não tem viram travessão — o preço da simetria
    expect(within(bloco('[Analytics]')).getAllByRole('cell', { name: 'admin.access.group.cells.na' })).toHaveLength(2);
  });

  it('a coluna que o recurso NÃO tem vira travessão, com nome no leitor de tela', () => {
    montar();
    // 4 recursos × 5 colunas = 20 posições; 10 células → 10 travessões
    expect(within(bloco('[Trabalhadores]')).getAllByRole('cell', { name: 'admin.access.group.cells.na' }))
      .toHaveLength(10);
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
    montar({ catalog: [{ category: 'Inventada', cells: [celula('coisa', 'read'), celula('coisa', 'write')] }] });
    expect(screen.getByRole('region', { name: '[Inventada]' })).toBeInTheDocument();
    // `getByText` não casa texto quebrado em dois <span> (nome + chave crua)
    expect(screen.getByRole('rowheader')).toHaveTextContent('[coisa]coisa');
  });

  it('ação fora da ordem canônica ganha coluna própria, no fim', () => {
    montar({ catalog: [{ category: 'X', cells: [celula('r', 'read'), celula('r', 'teleportar')] }] });
    expect(colunasDo('[X]')).toEqual(['[read]', '[write]', '[delete]', '[teleportar]']);
  });

  it('marcar devolve a chave ao chamador — na grade e no avulso', async () => {
    const { onToggle } = montar();
    await userEvent.click(screen.getByRole('checkbox', { name: /^worker:write/ }));
    expect(onToggle).toHaveBeenCalledWith('worker:write');
    await userEvent.click(screen.getByRole('checkbox', { name: /^worker_pii:read/ }));
    expect(onToggle).toHaveBeenCalledWith('worker_pii:read');
  });

  it('read: sem checkbox — ✓ para o que o grupo dá, · para o que não dá', () => {
    montar({ editable: false, selected: new Set(['worker:read', 'worker_pii:read']) });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^worker:read/)).toHaveTextContent('✓');
    expect(screen.getByLabelText(/^worker:write/)).toHaveTextContent('·');
    expect(screen.getByLabelText(/^worker_pii:read/)).toHaveTextContent('✓');
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

  it('o que mudou e não foi salvo é anunciado a quem não vê a cor — grade e avulso', () => {
    montar({ selected: new Set(['worker:write', 'worker_pii:read']), saved: ['worker:read'] });
    // worker:read saiu, worker:write entrou, worker_pii:read entrou
    expect(screen.getAllByText('admin.access.group.cells.changed')).toHaveLength(3);
  });
});

describe('montaBloco — a regra da poda', () => {
  it('todo recurso vira linha, independente de quantas ações tem', () => {
    const b = montaBloco('C', [celula('a', 'read'), celula('a', 'write'), celula('b', 'read')]);
    expect(b.grade.map((l) => l.resource)).toEqual(['a', 'b']);
  });

  it('a coluna nasce de QUALQUER célula da categoria — inclusive a de recurso só', () => {
    // `b:send` é a única `send` da categoria; ela abre a coluna "Enviar", e `a`
    // ganha um travessão ali. É o preço de a caixa ter cabeçalho.
    const b = montaBloco('C', [celula('a', 'read'), celula('a', 'write'), celula('b', 'send')]);
    expect(b.colunas).toEqual(['read', 'write', 'delete', 'send']);
  });

  it('🔒 as três base saem SEMPRE, mesmo sem célula nelas', () => {
    // Sem isto cada categoria terminava num x diferente e a página ficava
    // serrilhada no lado direito (decisão do Gabriel, 05/09).
    const b = montaBloco('C', [celula('a', 'read'), celula('b', 'read')]);
    expect(b.colunas).toEqual(['read', 'write', 'delete']);
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
    expect(cellDiff(['a:read', 'b:read'], new Set(['b:read', 'a:read'])))
      .toEqual({ added: [], removed: [], dirty: false });
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
