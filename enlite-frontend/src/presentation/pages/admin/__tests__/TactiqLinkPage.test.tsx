/**
 * TactiqLinkPage — "Vincular Tactiq" (spec 049, F7): estado do vínculo, botão que inicia o OAuth e redireciona o
 * navegador, retorno do callback (`?tactiq=linked|error&reason=`) e a célula `own_tactiq_link:create`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { i18nMock, setCells, tEs } from '@presentation/components/features/admin/PatientDetail/admission/__tests__/admissionTestKit';

vi.mock('react-i18next', () => i18nMock);
const api = vi.hoisted(() => ({ getOwnTactiqLink: vi.fn(), startTactiqLink: vi.fn() }));
vi.mock('@infrastructure/http/AdminAdmissionApiService', () => ({ AdminAdmissionApiService: api }));

import TactiqLinkPage from '../TactiqLinkPage';

function Where(): JSX.Element {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}
function renderPage(search = '', redirect = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[`/admin/mi-cuenta/tactiq${search}`]}>
      <TactiqLinkPage redirect={redirect} />
      <Where />
    </MemoryRouter>,
  );
  return { redirect };
}
const view = (status: string, extra: Record<string, string | null> = {}) => ({
  status,
  linkedAt: null,
  lastCheckAt: null,
  statusChangedAt: '2026-10-10T12:00:00.000Z',
  ...extra,
});

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  setCells(['own_tactiq_link:read', 'own_tactiq_link:create']);
});
afterEach(() => setCells(null));

describe('estado do vínculo', () => {
  it.each(['missing', 'broken', 'wrong_account', 'revoked'])('%s: mostra o estado e o texto próprio, e oferece "Vincular Tactiq"', async (status) => {
    api.getOwnTactiqLink.mockResolvedValue(view(status));
    renderPage();
    const chip = await screen.findByTestId('tactiq-state');
    expect(chip).toHaveTextContent(tEs(`admin.tactiqLink.state.${status}`));
    expect(screen.getByTestId('tactiq-state-help')).toHaveTextContent(tEs(`admin.tactiqLink.stateHelp.${status}`));
    expect(screen.getByTestId('tactiq-link-button')).toHaveTextContent('Vincular Tactiq');
    expect(screen.queryByTestId('tactiq-linked-at')).not.toBeInTheDocument();
  });

  it('vinculado: mostra desde quando e a última verificação, e o botão vira "Volver a vincular"', async () => {
    api.getOwnTactiqLink.mockResolvedValue(view('linked', { linkedAt: '2026-10-09T15:00:00.000Z', lastCheckAt: '2026-10-10T09:00:00.000Z' }));
    renderPage();
    expect(await screen.findByTestId('tactiq-state')).toHaveTextContent('Vinculado');
    expect(screen.getByTestId('tactiq-linked-at').textContent).toMatch(/9.*oct/i);
    expect(screen.getByTestId('tactiq-last-check-at').textContent).toMatch(/10.*oct/i);
    expect(screen.getByTestId('tactiq-link-button')).toHaveTextContent('Volver a vincular');
  });

  it('a tela não recebe nem mostra token: só os campos do contrato', async () => {
    api.getOwnTactiqLink.mockResolvedValue({ ...view('linked'), refreshToken: 'rt-segredo' });
    renderPage();
    await screen.findByTestId('tactiq-state');
    expect(document.body.textContent).not.toContain('rt-segredo');
  });

  it('falha ao carregar: erro + tentar de novo (nunca um estado inventado)', async () => {
    api.getOwnTactiqLink.mockRejectedValueOnce(new Error('x'));
    renderPage();
    expect(await screen.findByTestId('tactiq-load-error')).toBeInTheDocument();
    expect(screen.queryByTestId('tactiq-state')).not.toBeInTheDocument();
    api.getOwnTactiqLink.mockResolvedValueOnce(view('missing'));
    fireEvent.click(screen.getByTestId('tactiq-retry'));
    expect(await screen.findByTestId('tactiq-state')).toBeInTheDocument();
  });
});

describe('vincular', () => {
  it('o clique pede a URL ao servidor e redireciona o NAVEGADOR para ela', async () => {
    api.getOwnTactiqLink.mockResolvedValue(view('missing'));
    api.startTactiqLink.mockResolvedValue({ authorizeUrl: 'https://tactiq.example.test/authorize?state=abc' });
    const { redirect } = renderPage();
    fireEvent.click(await screen.findByTestId('tactiq-link-button'));
    await waitFor(() => expect(redirect).toHaveBeenCalledWith('https://tactiq.example.test/authorize?state=abc'));
    expect(api.startTactiqLink).toHaveBeenCalledTimes(1);
  });

  it('falha ao iniciar: mensagem, nada de redirect, e o botão volta', async () => {
    api.getOwnTactiqLink.mockResolvedValue(view('missing'));
    api.startTactiqLink.mockRejectedValue(new Error('503'));
    const { redirect } = renderPage();
    fireEvent.click(await screen.findByTestId('tactiq-link-button'));
    expect(await screen.findByTestId('tactiq-start-error')).toHaveTextContent(tEs('admin.tactiqLink.startError'));
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('tactiq-link-button')).not.toBeDisabled();
  });

  it('sem own_tactiq_link:create o botão some (a tela só informa)', async () => {
    setCells(['own_tactiq_link:read']);
    api.getOwnTactiqLink.mockResolvedValue(view('missing'));
    renderPage();
    await screen.findByTestId('tactiq-state');
    expect(screen.queryByTestId('tactiq-link-button')).not.toBeInTheDocument();
  });
});

describe('volta do callback', () => {
  it('?tactiq=linked: banner de sucesso, estado relido do servidor e URL limpa (F5 não repete)', async () => {
    api.getOwnTactiqLink.mockResolvedValue(view('linked', { linkedAt: '2026-10-09T15:00:00.000Z' }));
    renderPage('?tactiq=linked');
    expect(await screen.findByTestId('tactiq-banner-linked')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/mi-cuenta/tactiq'));
    expect(screen.getByTestId('where').textContent).toBe('/admin/mi-cuenta/tactiq');
    expect(await screen.findByTestId('tactiq-state')).toHaveTextContent('Vinculado');
    expect(api.getOwnTactiqLink).toHaveBeenCalled();
  });

  it('?tactiq=error&reason=…: banner de erro SEM ecoar o motivo cru', async () => {
    api.getOwnTactiqLink.mockResolvedValue(view('missing'));
    renderPage('?tactiq=error&reason=invalid_grant');
    const banner = await screen.findByTestId('tactiq-banner-error');
    expect(banner).toHaveTextContent(tEs('admin.tactiqLink.returnError'));
    expect(document.body.textContent).not.toContain('invalid_grant');
    expect(screen.getByTestId('where').textContent).toBe('/admin/mi-cuenta/tactiq');
  });

  it('valor estranho em ?tactiq= nunca vira banner', async () => {
    api.getOwnTactiqLink.mockResolvedValue(view('missing'));
    renderPage('?tactiq=<script>');
    await screen.findByTestId('tactiq-state');
    expect(screen.queryByTestId('tactiq-banner-linked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tactiq-banner-error')).not.toBeInTheDocument();
  });
});
