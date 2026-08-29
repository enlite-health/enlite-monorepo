/**
 * WorkersTable.test.tsx — a coluna de ação por linha (REQ-09: convite à reunión de presentación):
 * ausente sem renderAction; presente com cabeçalho; clique na ação não abre o perfil.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkersTable, type WorkerRow } from '../WorkersTable';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'es' } }) }));

const row = (id: string): WorkerRow => ({ id, name: `W ${id}`, email: `${id}@x`, casesCount: 0, documentsComplete: false, documentsStatus: 'PENDING', createdAt: '2026-08-29T00:00:00Z', platform: null } as unknown as WorkerRow);

describe('WorkersTable', () => {
  it('sem renderAction: sem coluna de ações; vazio ocupa as colunas certas', () => {
    render(<WorkersTable workers={[]} />);
    expect(screen.queryByText('admin.workers.table.actions')).toBeNull();
    expect(screen.getByText('admin.workers.noWorkers')).toBeInTheDocument();
  });

  it('com renderAction: cabeçalho "ações", célula por linha, e o clique na ação NÃO dispara onRowClick', () => {
    const onRowClick = vi.fn(); const onAction = vi.fn();
    render(<WorkersTable workers={[row('a'), row('b')]} onRowClick={onRowClick} renderAction={(r) => <button data-testid={`act-${r.id}`} onClick={() => onAction(r.id)}>go</button>} />);
    expect(screen.getByText('admin.workers.table.actions')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('act-b'));
    expect(onAction).toHaveBeenCalledWith('b');
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('W a'));
    expect(onRowClick).toHaveBeenCalledWith('a');
  });

  it('vazio com renderAction: colSpan cobre a coluna extra', () => {
    render(<WorkersTable workers={[]} renderAction={() => null} />);
    const cell = screen.getByText('admin.workers.noWorkers').closest('td');
    expect(cell?.getAttribute('colspan')).toBe('7');
  });
});
