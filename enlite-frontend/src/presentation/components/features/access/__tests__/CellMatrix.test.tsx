import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CellMatrix, cellDiff, cellKey } from '..';
import { contaSelecionadas, montaBloco, montaBlocos } from '../cellMatrixModel';
import type { CatalogCategory } from '@infrastructure/http/AdminPermissionsApiService';

/** Rótulos "traduzidos" do teste da vez — vazio = todo rótulo é `[chave crua]`. */
let ROTULOS: Record<string, string> = {};

vi.mock('react-i18next', () => ({
  // `t(chave, fallback)` — o 2º argumento é o valor CRU quando não há tradução,
  // e o componente depende disso para categoria e recurso desconhecidos.
  useTranslation: () => ({
    t: (k: string, o?: unknown) => {
      if (typeof o !== 'string') return k;
      return ROTULOS[o] ?? `[${o}]`;
    },
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

const montar = (
  { rotulos = {}, ...over }: Partial<Parameters<typeof CellMatrix>[0]> & { rotulos?: Record<string, string> } = {},
) => {
  ROTULOS = rotulos;
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

/** Os rótulos de `es.json` para os recursos de Trabajadores — a ordem real da tela. */
const ROTULOS_ES: Record<string, string> = {
  worker: 'Prestador en operación',
  worker_contact: 'Contacto: nombre, teléfono',
  worker_document: 'Documentos',
  worker_pii: 'Dossier: DNI, domicilio, datos sensibles',
};

const bloco = (nome: string): HTMLElement => screen.getByRole('region', { name: nome });
const colunasDo = (nome: string): (string | null)[] =>
  within(bloco(nome)).getAllByRole('columnheader').slice(1).map((h) => h.textContent);

describe('CellMatrix — colunas por categoria, avulso fora da grade', () => {
  afterEach(() => { ROTULOS = {}; });

  it('🔒 o recorte desenhado: Trabajadores rende Ver · Crear · Elim. · Expor. · Valid.', () => {
    // com os rótulos REAIS de `es.json` — a ordem aqui é a que a tela mostra
    montar({ rotulos: ROTULOS_ES });
    expect(colunasDo('[Trabalhadores]')).toEqual(['[read]', '[write]', '[delete]', '[export]', '[validate]']);
    // TODO recurso é linha, inclusive os de uma célula só — e a grade sai em
    // ordem ALFABÉTICA do rótulo visível (decisão do Gabriel, 05/09).
    const linhas = within(bloco('[Trabalhadores]')).getAllByRole('rowheader').map((h) => h.textContent);
    expect(linhas).toEqual([
      'Contacto: nombre, teléfonoworker_contact',
      'Documentosworker_document',
      'Dossier: DNI, domicilio, datos sensiblesworker_pii',
      'Prestador en operaciónworker',
    ]);
  });

  it('🔒 a ordem da grade é a do RÓTULO, não a da chave crua', () => {
    // O caso que motivou: em Operaciones as chaves estão em ordem
    // (dashboard · dedup · integration · test_fixtures) e o que se lê não
    // (Tablero · Duplicados · Integraciones · Datos de prueba).
    montar({
      catalog: [{
        category: 'Operações',
        cells: [
          { resource: 'dashboard', action: 'read', category: 'Operações', ownerService: 'wf' },
          { resource: 'test_fixtures', action: 'execute', category: 'Operações', ownerService: 'wf' },
          { resource: 'dedup', action: 'read', category: 'Operações', ownerService: 'wf' },
        ],
      }],
      // rótulo real de `es.json`: a ordem por chave e a por rótulo DISCORDAM
      rotulos: { dashboard: 'Tablero', dedup: 'Duplicados', test_fixtures: 'Datos de prueba' },
    });
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual([
      'Datos de pruebatest_fixtures', 'Duplicadosdedup', 'Tablerodashboard',
    ]);
  });

  it('🔒 as categorias saem em ordem alfabética do rótulo, não na do backend', () => {
    montar({
      catalog: [
        { category: 'Vagas e Funil', cells: [celula('vacancy', 'read')] },
        { category: 'Trabalhadores', cells: [celula('worker', 'read')] },
      ],
    });
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label')))
      .toEqual(['[Trabalhadores]', '[Vagas e Funil]']);
  });

  it('🔒 a régua do cabeçalho passa da última ação — a coluna de sobra existe', () => {
    // Sem ela a linha parava na última coluna e cada categoria fechava num x
    // diferente (o que o Gabriel viu na tela, 05/09).
    montar();
    const cabecalho = within(bloco('[Trabalhadores]')).getAllByRole('row')[0];
    const sobra = cabecalho.lastElementChild;
    expect(sobra?.tagName).toBe('TD');
    expect(sobra).toHaveAttribute('aria-hidden', 'true');
    expect(sobra).toHaveClass('border-b');
    // e ela não conta como coluna nem como célula no leitor de tela
    expect(within(bloco('[Trabalhadores]')).getAllByRole('columnheader')).toHaveLength(6);
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

  it('grupo sem nenhuma célula desenha a grade toda vazia — quem DIZ isso é o contador', () => {
    // o "Sin células." saiu daqui e virou "Seleccionadas: N" no cabeçalho da
    // seção (GroupDetailPage), que responde a mesma ambiguidade em todo valor
    montar({ selected: new Set(), saved: [] });
    expect(screen.getByTestId('cell-matrix')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').every((c) => !(c as HTMLInputElement).checked)).toBe(true);
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

  it('🔒 sem resolvedor de rótulo, a ordem cai na chave crua', () => {
    const b = montaBloco('C', [celula('z', 'read'), celula('a', 'read')]);
    expect(b.grade.map((l) => l.resource)).toEqual(['a', 'z']);
  });

  it('🔒 com resolvedor, quem manda na ordem é o RÓTULO', () => {
    const b = montaBloco('C', [celula('a', 'read'), celula('z', 'read')], {
      categoria: (c) => c,
      recurso: (r) => (r === 'a' ? 'Zebra' : 'Abelha'),
    });
    expect(b.grade.map((l) => l.resource)).toEqual(['z', 'a']);
    expect(b.grade.map((l) => l.rotulo)).toEqual(['Abelha', 'Zebra']);
  });

  it('🔒 rótulo IGUAL desempata pela chave — a ordem nunca fica ao acaso', () => {
    // sem o desempate, a ordem de dois rótulos iguais dependeria da estabilidade
    // do sort e do lado de onde o catálogo veio
    const b = montaBloco('C', [celula('z', 'read'), celula('a', 'read')], {
      categoria: (c) => c,
      recurso: () => 'Mesmo rótulo',
    });
    expect(b.grade.map((l) => l.resource)).toEqual(['a', 'z']);
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

describe('montaBlocos — a ordem das categorias', () => {
  it('ordena pelo rótulo visível, não pela ordem do backend', () => {
    const blocos = montaBlocos(
      [
        { category: 'Não categorizado', cells: [celula('x', 'read')] },
        { category: 'Operações', cells: [celula('y', 'read')] },
      ],
      { categoria: (c) => (c === 'Não categorizado' ? 'Sin categoría' : 'Operaciones'), recurso: (r) => r },
    );
    // o caso que prova a divergência PT × ES: em português `Não` vem antes de
    // `Operações`; em espanhol `Sin categoría` vem depois de `Operaciones`.
    expect(blocos.map((b) => b.rotulo)).toEqual(['Operaciones', 'Sin categoría']);
  });
});

describe('contaSelecionadas — o número do cabeçalho', () => {
  it('conta o que a GRADE desenha marcado', () => {
    expect(contaSelecionadas(CATALOGO, new Set(['worker:read', 'vacancy:write']))).toBe(2);
  });

  it('conjunto vazio é zero, não é ausência', () => {
    expect(contaSelecionadas(CATALOGO, new Set())).toBe(0);
  });

  it('🔒 célula que o catálogo não declara mais NÃO entra na conta', () => {
    // o sync descontinua chave (foi o que tirou `permission_management:read`
    // da stage): contá-la faria o cabeçalho dizer 2 numa tela com 1 ✓
    expect(contaSelecionadas(CATALOGO, new Set(['worker:read', 'fantasma:read']))).toBe(1);
  });
});
