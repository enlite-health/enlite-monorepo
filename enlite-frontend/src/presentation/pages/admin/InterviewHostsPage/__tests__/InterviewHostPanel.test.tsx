/**
 * InterviewHostPanel (spec 055): busca só entre os candidatos que a API devolve (sem e-mail livre), avisos só depois da primeira
 * interação, "Agregar" só com ≥1 país e ≥1 fluxo, e erro da API traduzido pelo `code`. Idioma: es.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@infrastructure/i18n/config';
import { ApiError } from '@infrastructure/http/ApiError';
import type { InterviewHost } from '@domain/entities/InterviewHost';

const searchCandidates = vi.fn();
vi.mock('@infrastructure/http/AdminInterviewHostApiService', () => ({
  AdminInterviewHostApiService: { searchCandidates: (q: string) => searchCandidates(q) },
}));

import { InterviewHostPanel } from '../InterviewHostPanel';

const FLOR = { uid: 'u-flor', displayName: 'Florencia Uberti', email: 'florencia.uberti@enlite.health' };
const EDITING: InterviewHost = {
  id: 'h1', email: FLOR.email, displayName: FLOR.displayName, countries: ['AR'], doesEnquadre: true, doesAdmission: true,
  userUid: FLOR.uid, userMissing: false, userInactive: false, tactiq: 'linked',
};

beforeAll(async () => { await i18n.changeLanguage('es'); });
beforeEach(() => { searchCandidates.mockReset(); });
afterEach(() => cleanup());

describe('InterviewHostPanel — agregar', () => {
  it('busca só a partir de 2 letras, mostra o resultado e fixa o usuário escolhido', async () => {
    searchCandidates.mockResolvedValue([FLOR]);
    render(<InterviewHostPanel onSubmit={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'f');
    await new Promise((r) => setTimeout(r, 400));
    expect(searchCandidates).not.toHaveBeenCalled();
    await userEvent.type(input, 'lo');
    await userEvent.click(await screen.findByTestId('candidate-u-flor'));
    expect(searchCandidates).toHaveBeenCalledWith('flo');
    expect(screen.getByTestId('picked-user')).toHaveTextContent('Florencia Uberti');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('busca sem resultado (worker, inativo) → mensagem, e nada para escolher', async () => {
    searchCandidates.mockResolvedValue([]);
    render(<InterviewHostPanel onSubmit={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole('combobox'), 'zzz');
    expect(await screen.findByTestId('no-results')).toBeInTheDocument();
    expect(screen.getByTestId('panel-save')).toBeDisabled();
  });

  it('avisos só depois da primeira interação; Agregar só com país e fluxo', async () => {
    searchCandidates.mockResolvedValue([FLOR]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<InterviewHostPanel onSubmit={onSubmit} onClose={vi.fn()} />);
    // formulário recém-aberto: nenhum "Elegí al menos…"
    expect(screen.queryByTestId('no-flow-help')).toBeNull();
    expect(screen.queryByTestId('no-country-help')).toBeNull();

    await userEvent.type(screen.getByRole('combobox'), 'flo');
    await userEvent.click(await screen.findByTestId('candidate-u-flor'));
    expect(screen.getByTestId('panel-save')).toBeDisabled(); // sem fluxo

    // desmarcar o país padrão (AR) → aviso aparece, Agregar segue desabilitado
    await userEvent.click(screen.getByRole('button', { name: /Argentina/ }));
    expect(screen.getByTestId('no-country-help')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Brasil/ }));
    expect(screen.queryByTestId('no-country-help')).toBeNull();

    // marca e desmarca Encuadre → aviso do fluxo aparece; marca de novo → habilita
    await userEvent.click(screen.getByLabelText('Encuadre'));
    await userEvent.click(screen.getByLabelText('Encuadre'));
    expect(screen.getByTestId('no-flow-help')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Encuadre'));
    expect(screen.getByTestId('panel-save')).toBeEnabled();

    await userEvent.click(screen.getByTestId('panel-save'));
    expect(onSubmit).toHaveBeenCalledWith({ user: FLOR, countries: ['BR'], doesEnquadre: true, doesAdmission: false });
  });

  it('erro da API é traduzido pelo code (nunca a mensagem do servidor) e o painel segue aberto', async () => {
    searchCandidates.mockResolvedValue([FLOR]);
    const onSubmit = vi.fn().mockRejectedValue(
      new ApiError({ success: false, error: 'mensagem crua do servidor', code: 'INTERVIEW_HOST_USER_NOT_ELIGIBLE' } as never, 400),
    );
    render(<InterviewHostPanel onSubmit={onSubmit} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole('combobox'), 'flo');
    await userEvent.click(await screen.findByTestId('candidate-u-flor'));
    await userEvent.click(screen.getByLabelText('Encuadre'));
    await userEvent.click(screen.getByTestId('panel-save'));
    const err = await screen.findByTestId('save-error');
    expect(err).toHaveTextContent('Esa persona no es un usuario activo del equipo.');
    expect(err).not.toHaveTextContent('mensagem crua');
    await waitFor(() => expect(screen.getByTestId('panel-save')).toBeEnabled());
  });
});

describe('InterviewHostPanel — editar', () => {
  it('usuário fixo (sem busca), países e fluxos preenchidos, "Guardar" envia o que mudou', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<InterviewHostPanel editing={EDITING} onSubmit={onSubmit} onClose={vi.fn()} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByTestId('picked-user')).toHaveTextContent(FLOR.email);
    expect(searchCandidates).not.toHaveBeenCalled();

    await userEvent.click(screen.getByLabelText('Admisión')); // desliga admissão
    await userEvent.click(screen.getByRole('button', { name: /Brasil/ })); // liga BR
    await userEvent.click(screen.getByTestId('panel-save'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ countries: ['AR', 'BR'], doesEnquadre: true, doesAdmission: false }));
  });
});
