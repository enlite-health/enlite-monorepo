import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustosDetalhe } from '../CustosDetalhe';
import { niceMax } from '../custosDerive';
import { GEOCODING, overview, usarIdioma } from './custosTestUtils';

describe('CustosDetalhe (A2)', () => {
  beforeEach(async () => { await usarIdioma('pt-BR'); });

  it('"No mês" = byService[nome].total (123,45 na fixture), NUNCA a soma da série', () => {
    render(<CustosDetalhe ov={overview({ byService: [{ service: 'Geocoding API', total: 123.45 }] })} item={GEOCODING} onVoltar={() => {}} />);
    const somaDaSerie = GEOCODING.detail!.monthSeries.reduce((s, p) => s + p.value, 0);
    expect(somaDaSerie).not.toBeCloseTo(123.45, 1);
    expect(screen.getByTestId('custos-detalhe-no-mes')).toHaveTextContent(/US\$\s?123,45/);
  });

  it('tabela: aumento, parte do aumento 92,0% (35,05 ÷ 38,10), "maior contribuinte" só na 1ª linha, "sem recurso" traduzido', () => {
    render(<CustosDetalhe ov={overview()} item={GEOCODING} onVoltar={() => {}} />);
    const linhas = screen.getAllByTestId('custos-detalhe-linha');
    expect(linhas).toHaveLength(3);
    expect(linhas[0]).toHaveTextContent('clickup-patient-sync-safety-net-job');
    expect(linhas[0].textContent).toMatch(/\+US\$\s?35,05/);
    expect(linhas[0]).toHaveTextContent('92,0%');
    expect(within(linhas[0]).getByTestId('custos-selo-maior')).toHaveTextContent('maior contribuinte');
    expect(screen.getAllByTestId('custos-selo-maior')).toHaveLength(1);
    expect(linhas[2]).toHaveTextContent('sem recurso');
    expect(screen.getByText('Quem explica o aumento do dia 17')).toBeInTheDocument();
    expect(screen.getByText('Maior contribuinte é uma pista de onde olhar, não a causa confirmada.')).toBeInTheDocument();
  });

  it('gráfico: role=img com o fato; "Voltar ao painel" chama o callback', async () => {
    const onVoltar = vi.fn();
    render(<CustosDetalhe ov={overview()} item={GEOCODING} onVoltar={onVoltar} />);
    expect(screen.getByRole('img', { name: /Geocoding API, custo diário de 01\/10 a 17\/10: mediana 3,10 e 41,20 no último dia/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Voltar ao painel/ }));
    expect(onVoltar).toHaveBeenCalledTimes(1);
  });

  it('item sem detail não abre nada', () => {
    const { container } = render(<CustosDetalhe ov={overview()} item={{ ...GEOCODING, detail: undefined }} onVoltar={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('niceMax: teto redondo do eixo (45 para 41,20; nunca 0)', () => {
    expect(niceMax(41.2)).toBe(45);
    expect(niceMax(0)).toBe(1);
    expect(niceMax(3)).toBe(3);
  });
});
