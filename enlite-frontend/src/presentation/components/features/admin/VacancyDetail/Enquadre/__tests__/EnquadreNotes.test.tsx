/** Notas do card do kanban do evento (spec 052, T-31 F5): o botão abre o `ContactNotesModal` do funil com vaga, prestador e nome. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@infrastructure/i18n/config';
import { HARNESS_VACANCY_ID } from './support/fixtures';
import { datasetById, installDataset } from './support/datasets';
import { StateRoot } from './support/PreviewShell';

vi.mock('../../Funnel/ContactNotesModal', () => ({
  ContactNotesModal: (p: { vacancyId: string; workerId: string; workerName: string; onClose: () => void }) => (
    <div data-testid="notes-modal-stub" data-vacancy={p.vacancyId} data-worker={p.workerId}>
      <span data-testid="notes-modal-name">{p.workerName}</span>
      <button type="button" data-testid="notes-modal-close" onClick={p.onClose}>x</button>
    </div>
  ),
}));

let restore: (() => void) | null = null;
beforeAll(async () => { await i18n.changeLanguage('es'); });
afterEach(() => { cleanup(); restore?.(); restore = null; });

describe('notas do card do evento', () => {
  it('o botão de notas do card abre o modal com vacancyId, workerId e workerName do convocado; fechar some', async () => {
    restore = installDataset('03');
    render(<MemoryRouter><StateRoot dataset={datasetById('03')!} /></MemoryRouter>);
    await userEvent.click(await screen.findByTestId('enquadre-event-row-ev-01'));
    await screen.findByTestId('enquadre-kanban-board');
    const card = await screen.findByTestId('enquadre-participant-p-01');
    const expectedName = card.textContent ?? '';
    await userEvent.click(within(card).getByTestId('notes-button'));
    const modal = screen.getByTestId('notes-modal-stub');
    expect(modal.getAttribute('data-vacancy')).toBe(HARNESS_VACANCY_ID);
    expect(modal.getAttribute('data-worker')).toBeTruthy();
    expect(expectedName).toContain(screen.getByTestId('notes-modal-name').textContent ?? 'x');
    await userEvent.click(screen.getByTestId('notes-modal-close'));
    expect(screen.queryByTestId('notes-modal-stub')).not.toBeInTheDocument();
  });
});
