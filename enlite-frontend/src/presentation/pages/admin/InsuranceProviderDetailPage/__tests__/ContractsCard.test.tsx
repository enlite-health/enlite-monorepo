/** ContractsCard — lista, NO_TERM, termos futuros, preço redigido, novo contrato + 1º termo, novo termo e o link do PAYER_KIND_REQUIRED. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { apiError, comCelulas, contractItem, okTerm, semEnforcement } from './support';

vi.mock('react-i18next', async () => (await import('./support')).i18nMock);
const api = vi.hoisted(() => ({
  listContracts: vi.fn(), createContract: vi.fn(), addTerm: vi.fn(), supersedeTerm: vi.fn(), listProvidersForService: vi.fn(),
}));
vi.mock('@infrastructure/http/AdminInsuranceApiService', () => ({ AdminInsuranceApiService: api }));

const { ContractsCard } = await import('../ContractsCard');

beforeEach(() => {
  vi.clearAllMocks();
  semEnforcement();
  api.listContracts.mockResolvedValue([contractItem()]);
  api.listProvidersForService.mockResolvedValue({ providers: [], asOf: '2026-10-19' });
});

const change = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });

describe('ContractsCard — lista', () => {
  it('mostra nome, país, abrangência e o termo vigente com valor-hora e imposto em %', async () => {
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    expect(await screen.findByTestId('contract-k1-name')).toHaveTextContent('Contrato Buenos Aires');
    expect(screen.getByTestId('contract-k1-country')).toHaveTextContent('Argentina');
    expect(screen.getByTestId('contract-k1-scope')).toHaveTextContent('Região metropolitana');
    expect(screen.getByTestId('contract-k1-current-price')).toHaveTextContent(/1\.?500/);
    expect(screen.getByTestId('contract-k1-current-tax')).toHaveTextContent('21');
    expect(screen.getByTestId('contract-k1-current-validity')).toHaveTextContent('desde 01/01/2026, sem data final');
  });

  it('NO_TERM = "sem termo vigente hoje" + a contagem e a lista dos termos futuros', async () => {
    api.listContracts.mockResolvedValue([contractItem({ currentTerm: { state: 'NO_TERM' }, futureTerms: [okTerm({ termId: 'f1', validFrom: '2026-12-01' })] })]);
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    expect(await screen.findByTestId('contract-k1-no-term')).toHaveTextContent('Sem termo vigente hoje');
    expect(screen.queryByTestId('contract-k1-current')).not.toBeInTheDocument();
    expect(screen.getByTestId('contract-k1-future-count')).toHaveTextContent('Termos futuros: 1');
    expect(screen.getByTestId('contract-k1-future-f1-validity')).toHaveTextContent('01/12/2026');
  });

  it('preço redigido aparece como frase (nunca um número), e o imposto continua visível', async () => {
    api.listContracts.mockResolvedValue([contractItem({ currentTerm: okTerm({ price: { state: 'REDACTED' } }) })]);
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    expect(await screen.findByTestId('contract-k1-current-price')).not.toHaveTextContent(/\d/);
    expect(screen.getByTestId('contract-k1-current-tax')).toHaveTextContent('21');
  });

  it('imposto 0 é exibido como "isento", não "0 %"', async () => {
    api.listContracts.mockResolvedValue([contractItem({ currentTerm: okTerm({ taxRatePercent: 0 }) })]);
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    expect(await screen.findByTestId('contract-k1-current-tax')).toHaveTextContent(/isento/i);
  });

  it('sem a célula de leitura: "sem permissão", nenhuma chamada à API', () => {
    comCelulas(['insurance_contracts:create']);
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    expect(screen.getByTestId('contracts-no-permission')).toBeInTheDocument();
    expect(api.listContracts).not.toHaveBeenCalled();
  });

  it('lista vazia tem mensagem própria', async () => {
    api.listContracts.mockResolvedValue([]);
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    expect(await screen.findByTestId('contracts-empty')).toBeInTheDocument();
  });
});

describe('ContractsCard — novo contrato + 1º termo', () => {
  async function openForm() {
    render(<ContractsCard code="OSDE" onGoToGeneral={onGoToGeneral} />);
    await screen.findByTestId('contract-k1-name');
    fireEvent.click(screen.getByTestId('contracts-new'));
  }
  const onGoToGeneral = vi.fn();

  it('o "hoje" do país vem da API (for-service) ao escolher o país e vira o início do 1º termo', async () => {
    await openForm();
    expect(screen.getByTestId('contract-new-as-of-loading')).toBeInTheDocument();
    change('contract-new-country', 'BR');
    await waitFor(() => expect(api.listProvidersForService).toHaveBeenCalledWith('BR'));
    await waitFor(() => expect(screen.getByTestId('contract-new-valid-from')).toHaveValue('2026-10-19'));
    expect(screen.getByTestId('contract-new-valid-from')).toHaveAttribute('min', '2026-10-19');
    expect(screen.getByTestId('contract-new-tax-rate')).toHaveValue(null);
  });

  it('envia contrato + firstTerm com o imposto digitado', async () => {
    api.createContract.mockResolvedValue(contractItem({ id: 'k2' }));
    await openForm();
    change('contract-new-name', ' Contrato SP ');
    change('contract-new-country', 'BR');
    await waitFor(() => expect(screen.getByTestId('contract-new-valid-from')).toHaveValue('2026-10-19'));
    change('contract-new-hourly-rate', '80');
    change('contract-new-tax-rate', '0');
    fireEvent.click(screen.getByTestId('contract-new-submit'));
    await waitFor(() => expect(api.createContract).toHaveBeenCalledWith('OSDE', {
      name: 'Contrato SP', country: 'BR', firstTerm: { hourlyRate: 80, taxRatePercent: 0, validFrom: '2026-10-19' },
    }));
  });

  it('imposto vazio impede o envio', async () => {
    await openForm();
    change('contract-new-name', 'X');
    change('contract-new-country', 'AR');
    await waitFor(() => expect(screen.getByTestId('contract-new-valid-from')).toHaveValue('2026-10-19'));
    change('contract-new-hourly-rate', '80');
    fireEvent.click(screen.getByTestId('contract-new-submit'));
    expect(api.createContract).not.toHaveBeenCalled();
    expect(screen.getByText('Informe o imposto. Digite 0 se for isento.')).toBeInTheDocument();
  });

  it('PAYER_KIND_REQUIRED mostra o texto da spec e um link que leva ao cartão Dados gerais', async () => {
    api.createContract.mockRejectedValue(apiError(422, 'PAYER_KIND_REQUIRED'));
    await openForm();
    change('contract-new-name', 'X');
    change('contract-new-country', 'AR');
    await waitFor(() => expect(screen.getByTestId('contract-new-valid-from')).toHaveValue('2026-10-19'));
    change('contract-new-hourly-rate', '80');
    change('contract-new-tax-rate', '21');
    fireEvent.click(screen.getByTestId('contract-new-submit'));
    expect(await screen.findByTestId('contract-new-error')).toHaveTextContent('Classifique o tipo do pagador (obra social, prepaga ou particular) em Dados gerais antes de criar contrato.');
    fireEvent.click(screen.getByTestId('contracts-go-general'));
    expect(onGoToGeneral).toHaveBeenCalledTimes(1);
  });

  it('sem patient_contract_value:create (o 1º termo exige) o botão Novo contrato some', () => {
    comCelulas(['insurance_contracts:read', 'insurance_contracts:create']);
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    expect(screen.queryByTestId('contracts-new')).not.toBeInTheDocument();
  });
});

describe('ContractsCard — novo termo', () => {
  it('sobre termo vigente é reajuste (supersede REPRICED), com o asOf do contrato como início e mínimo', async () => {
    api.supersedeTerm.mockResolvedValue(contractItem());
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-k1-new-term'));
    const from = screen.getByTestId('contract-k1-term-valid-from');
    expect(from).toHaveValue('2026-10-19');
    expect(from).toHaveAttribute('min', '2026-10-19');
    expect(screen.getByTestId('contract-k1-term-tax-rate')).toHaveValue(null);
    change('contract-k1-term-hourly-rate', '1800');
    change('contract-k1-term-tax-rate', '10.5');
    fireEvent.click(screen.getByTestId('contract-k1-term-submit'));
    await waitFor(() => expect(api.supersedeTerm).toHaveBeenCalledWith('k1', 't1', {
      reason: 'REPRICED', hourlyRate: 1800, taxRatePercent: 10.5, validFrom: '2026-10-19',
    }));
    expect(api.addTerm).not.toHaveBeenCalled();
  });

  it('sobre contrato sem termo vigente (NO_TERM) é um termo novo simples', async () => {
    api.listContracts.mockResolvedValue([contractItem({ currentTerm: { state: 'NO_TERM' } })]);
    api.addTerm.mockResolvedValue(contractItem());
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-k1-new-term'));
    change('contract-k1-term-hourly-rate', '1800');
    change('contract-k1-term-tax-rate', '0');
    fireEvent.click(screen.getByTestId('contract-k1-term-submit'));
    await waitFor(() => expect(api.addTerm).toHaveBeenCalledWith('k1', { hourlyRate: 1800, taxRatePercent: 0, validFrom: '2026-10-19' }));
  });

  it('sobreposição de vigência (23P01 → 409) mostra a frase da constraint no formulário do termo', async () => {
    api.supersedeTerm.mockRejectedValue(apiError(409, 'RANGE_OVERLAP', { constraint: 'insurance_contract_terms_sem_sobreposicao' }));
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-k1-new-term'));
    change('contract-k1-term-hourly-rate', '1800');
    change('contract-k1-term-tax-rate', '5');
    fireEvent.click(screen.getByTestId('contract-k1-term-submit'));
    expect(await screen.findByTestId('contract-k1-term-error')).toHaveTextContent('se sobrepõe a outro termo de valor do mesmo contrato');
  });
});

describe('ContractsCard — corrigir termo', () => {
  it('corrige o termo vivo com CORRECTION: parte do valor e da vigência dele, imposto VAZIO e obrigatório', async () => {
    api.supersedeTerm.mockResolvedValue(contractItem());
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-k1-current-correct'));
    expect(screen.getByTestId('contract-k1-correct-hourly-rate')).toHaveValue(1500);
    expect(screen.getByTestId('contract-k1-correct-valid-from')).toHaveValue('2026-01-01');
    // corrigir não é termo novo: sem data mínima e sem aviso de retroativo
    expect(screen.getByTestId('contract-k1-correct-valid-from')).not.toHaveAttribute('min');
    expect(screen.getByTestId('contract-k1-correct-tax-rate')).toHaveValue(null);
    fireEvent.click(screen.getByTestId('contract-k1-correct-submit'));
    expect(api.supersedeTerm).not.toHaveBeenCalled();
    expect(screen.getByText('Informe o imposto. Digite 0 se for isento.')).toBeInTheDocument();
    change('contract-k1-correct-hourly-rate', '1600');
    change('contract-k1-correct-tax-rate', '0');
    fireEvent.click(screen.getByTestId('contract-k1-correct-submit'));
    await waitFor(() => expect(api.supersedeTerm).toHaveBeenCalledWith('k1', 't1', {
      reason: 'CORRECTION', hourlyRate: 1600, taxRatePercent: 0, validFrom: '2026-01-01', validTo: null,
    }));
    expect(api.addTerm).not.toHaveBeenCalled();
  });

  it('também corrige um termo futuro (pelo id dele)', async () => {
    api.listContracts.mockResolvedValue([contractItem({ futureTerms: [okTerm({ termId: 'f1', validFrom: '2027-01-01', validTo: '2027-06-30' })] })]);
    api.supersedeTerm.mockResolvedValue(contractItem());
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-k1-future-f1-correct'));
    change('contract-k1-correct-tax-rate', '10');
    fireEvent.click(screen.getByTestId('contract-k1-correct-submit'));
    await waitFor(() => expect(api.supersedeTerm).toHaveBeenCalledWith('k1', 'f1', expect.objectContaining({ reason: 'CORRECTION', validFrom: '2027-01-01', validTo: '2027-06-30' })));
  });

  it('409 (termo já substituído) e 422 (vigência inválida) viram frase da tela no formulário', async () => {
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-k1-current-correct'));
    change('contract-k1-correct-tax-rate', '5');
    api.supersedeTerm.mockRejectedValueOnce(apiError(409, 'TERM_ALREADY_SUPERSEDED'));
    fireEvent.click(screen.getByTestId('contract-k1-correct-submit'));
    expect(await screen.findByTestId('contract-k1-correct-error')).toHaveTextContent('Esse termo já foi substituído. Recarregue a lista.');
    api.supersedeTerm.mockRejectedValueOnce(apiError(422, 'TERM_RANGE_INVALID'));
    fireEvent.click(screen.getByTestId('contract-k1-correct-submit'));
    await waitFor(() => expect(screen.getByTestId('contract-k1-correct-error')).toHaveTextContent('A vigência do termo é inválida.'));
  });

  it('sem patient_contract_value:create o botão Corrigir termo some', async () => {
    comCelulas(['insurance_contracts:read']);
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    await screen.findByTestId('contract-k1-name');
    expect(screen.queryByTestId('contract-k1-current-correct')).not.toBeInTheDocument();
  });
});

describe('ContractsCard — obra social "Otra" (OTHER)', () => {
  it('não oferece "Novo contrato", não lista nem consulta contratos, e explica por quê (sem pedir classificar o pagador)', async () => {
    render(<ContractsCard code="OTHER" onGoToGeneral={vi.fn()} />);
    expect(screen.getByTestId('contracts-other-not-applicable')).toHaveTextContent('não tem contratos');
    expect(screen.queryByTestId('contracts-new')).not.toBeInTheDocument();
    expect(screen.queryByTestId('contracts-go-general')).not.toBeInTheDocument();
    expect(api.listContracts).not.toHaveBeenCalled();
  });

  it('as outras obras sociais seguem com "Novo contrato"', async () => {
    render(<ContractsCard code="OSDE" onGoToGeneral={vi.fn()} />);
    expect(await screen.findByTestId('contracts-new')).toBeInTheDocument();
    expect(screen.queryByTestId('contracts-other-not-applicable')).not.toBeInTheDocument();
  });
});
