/**
 * Evento pela URL (spec 076, FR-14..16): `?event=<id>` abre o kanban do evento; id inexistente OU de outra vaga cai na lista e
 * `getEvent` NUNCA é chamado para ele; o clique na linha grava `event` com PUSH (o voltar desfaz) e "← Eventos" o tira com
 * `replace`. Servidor falso do harness da spec 052 (as mesmas fixtures).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import i18n from '@infrastructure/i18n/config';
import { AdminEnquadreApiService } from '@infrastructure/http/AdminEnquadreApiService';
import { EnquadreTab } from '../EnquadreTab';
import { installFakeServer } from './support/store';
import { AVAILABLE_BASE, EV_01, EV_02, HARNESS_NOW_ISO, HARNESS_VACANCY_ID } from './support/fixtures';

const NOW = new Date(HARNESS_NOW_ISO);
const OTHER_VACANCY_EVENT = 'ev-de-outra-vaga';

const Probe = () => {
  const loc = useLocation();
  const nav = useNavigate();
  return (
    <>
      <span data-testid="url">{loc.pathname + loc.search}</span>
      <button data-testid="browser-back" onClick={() => nav(-1)}>back</button>
    </>
  );
};
const mount = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/admin/vacancies/${HARNESS_VACANCY_ID}${search}`]}>
      <Probe />
      <EnquadreTab vacancyId={HARNESS_VACANCY_ID} now={() => NOW} />
    </MemoryRouter>,
  );

let restore: () => void;
const spyGetEvent = () => vi.spyOn(AdminEnquadreApiService, 'getEvent');
let getEvent: ReturnType<typeof spyGetEvent>;
beforeAll(async () => { await i18n.changeLanguage('es'); });
beforeEach(() => {
  restore = installFakeServer({ events: [EV_01, EV_02], available: AVAILABLE_BASE });
  getEvent = spyGetEvent();
});
afterEach(() => { cleanup(); getEvent.mockRestore(); restore(); });

describe('EnquadreTab: evento pela URL', () => {
  it('?event=<id da vaga> abre o kanban do evento', async () => {
    mount('?tab=enquadre&event=ev-01');
    const tab = await screen.findByTestId('enquadre-tab');
    await waitFor(() => expect(tab).toHaveAttribute('data-selected-event', 'ev-01'));
    expect(await screen.findByTestId('enquadre-kanban-header')).toBeInTheDocument();
    expect(getEvent).toHaveBeenCalledWith(HARNESS_VACANCY_ID, 'ev-01');
  });

  it.each([
    ['inexistente', 'ev-nao-existe'],
    ['de outra vaga', OTHER_VACANCY_EVENT],
  ])('🔴 ?event=<id %s> mostra a tabela de eventos, tira `event` da URL e getEvent nunca é chamado', async (_n, id) => {
    getEvent.mockResolvedValue({} as never);
    mount(`?tab=enquadre&event=${id}`);
    expect(await screen.findByTestId('enquadre-event-row-ev-01')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe(`/admin/vacancies/${HARNESS_VACANCY_ID}?tab=enquadre`));
    expect(screen.getByTestId('enquadre-tab')).not.toHaveAttribute('data-selected-event');
    expect(screen.queryByTestId('enquadre-kanban-header')).toBeNull();
    expect(getEvent).not.toHaveBeenCalled();
  });

  it('clique na linha grava `event` na URL com PUSH: o voltar do navegador desfaz a seleção', async () => {
    mount('?tab=enquadre');
    await userEvent.click(await screen.findByTestId('enquadre-event-row-ev-02'));
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe(`/admin/vacancies/${HARNESS_VACANCY_ID}?tab=enquadre&event=ev-02`));
    expect(await screen.findByTestId('enquadre-kanban-header')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('browser-back'));
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe(`/admin/vacancies/${HARNESS_VACANCY_ID}?tab=enquadre`));
    expect(await screen.findByTestId('enquadre-event-row-ev-02')).toBeInTheDocument();
  });

  it('"← Eventos" tira `event` da URL e volta à lista', async () => {
    mount('?tab=enquadre&event=ev-01');
    await userEvent.click(await screen.findByTestId('enquadre-kanban-back'));
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe(`/admin/vacancies/${HARNESS_VACANCY_ID}?tab=enquadre`));
    expect(await screen.findByTestId('enquadre-event-row-ev-01')).toBeInTheDocument();
  });

  it('o `tab` da URL é preservado ao abrir e fechar o evento', async () => {
    mount('?tab=enquadre&x=1');
    await userEvent.click(await screen.findByTestId('enquadre-event-row-ev-01'));
    await waitFor(() => expect(screen.getByTestId('url').textContent).toContain('tab=enquadre'));
    expect(screen.getByTestId('url').textContent).toContain('x=1');
  });
});
