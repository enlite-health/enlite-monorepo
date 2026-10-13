/**
 * "Quitar" de quem já foi marcado (spec 052, T-31 F7): o servidor recusa com 409 `ENQUADRE_PARTICIPANT_ALREADY_MARKED`;
 * a tela mostra a mensagem do código DENTRO do painel (nunca o texto do servidor) e recarrega.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@infrastructure/i18n/config';
import { datasetById, installDataset } from './support/datasets';
import { StateRoot } from './support/PreviewShell';

let restore: (() => void) | null = null;
beforeAll(async () => { await i18n.changeLanguage('es'); });
afterEach(() => { cleanup(); restore?.(); restore = null; });

describe('painel de convocados: erro por código', () => {
  it('tirar quem já foi marcado mostra a mensagem do código no painel e não tira ninguém', async () => {
    restore = installDataset('04');
    render(<MemoryRouter><StateRoot dataset={datasetById('04')!} /></MemoryRouter>);
    await userEvent.click(await screen.findByTestId('enquadre-event-row-ev-03'));
    await screen.findByTestId('enquadre-kanban-board');
    await userEvent.click(screen.getByTestId('enquadre-kanban-manage'));
    await screen.findByTestId('enquadre-convoked-panel');
    const before = screen.getByTestId('enquadre-convoked-current').getAttribute('data-count');
    await userEvent.click(screen.getByTestId('enquadre-convoked-remove-p-31'));
    await userEvent.click(await screen.findByTestId('enquadre-convoked-remove-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('enquadre-convoked-error').textContent).toBe('Ese convocado ya tiene una marcación y no se puede quitar del evento.'));
    expect(screen.getByTestId('enquadre-convoked-current').getAttribute('data-count')).toBe(before);
    expect(screen.queryByText('já marcado')).not.toBeInTheDocument();
  });
});
