/** InsuranceProvidersPage — lista, busca, criar só com o nome (aliases opcional) e NAME_NOT_CODIFIABLE pedindo o código. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { apiError, comCelulas, semEnforcement } from '../InsuranceProviderDetailPage/__tests__/support';

vi.mock('react-i18next', async () => (await import('../InsuranceProviderDetailPage/__tests__/support')).i18nMock);
const api = vi.hoisted(() => ({ listProviders: vi.fn(), createProvider: vi.fn() }));
vi.mock('@infrastructure/http/AdminInsuranceApiService', () => ({ AdminInsuranceApiService: api }));

const { default: Page } = await import('../InsuranceProvidersPage');
const { parseAliases } = await import('../InsuranceProviderDetailPage/aliases');

function Where(): JSX.Element {
  return <div data-testid="where">{useLocation().pathname}</div>;
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/obras-sociales']}>
      <Routes>
        <Route path="/admin/obras-sociales" element={<Page />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
const ITEMS = [
  { code: 'OSDE', name: 'OSDE', payerKind: 'PREPAGA', active: true },
  { code: 'IOSCOR', name: 'IOSCOR', payerKind: null, active: false },
];
const change = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  semEnforcement();
  api.listProviders.mockResolvedValue(ITEMS);
});

describe('InsuranceProvidersPage', () => {
  it('lista nome, tipo do pagador ("Sem classificar" quando nulo) e situação', async () => {
    renderPage();
    expect(await screen.findByTestId('provider-name-OSDE')).toHaveTextContent('OSDE');
    expect(screen.getByTestId('provider-kind-OSDE')).toHaveTextContent('Prepaga');
    expect(screen.getByTestId('provider-kind-IOSCOR')).toHaveTextContent('Sem classificar');
    expect(screen.getByTestId('provider-status-IOSCOR')).toHaveTextContent('Inativa');
  });

  it('busca por nome e "mostrar inativas" chegam à API (sem parâmetro vazio)', async () => {
    renderPage();
    await screen.findByTestId('provider-name-OSDE');
    expect(api.listProviders).toHaveBeenLastCalledWith({ search: undefined, includeInactive: undefined });
    change('providers-search', ' osde ');
    await waitFor(() => expect(api.listProviders).toHaveBeenLastCalledWith({ search: 'osde', includeInactive: undefined }));
    fireEvent.click(screen.getByTestId('providers-include-inactive'));
    await waitFor(() => expect(api.listProviders).toHaveBeenLastCalledWith({ search: 'osde', includeInactive: true }));
  });

  it('busca sem resultado e lista vazia têm mensagens diferentes', async () => {
    api.listProviders.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByTestId('providers-empty')).toHaveTextContent('Ainda não há obras sociais');
    change('providers-search', 'zzz');
    await waitFor(() => expect(screen.getByTestId('providers-empty')).toHaveTextContent('Nenhuma obra social encontrada'));
  });

  it('criar só com o nome (aliases opcional vai como lista) e abrir a página de cartões', async () => {
    api.createProvider.mockResolvedValue({ code: 'NOVA_OS', name: 'Nova OS', active: true, sortOrder: 50 });
    renderPage();
    await screen.findByTestId('provider-name-OSDE');
    fireEvent.click(screen.getByTestId('providers-new'));
    change('provider-create-name', ' Nova OS ');
    change('provider-create-aliases', 'NOVA, Nova Obra ,');
    fireEvent.click(screen.getByTestId('provider-create-submit'));
    await waitFor(() => expect(api.createProvider).toHaveBeenCalledWith({ name: 'Nova OS', aliases: ['NOVA', 'Nova Obra'] }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/admin/obras-sociales/NOVA_OS');
  });

  it('só com o nome: sem alias e sem código o corpo leva apenas o name', async () => {
    api.createProvider.mockResolvedValue({ code: 'X', name: 'X', active: true, sortOrder: 1 });
    renderPage();
    await screen.findByTestId('provider-name-OSDE');
    fireEvent.click(screen.getByTestId('providers-new'));
    change('provider-create-name', 'X');
    fireEvent.click(screen.getByTestId('provider-create-submit'));
    await waitFor(() => expect(api.createProvider).toHaveBeenCalledWith({ name: 'X' }));
  });

  it('NAME_NOT_CODIFIABLE: a tela passa a pedir o código e reenvia com ele', async () => {
    api.createProvider.mockRejectedValueOnce(apiError(422, 'NAME_NOT_CODIFIABLE')).mockResolvedValueOnce({ code: 'XX', name: '###', active: true, sortOrder: 1 });
    renderPage();
    await screen.findByTestId('provider-name-OSDE');
    fireEvent.click(screen.getByTestId('providers-new'));
    expect(screen.queryByTestId('provider-create-code')).not.toBeInTheDocument();
    change('provider-create-name', '###');
    fireEvent.click(screen.getByTestId('provider-create-submit'));
    expect(await screen.findByTestId('provider-create-code')).toBeInTheDocument();
    change('provider-create-code', 'xx');
    fireEvent.click(screen.getByTestId('provider-create-submit'));
    await waitFor(() => expect(api.createProvider).toHaveBeenLastCalledWith({ name: '###', code: 'XX' }));
  });

  it('INSURANCE_PROVIDER_CODE_EXISTS (código derivado colidiu): a tela passa a pedir o código e reenvia com ele', async () => {
    api.createProvider.mockRejectedValueOnce(apiError(409, 'INSURANCE_PROVIDER_CODE_EXISTS')).mockResolvedValueOnce({ code: 'LARGO_2', name: 'Largo', active: true, sortOrder: 1 });
    renderPage();
    await screen.findByTestId('provider-name-OSDE');
    fireEvent.click(screen.getByTestId('providers-new'));
    change('provider-create-name', 'Largo');
    fireEvent.click(screen.getByTestId('provider-create-submit'));
    expect(await screen.findByTestId('provider-create-code')).toBeInTheDocument();
    change('provider-create-code', 'largo_2');
    fireEvent.click(screen.getByTestId('provider-create-submit'));
    await waitFor(() => expect(api.createProvider).toHaveBeenLastCalledWith({ name: 'Largo', code: 'LARGO_2' }));
  });

  it('nome repetido (409) vira a frase da tela', async () => {
    api.createProvider.mockRejectedValue(apiError(409, 'INSURANCE_PROVIDER_NAME_EXISTS'));
    renderPage();
    await screen.findByTestId('provider-name-OSDE');
    fireEvent.click(screen.getByTestId('providers-new'));
    change('provider-create-name', 'OSDE');
    fireEvent.click(screen.getByTestId('provider-create-submit'));
    expect(await screen.findByTestId('provider-create-error')).toHaveTextContent('Já existe uma obra social com esse nome.');
  });

  it('sem catalog_insurance_providers:create o botão Nova some', async () => {
    comCelulas(['catalog_insurance_providers:read']);
    renderPage();
    await screen.findByTestId('provider-name-OSDE');
    expect(screen.queryByTestId('providers-new')).not.toBeInTheDocument();
  });

  it('sem a célula de leitura redireciona e não chama a API', async () => {
    comCelulas(['patient:read']);
    renderPage();
    expect(await screen.findByTestId('where')).toHaveTextContent('/admin');
    expect(api.listProviders).not.toHaveBeenCalled();
  });

  it('parseAliases separa por vírgula e descarta vazios', () => {
    expect(parseAliases(' a, ,b ,, ')).toEqual(['a', 'b']);
    expect(parseAliases('')).toEqual([]);
  });
});
