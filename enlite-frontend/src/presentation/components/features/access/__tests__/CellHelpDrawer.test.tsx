import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CellHelpDrawer } from '..';

/**
 * O mock modela o i18next de verdade: chave conhecida devolve texto, chave
 * ausente com default `''` devolve `''`. É essa diferença que decide se o
 * painel mostra a explicação ou admite que não tem uma — e um mock que
 * devolvesse sempre a chave aprovaria o caminho errado.
 */
const TEXTOS: Record<string, string> = {
  'admin.access.group.cells.help.close': 'Cerrar',
  'admin.access.group.cells.help.actions': 'Qué hace cada casilla de esta fila',
  'admin.access.group.cells.help.missing': 'Todavía no escribimos la explicación de este permiso.',
  'admin.access.group.cells.help.resource.worker_pii.body': 'Es el dossier de identidad: DNI, domicilio, origen racial, religión y orientación sexual.',
  'admin.access.group.cells.help.resource.worker_pii.action.read': 'Ver el dossier completo.',
  'admin.access.group.cells.action.read': 'Ver',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: unknown) => TEXTOS[k] ?? (typeof o === 'string' ? o : k),
  }),
}));

const montar = (over: Partial<Parameters<typeof CellHelpDrawer>[0]> = {}) => {
  const onClose = vi.fn();
  render(
    <CellHelpDrawer resource="worker_pii" rotulo="Dossier" acoes={['read']} onClose={onClose} {...over} />,
  );
  return { onClose };
};

describe('CellHelpDrawer — a ajuda de uma permissão', () => {
  it('sem recurso aberto não existe painel nenhum no DOM', () => {
    montar({ resource: null });
    expect(screen.queryByTestId('cell-help')).not.toBeInTheDocument();
  });

  it('🔒 mostra o texto curado e o que cada caixa da linha faz', () => {
    montar();
    expect(screen.getByText(/dossier de identidad/)).toBeInTheDocument();
    expect(screen.getByText('Qué hace cada casilla de esta fila')).toBeInTheDocument();
    expect(screen.getByText('Ver el dossier completo.')).toBeInTheDocument();
    // o nome da ação sai traduzido, o mesmo da coluna da grade
    expect(screen.getByText('Ver')).toBeInTheDocument();
  });

  it('🔒 nomeia as categorias sensíveis — descrever de MENOS é o risco real', () => {
    // o parecer do `lex` (05/09) autorizou e recomendou: "Exportar listagem" é
    // o defeito perigoso, não "expõe raça, religião e orientação sexual".
    montar();
    const corpo = screen.getByText(/dossier de identidad/).textContent ?? '';
    for (const termo of ['DNI', 'origen racial', 'religión', 'orientación sexual']) {
      expect(corpo).toContain(termo);
    }
  });

  it('recurso SEM texto curado admite que não tem, em vez de inventar', () => {
    montar({ resource: 'inventado', rotulo: 'Inventado', acoes: ['read'] });
    expect(screen.getByText(/Todavía no escribimos/)).toBeInTheDocument();
  });

  it('ação sem texto curado some da lista em vez de virar chave crua', () => {
    montar({ acoes: ['read', 'export'] });
    expect(screen.getByText('Ver el dossier completo.')).toBeInTheDocument();
    expect(screen.queryByText(/help\.resource\.worker_pii\.action\.export/)).not.toBeInTheDocument();
  });

  it('é um diálogo de verdade: modal, rotulado, e o foco vai para o fechar', () => {
    montar();
    const painel = screen.getByTestId('cell-help');
    expect(painel).toHaveAttribute('role', 'dialog');
    expect(painel).toHaveAttribute('aria-modal', 'true');
    expect(painel).toHaveAttribute('aria-label', 'Dossier');
    expect(screen.getByRole('button', { name: 'Cerrar' })).toHaveFocus();
    // e a cortina não entra na árvore de acessibilidade
    expect(document.querySelector('[aria-hidden="true"].fixed')).toBeInTheDocument();
  });

  it('fecha pelo botão, pela cortina e pelo Esc', async () => {
    const { onClose } = montar();
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    // a cortina fecha ao clique, mas NÃO é um segundo "Cerrar" na tabulação
    const cortina = document.querySelector('[aria-hidden="true"].fixed');
    expect(screen.getAllByRole('button', { name: 'Cerrar' })).toHaveLength(1);
    await userEvent.click(cortina as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('o Esc para de escutar quando o painel fecha — sem listener órfão', async () => {
    const { onClose } = montar({ resource: null });
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
