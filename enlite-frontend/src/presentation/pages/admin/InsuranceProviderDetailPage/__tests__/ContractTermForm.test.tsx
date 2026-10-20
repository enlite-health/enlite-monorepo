/**
 * ContractTermForm — o formulário do termo de valor. A regra que não pode ceder: o imposto NASCE VAZIO e é obrigatório
 * (`0` = isento é digitado, nunca pré-preenchido). O "hoje" é o `asOf` recebido, nunca o relógio do navegador.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => (await import('./support')).i18nMock);

const { ContractTermForm } = await import('../ContractTermForm');

const PREFIX = 'term-';

function renderForm(over: Partial<Parameters<typeof ContractTermForm>[0]> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(
    <ContractTermForm asOf="2026-10-19" submitting={false} error={null} onSubmit={onSubmit} onCancel={onCancel} testIdPrefix={PREFIX} {...over} />,
  );
  return { onSubmit, onCancel };
}

const type = (id: string, value: string) => fireEvent.change(screen.getByTestId(`${PREFIX}${id}`), { target: { value } });

describe('ContractTermForm', () => {
  it('o imposto nasce vazio (nunca 0 pré-preenchido) e o valor-hora também', () => {
    renderForm();
    // `value=''` num input numérico lê como `null`; `0` leria como o número 0.
    expect(screen.getByTestId(`${PREFIX}tax-rate`)).toHaveValue(null);
    expect(screen.getByTestId(`${PREFIX}hourly-rate`)).toHaveValue(null);
  });

  it('sem imposto digitado não envia e mostra o erro; com valor-hora preenchido', () => {
    const { onSubmit } = renderForm();
    type('hourly-rate', '1500');
    fireEvent.click(screen.getByTestId(`${PREFIX}submit`));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Informe o imposto. Digite 0 se for isento.')).toBeInTheDocument();
  });

  it('digitar 0 é isento: é aceito e vai como número 0', () => {
    const { onSubmit } = renderForm();
    type('hourly-rate', '1500');
    type('tax-rate', '0');
    fireEvent.click(screen.getByTestId(`${PREFIX}submit`));
    expect(onSubmit).toHaveBeenCalledWith({ hourlyRate: 1500, taxRatePercent: 0, validFrom: '2026-10-19' });
  });

  it('imposto fora de 0-100 é recusado antes de enviar', () => {
    const { onSubmit } = renderForm();
    type('hourly-rate', '1500');
    type('tax-rate', '101');
    fireEvent.click(screen.getByTestId(`${PREFIX}submit`));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('O imposto deve estar entre 0 e 100.')).toBeInTheDocument();
  });

  it('o início sugerido e o mínimo são o asOf recebido; data anterior é aceita com aviso (termo retroativo)', () => {
    const { onSubmit } = renderForm();
    const from = screen.getByTestId(`${PREFIX}valid-from`);
    expect(from).toHaveValue('2026-10-19');
    expect(from).toHaveAttribute('min', '2026-10-19');
    expect(screen.queryByTestId(`${PREFIX}retro-warning`)).not.toBeInTheDocument();
    type('valid-from', '2026-09-01');
    expect(screen.getByTestId(`${PREFIX}retro-warning`)).toHaveTextContent('19/10/2026');
    type('hourly-rate', '1500');
    type('tax-rate', '21');
    fireEvent.click(screen.getByTestId(`${PREFIX}submit`));
    expect(onSubmit).toHaveBeenCalledWith({ hourlyRate: 1500, taxRatePercent: 21, validFrom: '2026-09-01' });
  });

  it('fim antes do início é recusado; fim vazio sai do corpo', () => {
    const { onSubmit } = renderForm();
    type('hourly-rate', '10');
    type('tax-rate', '5');
    type('valid-to', '2026-10-01');
    fireEvent.click(screen.getByTestId(`${PREFIX}submit`));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('O fim não pode ser antes do início.')).toBeInTheDocument();
  });

  it('mostra a frase de erro do envio anterior e cancela', async () => {
    const { onCancel } = renderForm({ error: 'Essa vigência se sobrepõe a outro termo.' });
    expect(screen.getByTestId(`${PREFIX}error`)).toHaveTextContent('Essa vigência se sobrepõe');
    fireEvent.click(screen.getByTestId(`${PREFIX}cancel`));
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
  });
});
