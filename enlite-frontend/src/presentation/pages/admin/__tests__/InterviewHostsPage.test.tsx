/**
 * InterviewHostsPage (spec 055): lista, filtro por país (pessoa AR+BR nos dois), interruptor por fluxo, Quitar ao desligar os dois,
 * e a linha SEM usuário (Ana Joulie): marcada, interruptores desabilitados e só "Quitar". Idioma: es.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@infrastructure/i18n/config';
import type { InterviewHost } from '@domain/entities/InterviewHost';

const api = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn(), create: vi.fn(), searchCandidates: vi.fn() }));
vi.mock('@infrastructure/http/AdminInterviewHostApiService', () => ({ AdminInterviewHostApiService: api }));

import InterviewHostsPage from '../InterviewHostsPage';

const host = (over: Partial<InterviewHost> & { id: string }): InterviewHost => ({
  email: `${over.id}@enlite.health`, displayName: `Nombre ${over.id}`, countries: ['AR'], doesEnquadre: true, doesAdmission: true,
  userUid: `u-${over.id}`, userMissing: false, userInactive: false, tactiq: 'linked', ...over,
});
const FLOR = host({ id: 'flor', displayName: 'Florencia Uberti', countries: ['AR'], doesEnquadre: true, doesAdmission: true });
const MAYRA = host({ id: 'mayra', displayName: 'Mayra Vega', countries: ['AR', 'BR'], tactiq: 'missing' });
const ANA = host({ id: 'ana', displayName: 'Ana Joulie', countries: ['BR'], userUid: null, userMissing: true, tactiq: 'missing' });
const OFF = host({ id: 'off', displayName: 'Persona Off', userInactive: true });

const mount = () => render(<MemoryRouter><InterviewHostsPage /></MemoryRouter>);
const sw = (name: RegExp) => screen.getByRole('switch', { name });

beforeAll(async () => { await i18n.changeLanguage('es'); });
beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  api.list.mockResolvedValue([FLOR, MAYRA, ANA, OFF]);
  api.update.mockResolvedValue({ id: 'x' });
});
afterEach(() => cleanup());

describe('InterviewHostsPage', () => {
  it('lista nome, e-mail, países e estado do Tactiq', async () => {
    mount();
    const row = (await screen.findByText('Mayra Vega')).closest('tr') as HTMLElement;
    expect(within(row).getByText('AR · BR')).toBeInTheDocument();
    expect(within(row).getByTestId('tactiq-sin-vincular')).toBeInTheDocument();
    const flor = screen.getByText('Florencia Uberti').closest('tr') as HTMLElement;
    expect(within(flor).getByTestId('tactiq-vinculado')).toBeInTheDocument();
  });

  it('filtro por país: quem atende os dois aparece nos dois filtros', async () => {
    mount();
    await screen.findByText('Mayra Vega');
    await userEvent.selectOptions(screen.getByLabelText('País'), 'BR');
    expect(screen.getByText('Mayra Vega')).toBeInTheDocument();
    expect(screen.getByText('Ana Joulie')).toBeInTheDocument();
    expect(screen.queryByText('Florencia Uberti')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('País'), 'AR');
    expect(screen.getByText('Mayra Vega')).toBeInTheDocument();
    expect(screen.queryByText('Ana Joulie')).toBeNull();
  });

  it('desligar UM fluxo manda PATCH só com esse fluxo e recarrega', async () => {
    mount();
    await screen.findByText('Florencia Uberti');
    await userEvent.click(sw(/Admisión — Florencia Uberti/));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('flor', { doesAdmission: false }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it('desligar o ÚLTIMO fluxo pede confirmação: Cancelar não envia nada; Quitar envia os dois false', async () => {
    api.list.mockResolvedValue([host({ id: 'solo', displayName: 'Solo Encuadre', doesAdmission: false })]);
    mount();
    await screen.findByText('Solo Encuadre');
    await userEvent.click(sw(/Encuadre — Solo Encuadre/));
    expect(screen.getByTestId('quitar-modal')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(api.update).not.toHaveBeenCalled();

    await userEvent.click(sw(/Encuadre — Solo Encuadre/));
    await userEvent.click(screen.getByTestId('quitar-confirm'));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('solo', { doesEnquadre: false, doesAdmission: false }));
  });

  it('linha SEM usuário: marcada "Sin usuario en el sistema", interruptores desabilitados, sem Editar, só Quitar', async () => {
    mount();
    const row = (await screen.findByText('Ana Joulie')).closest('tr') as HTMLElement;
    expect(within(row).getByTestId('sin-usuario')).toHaveTextContent('Sin usuario en el sistema');
    row.querySelectorAll('[role="switch"]').forEach((s) => expect(s).toBeDisabled());
    expect(within(row).queryByTestId('editar-ana')).toBeNull();
    await userEvent.click(within(row).getByTestId('quitar-ana'));
    await userEvent.click(screen.getByTestId('quitar-confirm'));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('ana', { doesEnquadre: false, doesAdmission: false }));
  });

  it('usuário inativo: marcado "Usuario inactivo", interruptores desabilitados, só Quitar', async () => {
    mount();
    const row = (await screen.findByText('Persona Off')).closest('tr') as HTMLElement;
    expect(within(row).getByTestId('usuario-inactivo')).toBeInTheDocument();
    row.querySelectorAll('[role="switch"]').forEach((s) => expect(s).toBeDisabled());
    expect(within(row).queryByTestId('editar-off')).toBeNull();
    expect(within(row).getByTestId('quitar-off')).toBeInTheDocument();
  });

  it('Agregar abre o painel; falha ao carregar mostra erro com Reintentar', async () => {
    api.list.mockRejectedValueOnce(new Error('boom'));
    mount();
    expect(await screen.findByTestId('load-error')).toBeInTheDocument();
    api.list.mockResolvedValue([FLOR]);
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByText('Florencia Uberti');
    await userEvent.click(screen.getByTestId('agregar-entrevistador'));
    expect(screen.getByTestId('interview-host-panel')).toBeInTheDocument();
  });
});
