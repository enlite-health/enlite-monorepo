/**
 * AdminEnquadresPage (spec 076): totais do SERVIDOR (não da página), vazio, erro + retry, trava das duas células, href da
 * linha, selo de importação bloqueada e FUSO do país do evento (mapa trocado: AR e BR têm o mesmo -03 hoje, e um teste com
 * os fusos reais passaria por coincidência). Idioma: es.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '@infrastructure/i18n/config';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { EnquadreGlobalList, EnquadreGlobalListItem } from '@domain/entities/EnquadreEvent';
import { ApiError } from '@infrastructure/http/ApiError';

vi.mock('@presentation/utils/countryTimeZone', () => ({
  COUNTRY_TIME_ZONE: { AR: 'Etc/GMT+3', BR: 'Etc/GMT-5', UY: 'Etc/GMT+3' },
}));
const api = vi.hoisted(() => ({ listAll: vi.fn() }));
vi.mock('@infrastructure/http/AdminEnquadreApiService', () => ({ AdminEnquadreApiService: api }));

import AdminEnquadresPage from '../AdminEnquadresPage';

const item = (over: Partial<EnquadreGlobalListItem> & { id: string }): EnquadreGlobalListItem => ({
  jobPostingId: `jp-${over.id}`, caseNumber: 1234, caseOrdinal: 2, eventCode: `ENC-${over.id.toUpperCase()}`,
  startsAt: '2026-10-28T17:00:00.000Z', endsAt: '2026-10-28T18:00:00.000Z', country: 'AR', hostName: 'Entrevistadora Ficticia',
  status: 'open', phase: 'scheduled', convokedCount: 3, importBlocked: null, ...over,
});
const list = (items: EnquadreGlobalListItem[], over: Partial<EnquadreGlobalList> = {}): EnquadreGlobalList => ({
  items, total: items.length, convokedTotal: items.length * 3, hosts: ['Entrevistadora Ficticia'],
  range: { from: '2026-10-26', to: '2026-11-01', defaulted: true }, scope: { countries: ['AR'], requested: 'ALL' }, ...over,
});

const Where = () => <span data-testid="where">{useLocation().pathname + useLocation().search}</span>;
const mount = (url = '/admin/enquadres') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Where />
      <Routes>
        <Route path="/admin/enquadres" element={<AdminEnquadresPage />} />
        <Route path="/admin" element={<span data-testid="admin-home" />} />
        <Route path="/admin/vacancies/:id" element={<span data-testid="vacancy-detail" />} />
      </Routes>
    </MemoryRouter>,
  );
const setAuth = (permissions: string[], enforcement: 'on' | 'off') =>
  useAdminAuthStore.setState({ authzStatus: 'ready', authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: ['AR'], groups: [], features: {}, enforcement } });

beforeAll(async () => { await i18n.changeLanguage('es'); });
beforeEach(() => { api.listAll.mockReset(); setAuth([], 'off'); });
afterEach(() => { cleanup(); useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }); });

describe('AdminEnquadresPage', () => {
  it('🔴 os totais vêm do servidor, não da página: 20 linhas e total=25 mostram 25', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => item({ id: `e${i}` }));
    api.listAll.mockResolvedValue(list(rows, { total: 25, convokedTotal: 71 }));
    mount();
    expect((await screen.findByTestId('enquadres-totals')).textContent).toBe('25 encuadres · 71 convocados');
    expect(screen.getAllByTestId('enquadres-row')).toHaveLength(20);
  });

  it('singular: 1 encuadre · 1 convocado', async () => {
    api.listAll.mockResolvedValue(list([item({ id: 'a' })], { total: 1, convokedTotal: 1 }));
    mount();
    expect((await screen.findByTestId('enquadres-totals')).textContent).toBe('1 encuadre · 1 convocado');
  });

  it('vazio mostra o intervalo e os campos Desde/Hasta vêm preenchidos pela semana do servidor, sem tocar a URL', async () => {
    api.listAll.mockResolvedValue(list([], { total: 0, convokedTotal: 0 }));
    mount();
    expect((await screen.findByTestId('enquadres-empty')).textContent).toBe('No hay encuadres entre 26/10/2026 y 01/11/2026.');
    expect(screen.getByTestId('enquadres-filter-from')).toHaveValue('2026-10-26');
    expect(screen.getByTestId('enquadres-filter-to')).toHaveValue('2026-11-01');
    expect(screen.getByTestId('where').textContent).toBe('/admin/enquadres');
    const sent = api.listAll.mock.calls[0][0];
    expect(sent.from).toBeUndefined();
    expect(sent.to).toBeUndefined();
    expect(sent).toMatchObject({ limit: 20, offset: 0 });
  });

  it('erro mostra o texto do code e "Intentar de nuevo" recarrega', async () => {
    api.listAll.mockRejectedValueOnce(new ApiError({ success: false, error: 'x', code: 'COUNTRY_SCOPE_REQUIRED' }, 403));
    api.listAll.mockResolvedValueOnce(list([item({ id: 'a' })]));
    mount();
    expect((await screen.findByTestId('enquadres-error')).textContent).toContain('Tu usuario no tiene un país asignado');
    await userEvent.click(screen.getByTestId('enquadres-retry'));
    expect(await screen.findByTestId('enquadres-row')).toBeInTheDocument();
    expect(api.listAll).toHaveBeenCalledTimes(2);
  });

  it('🔴 com enforcement on e SÓ uma das células, navega a /admin e não chama a API', async () => {
    setAuth(['enquadre_event:read'], 'on');
    mount();
    await waitFor(() => expect(screen.getByTestId('admin-home')).toBeInTheDocument());
    expect(api.listAll).not.toHaveBeenCalled();
  });

  it('com as duas células abre e lista', async () => {
    setAuth(['enquadre_event:read', 'vacancy:read'], 'on');
    api.listAll.mockResolvedValue(list([item({ id: 'a' })]));
    mount();
    expect(await screen.findByTestId('enquadres-page')).toBeInTheDocument();
  });

  it('a linha leva à aba Enquadre da vaga com o evento (clique) e o link tem o href certo', async () => {
    api.listAll.mockResolvedValue(list([item({ id: 'ev1' })]));
    mount();
    const row = await screen.findByTestId('enquadres-row');
    expect(row).toHaveAttribute('data-event-id', 'ev1');
    expect(within(row).getByTestId('enquadres-row-link')).toHaveAttribute('href', '/admin/vacancies/jp-ev1?tab=enquadre&event=ev1');
    await userEvent.click(row);
    expect(screen.getByTestId('vacancy-detail')).toBeInTheDocument();
    expect(screen.getByTestId('where').textContent).toBe('/admin/vacancies/jp-ev1?tab=enquadre&event=ev1');
  });

  it('Enter na linha também abre', async () => {
    api.listAll.mockResolvedValue(list([item({ id: 'ev1' })]));
    mount();
    const row = await screen.findByTestId('enquadres-row');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('where').textContent).toContain('event=ev1');
  });

  it('evento com importação bloqueada mostra o motivo traduzido; motivo desconhecido cai no código cru', async () => {
    api.listAll.mockResolvedValue(list([
      item({ id: 'a', importBlocked: { reason: 'meet_scope_missing' } }),
      item({ id: 'b', importBlocked: { reason: 'motivo_novo' } }),
      item({ id: 'c' }),
    ]));
    mount();
    const blocked = await screen.findAllByTestId('enquadres-import-blocked');
    expect(blocked).toHaveLength(2);
    expect(blocked[0].textContent).toBe('Importación bloqueada: Falta el permiso de Google Meet');
    expect(blocked[1].textContent).toBe('Importación bloqueada: motivo_novo');
  });

  it('🔴 fuso: o mesmo instante sai 14:00 no evento AR e 22:00 no evento BR (mapa trocado)', async () => {
    api.listAll.mockResolvedValue(list([item({ id: 'ar', country: 'AR' }), item({ id: 'br', country: 'BR' })]));
    mount();
    const rows = await screen.findAllByTestId('enquadres-row');
    expect(within(rows[0]).getByTestId('enquadres-row-link').textContent).toBe('28/10 14:00');
    expect(within(rows[1]).getByTestId('enquadres-row-link').textContent).toBe('28/10 22:00');
  });

  it('seletor de país só com escopo > 1; página 2 vai para a URL e o offset segue', async () => {
    api.listAll.mockResolvedValue(list([item({ id: 'a' })], { total: 45, scope: { countries: ['AR', 'BR'], requested: 'ALL' } }));
    mount();
    await screen.findByTestId('enquadres-row');
    expect(screen.getByTestId('enquadres-filter-country')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(i18n.t('common.nextPage')));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/admin/enquadres?page=2'));
    await waitFor(() => expect(api.listAll).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20, limit: 20 })));
  });

  it('país único no escopo: sem seletor de país', async () => {
    api.listAll.mockResolvedValue(list([item({ id: 'a' })]));
    mount();
    await screen.findByTestId('enquadres-row');
    expect(screen.queryByTestId('enquadres-filter-country')).toBeNull();
  });

  it('🔴 Hasta anterior a Desde: mostra o erro e NÃO chama a API de novo', async () => {
    api.listAll.mockResolvedValue(list([item({ id: 'a' })]));
    mount();
    await screen.findByTestId('enquadres-row');
    const to = screen.getByTestId('enquadres-filter-to');
    await userEvent.clear(to);
    await userEvent.type(to, '2026-10-01');
    await userEvent.click(screen.getByTestId('enquadres-filter-apply'));
    expect((await screen.findByTestId('enquadres-range-error')).textContent).toBe('La fecha Hasta no puede ser anterior a Desde.');
    expect(api.listAll).toHaveBeenCalledTimes(1);
  });
});
