/**
 * Modais por cartão (058a, pedido do Gabriel): cada "novo"/"editar" abre UMA modal do container; fechar alterado pede descarte
 * (X, Esc, clique fora e Cancelar), fechar limpo fecha direto, salvar fecha, e o erro do envio fica DENTRO da modal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { apiError, contact, contractItem, provider, semEnforcement } from './support';

vi.mock('react-i18next', async () => (await import('./support')).i18nMock);
const api = vi.hoisted(() => ({
  listContacts: vi.fn(), createContact: vi.fn(), patchContact: vi.fn(), retireContact: vi.fn(),
  listContracts: vi.fn(), createContract: vi.fn(), addTerm: vi.fn(), supersedeTerm: vi.fn(), listProvidersForService: vi.fn(),
  patchProvider: vi.fn(), listProviders: vi.fn(), createProvider: vi.fn(),
}));
vi.mock('@infrastructure/http/AdminInsuranceApiService', () => ({ AdminInsuranceApiService: api }));

const { EmployeesCard } = await import('../EmployeesCard');
const { GeneralCard } = await import('../GeneralCard');
const { ContractsCard } = await import('../ContractsCard');
const { default: ProvidersPage } = await import('../../InsuranceProvidersPage');

beforeEach(() => {
  vi.clearAllMocks();
  semEnforcement();
  api.listContacts.mockResolvedValue([contact()]);
  api.listContracts.mockResolvedValue([contractItem()]);
  api.listProviders.mockResolvedValue([]);
  api.listProvidersForService.mockResolvedValue({ providers: [], asOf: '2026-10-19' });
});

const change = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });
const discard = () => screen.queryByTestId('discard-changes-confirm');

/** A mesma bateria para as 6 modais: dialog aberto, limpo fecha direto, sujo pede descarte por TODAS as saídas. */
function fechamento(opts: { abrir: () => Promise<void>; modal: string; sujar: () => void; cancelar: string }) {
  it('abre em dialog e fecha direto quando nada mudou (X, Esc, fora, Cancelar)', async () => {
    for (const how of ['x', 'esc', 'fora', 'cancelar'] as const) {
      cleanup();
      await opts.abrir();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      if (how === 'x') fireEvent.click(screen.getByTestId(`${opts.modal}-close`));
      if (how === 'esc') fireEvent.keyDown(document, { key: 'Escape' });
      if (how === 'fora') fireEvent.click(screen.getByTestId(`${opts.modal}-overlay`));
      if (how === 'cancelar') fireEvent.click(screen.getByTestId(opts.cancelar));
      expect(discard()).not.toBeInTheDocument();
      await waitFor(() => expect(screen.queryByTestId(opts.modal)).not.toBeInTheDocument());
    }
  });

  it('com alteração, cada saída pede descarte; "seguir editando" mantém os dados; "descartar" fecha', async () => {
    await opts.abrir();
    opts.sujar();
    for (const how of ['x', 'esc', 'fora', 'cancelar'] as const) {
      if (how === 'x') fireEvent.click(screen.getByTestId(`${opts.modal}-close`));
      if (how === 'esc') fireEvent.keyDown(document, { key: 'Escape' });
      if (how === 'fora') fireEvent.click(screen.getByTestId(`${opts.modal}-overlay`));
      if (how === 'cancelar') fireEvent.click(screen.getByTestId(opts.cancelar));
      expect(discard()).toBeInTheDocument();
      expect(screen.getByTestId(opts.modal)).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
      expect(discard()).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId(`${opts.modal}-close`));
    fireEvent.click(screen.getByTestId('discard-changes-discard'));
    await waitFor(() => expect(screen.queryByTestId(opts.modal)).not.toBeInTheDocument());
  });
}

describe('modal Empregado (novo)', () => {
  const abrir = async () => { render(<EmployeesCard code="OSDE" />); fireEvent.click(await screen.findByTestId('employees-new')); };
  fechamento({ abrir, modal: 'contact-form', cancelar: 'contact-cancel', sujar: () => change('contact-fullName', 'Fulana') });

  it('salvar fecha a modal e recarrega a lista; a lista nunca ganha formulário inline', async () => {
    api.createContact.mockResolvedValue(contact({ id: 'c2' }));
    await abrir();
    expect(screen.getByTestId('employees-table')).not.toContainElement(screen.getByTestId('contact-form'));
    change('contact-fullName', 'Fulana'); change('contact-roleTitle', 'Auditora'); change('contact-phone', '1');
    fireEvent.click(screen.getByTestId('contact-save'));
    await waitFor(() => expect(screen.queryByTestId('contact-form')).not.toBeInTheDocument());
    expect(discard()).not.toBeInTheDocument();
    await waitFor(() => expect(api.listContacts).toHaveBeenCalledTimes(2));
  });

  it('erro 422 do envio aparece DENTRO da modal, que continua aberta com os dados', async () => {
    api.createContact.mockRejectedValue(apiError(422, 'DOCUMENT_PAIR_INCOMPLETE'));
    await abrir();
    change('contact-fullName', 'Fulana'); change('contact-roleTitle', 'Auditora'); change('contact-phone', '1');
    fireEvent.click(screen.getByTestId('contact-save'));
    const err = await screen.findByTestId('contact-error');
    expect(screen.getByTestId('contact-form')).toContainElement(err);
    expect(screen.getByTestId('contact-fullName')).toHaveValue('Fulana');
  });
});

describe('rodapé fixo', () => {
  it('Cancelar/Salvar e o erro do envio ficam no rodapé, fora do corpo rolável', async () => {
    api.createContact.mockRejectedValue(apiError(422, 'DOCUMENT_PAIR_INCOMPLETE'));
    render(<EmployeesCard code="OSDE" />);
    fireEvent.click(await screen.findByTestId('employees-new'));
    change('contact-fullName', 'F'); change('contact-roleTitle', 'A'); change('contact-phone', '1');
    fireEvent.click(screen.getByTestId('contact-save'));
    const footer = screen.getByTestId('contact-form-footer');
    expect(footer).toContainElement(screen.getByTestId('contact-save'));
    expect(footer).toContainElement(screen.getByTestId('contact-cancel'));
    expect(footer).toContainElement(await screen.findByTestId('contact-error'));
    expect(footer).not.toContainElement(screen.getByTestId('contact-fullName'));
  });
});

describe('modal Empregado (editar)', () => {
  it('abre com os dados do contato; sem mudar nada, fecha direto', async () => {
    render(<EmployeesCard code="OSDE" />);
    fireEvent.click(await screen.findByTestId('employee-edit-c1'));
    expect(screen.getByTestId('contact-fullName')).toHaveValue('Pessoa Teste');
    fireEvent.click(screen.getByTestId('contact-form-close'));
    await waitFor(() => expect(screen.queryByTestId('contact-form')).not.toBeInTheDocument());
    expect(discard()).not.toBeInTheDocument();
  });
  it('voltar ao valor original não conta como alteração', async () => {
    render(<EmployeesCard code="OSDE" />);
    fireEvent.click(await screen.findByTestId('employee-edit-c1'));
    change('contact-roleTitle', 'Outro'); change('contact-roleTitle', 'Gerente operacional');
    fireEvent.click(screen.getByTestId('contact-form-close'));
    expect(discard()).not.toBeInTheDocument();
  });
});

describe('modal Dados gerais (editar)', () => {
  const abrir = async () => { render(<GeneralCard provider={provider()} onSaved={vi.fn()} editRequest={0} />); fireEvent.click(screen.getByTestId('provider-general-edit')); };
  fechamento({ abrir, modal: 'provider-general-modal', cancelar: 'provider-general-cancel', sujar: () => change('provider-general-taxId-input', '30-1') });

  it('salvar fecha a modal e entrega o provider atualizado ao cartão', async () => {
    const onSaved = vi.fn();
    api.patchProvider.mockResolvedValue(provider({ taxId: '30-1' }));
    render(<GeneralCard provider={provider()} onSaved={onSaved} editRequest={0} />);
    fireEvent.click(screen.getByTestId('provider-general-edit'));
    change('provider-general-taxId-input', '30-1');
    fireEvent.click(screen.getByTestId('provider-general-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.queryByTestId('provider-general-modal')).not.toBeInTheDocument();
  });

  it('erro 409/422 fica dentro da modal', async () => {
    api.patchProvider.mockRejectedValue(apiError(422, 'PAYER_KIND_CANNOT_UNSET'));
    render(<GeneralCard provider={provider()} onSaved={vi.fn()} editRequest={0} />);
    fireEvent.click(screen.getByTestId('provider-general-edit'));
    change('provider-general-taxId-input', '30-1');
    fireEvent.click(screen.getByTestId('provider-general-save'));
    const err = await screen.findByTestId('provider-general-error');
    expect(within(screen.getByTestId('provider-general-modal')).getByTestId('provider-general-error')).toBe(err);
  });
});

describe('modal Contrato + 1º termo (novo)', () => {
  const abrir = async () => { render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />); fireEvent.click(await screen.findByTestId('contracts-new')); };
  fechamento({ abrir, modal: 'contract-new-form', cancelar: 'contract-new-cancel', sujar: () => change('contract-new-name', 'Novo') });

  it('PAYER_KIND_REQUIRED: o erro e o botão "Ir para Dados gerais" ficam na modal; o botão avisa o pai e a modal do contrato segue aberta com o que foi digitado', async () => {
    api.createContract.mockRejectedValue(apiError(422, 'PAYER_KIND_REQUIRED'));
    const go = vi.fn();
    render(<ContractsCard code="OSDE" onGoToGeneral={go} />);
    fireEvent.click(await screen.findByTestId('contracts-new'));
    change('contract-new-name', 'Novo'); change('contract-new-country', 'AR');
    await waitFor(() => expect(screen.getByTestId('contract-new-hourly-rate')).toBeInTheDocument());
    change('contract-new-hourly-rate', '100'); change('contract-new-tax-rate', '0');
    fireEvent.click(screen.getByTestId('contract-new-submit'));
    const action = await screen.findByTestId('contracts-payer-kind-required');
    expect(screen.getByTestId('contract-new-form')).toContainElement(action);
    fireEvent.click(screen.getByTestId('contracts-go-general'));
    expect(go).toHaveBeenCalled();
    expect(screen.getByTestId('contract-new-name')).toHaveValue('Novo');
  });
});

describe('modal Novo termo / Corrigir termo', () => {
  const abrirNovo = async () => { render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />); fireEvent.click(await screen.findByTestId('contract-k1-new-term')); };
  const abrirCorrigir = async () => { render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />); fireEvent.click(await screen.findByTestId('contract-k1-current-correct')); };
  describe('novo termo', () => {
      fechamento({ abrir: abrirNovo, modal: 'contract-k1-term-form', cancelar: 'contract-k1-term-cancel', sujar: () => change('contract-k1-term-tax-rate', '21') });
    it('salvar fecha a modal e recarrega os contratos', async () => {
      api.supersedeTerm.mockResolvedValue({});
      await abrirNovo();
      change('contract-k1-term-hourly-rate', '1800'); change('contract-k1-term-tax-rate', '21');
      fireEvent.click(screen.getByTestId('contract-k1-term-submit'));
      await waitFor(() => expect(screen.queryByTestId('contract-k1-term-form')).not.toBeInTheDocument());
      await waitFor(() => expect(api.listContracts).toHaveBeenCalledTimes(2));
    });
    it('erro do envio fica dentro da modal', async () => {
      api.supersedeTerm.mockRejectedValue(apiError(409, 'TERM_OVERLAP'));
      await abrirNovo();
      change('contract-k1-term-hourly-rate', '1800'); change('contract-k1-term-tax-rate', '21');
      fireEvent.click(screen.getByTestId('contract-k1-term-submit'));
      const err = await screen.findByTestId('contract-k1-term-error');
      expect(screen.getByTestId('contract-k1-term-form')).toContainElement(err);
    });
  });
  describe('corrigir termo', () => {
      fechamento({ abrir: abrirCorrigir, modal: 'contract-k1-correct-form', cancelar: 'contract-k1-correct-cancel', sujar: () => change('contract-k1-correct-tax-rate', '10') });
  });
});

describe('modal Nova obra social (lista)', () => {
  const abrir = async () => { render(<MemoryRouter><ProvidersPage /></MemoryRouter>); fireEvent.click(await screen.findByTestId('providers-new')); };
  fechamento({ abrir, modal: 'provider-create-form', cancelar: 'provider-create-cancel', sujar: () => change('provider-create-name', 'Nova OS') });

  it('NAME_NOT_CODIFIABLE: o pedido do código aparece dentro da modal, que segue aberta', async () => {
    api.createProvider.mockRejectedValue(apiError(422, 'NAME_NOT_CODIFIABLE'));
    await abrir();
    change('provider-create-name', '???');
    fireEvent.click(screen.getByTestId('provider-create-submit'));
    const code = await screen.findByTestId('provider-create-code');
    expect(screen.getByTestId('provider-create-form')).toContainElement(code);
    expect(screen.getByTestId('provider-create-error')).toBeInTheDocument();
  });
});
