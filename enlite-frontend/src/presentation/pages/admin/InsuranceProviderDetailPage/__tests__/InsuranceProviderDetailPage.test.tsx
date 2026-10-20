/** A página de cartões: 4 cartões, o link do PAYER_KIND_REQUIRED abre a edição de Dados gerais e a rota se fecha sem a célula. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { apiError, comCelulas, contractItem, provider, semEnforcement } from './support';

vi.mock('react-i18next', async () => (await import('./support')).i18nMock);
const api = vi.hoisted(() => ({
  getProvider: vi.fn(), patchProvider: vi.fn(), listContacts: vi.fn(), listContracts: vi.fn(), createContract: vi.fn(),
  listProviderPatients: vi.fn(), listProvidersForService: vi.fn(),
}));
vi.mock('@infrastructure/http/AdminInsuranceApiService', () => ({ AdminInsuranceApiService: api }));

const { default: Page } = await import('../InsuranceProviderDetailPage');

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/obras-sociales/OSDE']}>
      <Routes>
        <Route path="/admin/obras-sociales/:code" element={<Page />} />
        <Route path="/admin" element={<div data-testid="admin-home" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  semEnforcement();
  api.getProvider.mockResolvedValue(provider());
  api.listContacts.mockResolvedValue([]);
  api.listContracts.mockResolvedValue([contractItem()]);
  api.listProviderPatients.mockResolvedValue([]);
  api.listProvidersForService.mockResolvedValue({ providers: [], asOf: '2026-10-19' });
});

describe('InsuranceProviderDetailPage', () => {
  it('abre os 4 cartões, cada um com o seu conteúdo', async () => {
    renderPage();
    expect(await screen.findByTestId('provider-general-card')).toBeInTheDocument();
    expect(screen.getByTestId('provider-employees-card')).toBeInTheDocument();
    expect(screen.getByTestId('provider-contracts-card')).toBeInTheDocument();
    expect(screen.getByTestId('provider-patients-card')).toBeInTheDocument();
    expect(api.getProvider).toHaveBeenCalledWith('OSDE');
  });

  it('PAYER_KIND_REQUIRED: o link do cartão Contratos abre a edição de Dados gerais', async () => {
    api.createContract.mockRejectedValue(apiError(422, 'PAYER_KIND_REQUIRED'));
    renderPage();
    fireEvent.click(await screen.findByTestId('contracts-new'));
    fireEvent.change(screen.getByTestId('contract-new-name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByTestId('contract-new-country'), { target: { value: 'AR' } });
    await waitFor(() => expect(screen.getByTestId('contract-new-valid-from')).toHaveValue('2026-10-19'));
    fireEvent.change(screen.getByTestId('contract-new-hourly-rate'), { target: { value: '80' } });
    fireEvent.change(screen.getByTestId('contract-new-tax-rate'), { target: { value: '21' } });
    fireEvent.click(screen.getByTestId('contract-new-submit'));
    fireEvent.click(await screen.findByTestId('contracts-go-general'));
    expect(await screen.findByTestId('provider-general-form')).toBeInTheDocument();
  });

  it('obra social inexistente (404) mostra a frase, não os cartões', async () => {
    api.getProvider.mockRejectedValue(apiError(404, 'PROVIDER_NOT_FOUND'));
    renderPage();
    expect(await screen.findByTestId('provider-load-error')).toHaveTextContent('A obra social não existe.');
    expect(screen.queryByTestId('provider-detail')).not.toBeInTheDocument();
  });

  it('sem catalog_insurance_providers:read (engine ligado) a rota redireciona e não chama a API', async () => {
    comCelulas(['insurance_contracts:read']);
    renderPage();
    expect(await screen.findByTestId('admin-home')).toBeInTheDocument();
    expect(api.getProvider).not.toHaveBeenCalled();
  });
});
