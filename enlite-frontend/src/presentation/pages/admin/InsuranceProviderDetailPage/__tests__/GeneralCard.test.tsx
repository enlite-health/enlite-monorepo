/** GeneralCard — Dados gerais: PATCH só com o que mudou, `null` limpa, constraint vira frase, tipo do pagador não volta a "sem classificar". */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { apiError, comCelulas, provider, semEnforcement } from './support';

vi.mock('react-i18next', async () => (await import('./support')).i18nMock);
const api = vi.hoisted(() => ({ patchProvider: vi.fn() }));
vi.mock('@infrastructure/http/AdminInsuranceApiService', () => ({ AdminInsuranceApiService: api }));

const { GeneralCard } = await import('../GeneralCard');
const { buildGeneralPatch } = await import('../generalDraft');

beforeEach(() => {
  vi.clearAllMocks();
  semEnforcement();
});

function renderCard(over = {}, onSaved = vi.fn(), editRequest = 0) {
  render(<GeneralCard provider={provider(over)} onSaved={onSaved} editRequest={editRequest} />);
  return onSaved;
}
const change = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });

describe('GeneralCard', () => {
  it('mostra os campos com "Não informado" nos vazios e o tipo do pagador sem classificar', () => {
    renderCard({ legalName: 'Obra Social SA' });
    expect(screen.getByTestId('provider-general-legalName')).toHaveTextContent('Obra Social SA');
    expect(screen.getByTestId('provider-general-taxId')).toHaveTextContent('Não informado');
    expect(screen.getByTestId('provider-general-payerKind')).toHaveTextContent('Sem classificar');
    expect(screen.getByTestId('provider-general-code')).toHaveTextContent('OSDE');
  });

  it('edita e envia SÓ o que mudou; campo opcional que continua vazio fica fora', async () => {
    api.patchProvider.mockResolvedValue(provider({ taxId: '30-12345678-9', payerKind: 'PREPAGA' }));
    const onSaved = renderCard();
    fireEvent.click(screen.getByTestId('provider-general-edit'));
    change('provider-general-taxId-input', '  30-12345678-9 ');
    change('provider-general-payerKind-input', 'PREPAGA');
    fireEvent.click(screen.getByTestId('provider-general-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.patchProvider).toHaveBeenCalledWith('OSDE', { taxId: '30-12345678-9', payerKind: 'PREPAGA' });
  });

  it('apagar um opcional manda null (limpa); nunca string vazia', () => {
    const body = buildGeneralPatch(provider({ address: 'Calle 1' }), {
      name: 'OSDE', legalName: '', taxId: '', address: '', managementChatId: '', payerKind: '', active: true,
    });
    expect(body).toEqual({ address: null });
  });

  it('constraint do banco vira a frase da tela, sem o texto cru do back', async () => {
    api.patchProvider.mockRejectedValue(apiError(422, 'INVALID_insurance_providers_private_kind_chk'));
    renderCard({ code: 'PRIVATE', name: 'Particular', payerKind: 'PRIVATE' });
    fireEvent.click(screen.getByTestId('provider-general-edit'));
    change('provider-general-address-input', 'Rua');
    fireEvent.click(screen.getByTestId('provider-general-save'));
    expect(await screen.findByTestId('provider-general-error')).toHaveTextContent('só pode ter o tipo de pagador');
  });

  it('409 de CUIT repetido não ecoa o valor', async () => {
    api.patchProvider.mockRejectedValue(apiError(409, 'INSURANCE_PROVIDER_TAX_ID_EXISTS'));
    renderCard();
    fireEvent.click(screen.getByTestId('provider-general-edit'));
    change('provider-general-taxId-input', '30-1');
    fireEvent.click(screen.getByTestId('provider-general-save'));
    expect(await screen.findByTestId('provider-general-error')).toHaveTextContent('Já existe uma obra social com esse CUIT/CNPJ.');
  });

  it('depois de classificado não existe a opção "sem classificar"', () => {
    renderCard({ payerKind: 'OBRA_SOCIAL' });
    fireEvent.click(screen.getByTestId('provider-general-edit'));
    const options = Array.from(screen.getByTestId('provider-general-payerKind-input').querySelectorAll('option')).map((o) => o.textContent);
    expect(options).not.toContain('Sem classificar');
    expect(options).toContain('Prepaga');
  });

  it('sem a célula de update o botão Editar some (engine ligado)', () => {
    comCelulas(['catalog_insurance_providers:read']);
    renderCard();
    expect(screen.queryByTestId('provider-general-edit')).not.toBeInTheDocument();
  });

  it('o pedido externo de edição (link do cartão Contratos) abre o formulário', () => {
    renderCard({}, vi.fn(), 1);
    expect(screen.getByTestId('provider-general-form')).toBeInTheDocument();
  });
});
