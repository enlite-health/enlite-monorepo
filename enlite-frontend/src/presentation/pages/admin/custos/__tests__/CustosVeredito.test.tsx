import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustosVeredito } from '../CustosVeredito';
import { GEOCODING, MARIA, overview, usarIdioma } from './custosTestUtils';

const onDetalhe = vi.fn();
const montar = (ov = overview()) => render(<CustosVeredito ov={ov} onDetalhe={onDetalhe} />);

describe('CustosVeredito', () => {
  beforeEach(async () => { onDetalhe.mockReset(); await usarIdioma('pt-BR'); });

  it('"N coisas fora do normal" conta também o item novo; mostra a regra com os números do payload e o dia', () => {
    montar();
    expect(screen.getByTestId('custos-veredito-titulo')).toHaveTextContent('2 coisas fora do normal');
    const regra = screen.getByTestId('custos-regra').textContent ?? '';
    expect(regra).toContain('17/10/2026');
    expect(regra).toContain('pelo menos 2× a mediana dos 7 dias anteriores');
    expect(regra).toMatch(/US\$\s?5,00/);
  });

  it('D2: mês fechado = UMA linha neutra, sem "nada fora do normal" nem "histórico insuficiente"', () => {
    montar(overview({ anomalies: { status: 'not_applicable' as const, day: null, rule: { factor: 2, minDelta: 5, windowDays: 7 }, items: [] } }));
    const linha = screen.getByTestId('custos-anomalias-mes-fechado');
    expect(linha).toHaveTextContent('Mês fechado: a detecção de anomalias olha só o mês corrente.');
    expect(screen.getByTestId('custos-anomalias')).toHaveAttribute('data-status', 'not_applicable');
    expect(screen.queryByTestId('custos-anomalias-vazio')).toBeNull();
    expect(screen.queryByTestId('custos-anomalias-insuficiente')).toBeNull();
    expect(linha.querySelector('[data-single-line]')).not.toBeNull();
  });

  it('singular quando há 1 item', () => {
    montar(overview({ anomalies: { ...overview().anomalies, items: [GEOCODING] } }));
    expect(screen.getByTestId('custos-veredito-titulo')).toHaveTextContent('1 coisa fora do normal');
  });

  it('destaque: valor, mediana, fator, impacto (+US$ 38,10/dia) e maior contribuinte 92%', () => {
    montar();
    const [destaque, compacto] = screen.getAllByTestId('custos-anomalia');
    expect(destaque).toHaveTextContent('Geocoding API');
    expect(within(destaque).getByTestId('custos-destaque-valor')).toHaveTextContent(/US\$\s?41,20/);
    expect(destaque.textContent).toMatch(/US\$\s?3,10/);
    expect(destaque.textContent).toContain('13,3×');
    expect(destaque.textContent).toMatch(/\+US\$\s?38,10\/dia/);
    expect(within(destaque).getByTestId('custos-maior-contribuinte')).toHaveTextContent('Maior contribuinte do aumento (92%)');
    expect(within(destaque).getByTestId('custos-maior-contribuinte')).toHaveTextContent('clickup-patient-sync-safety-net-job');
    expect(compacto).toHaveTextContent('assistants-service-maria-whatsapp-handler-prd');
  });

  it('item "novo": selo novo, texto sem histórico, sem fator, sem mediana e SEM "Ver detalhe"', () => {
    montar();
    const compacto = screen.getAllByTestId('custos-anomalia')[1];
    expect(within(compacto).getByTestId('custos-selo-novo')).toBeInTheDocument();
    expect(compacto).toHaveTextContent('Sem histórico para calcular a mediana dos 7 dias anteriores.');
    expect(within(compacto).queryByText('Fator')).toBeNull();
    expect(within(compacto).queryByTestId('custos-ver-detalhe')).toBeNull();
  });

  it('"Ver detalhe" só em serviço com detail; clicar chama o callback (nenhuma requisição aqui)', async () => {
    montar();
    expect(screen.getAllByTestId('custos-ver-detalhe')).toHaveLength(1);
    await userEvent.click(screen.getByTestId('custos-ver-detalhe'));
    expect(onDetalhe).toHaveBeenCalledWith(expect.objectContaining({ name: 'Geocoding API' }));
  });

  it('nome longo: 1 linha (truncate + title com o nome inteiro) e marcado data-single-line', () => {
    montar();
    const longo = screen.getByTitle('assistants-service-maria-whatsapp-handler-prd');
    expect(longo.className).toContain('truncate');
    expect(longo).toHaveAttribute('data-single-line', 'nome');
  });

  it('minigráfico: role=img com o fato no aria-label (UI-9)', () => {
    montar();
    const img = screen.getByRole('img', { name: /Geocoding API, custo diário de 04\/10 a 17\/10/ });
    expect(img.getAttribute('aria-label')).toMatch(/mediana 3,10/);
    expect(img.getAttribute('aria-label')).toMatch(/41,20 em 17\/10/);
  });

  it('dia calmo: "Nada fora do normal" + regra, sem cartões e sem "Ver detalhe"', () => {
    montar(overview({ anomalies: { ...overview().anomalies, items: [] } }));
    expect(screen.getByTestId('custos-anomalias-vazio')).toHaveTextContent('Nada fora do normal em 17/10/2026');
    expect(screen.queryAllByTestId('custos-anomalia')).toHaveLength(0);
    expect(screen.queryByTestId('custos-ver-detalhe')).toBeNull();
  });

  it('histórico insuficiente NUNCA afirma calma (contagem zero é "não medi")', () => {
    montar(overview({ anomalies: { status: 'insufficient_history', day: null, rule: overview().anomalies.rule, items: [] } }));
    expect(screen.getByTestId('custos-anomalias-insuficiente')).toHaveTextContent('Histórico insuficiente: a detecção começa com 7 dias de dados');
    expect(screen.queryByTestId('custos-anomalias-vazio')).toBeNull();
    expect(screen.queryByText(/Nada fora do normal/)).toBeNull();
  });

  it('só itens novos: todos compactos, nenhum destaque', () => {
    montar(overview({ anomalies: { ...overview().anomalies, items: [MARIA] } }));
    expect(screen.getAllByTestId('custos-anomalia')).toHaveLength(1);
    expect(screen.queryByTestId('custos-destaque-valor')).toBeNull();
  });

  it('em espanhol o mesmo veredito sai em es', async () => {
    await usarIdioma('es');
    montar();
    expect(screen.getByTestId('custos-veredito-titulo')).toHaveTextContent('2 cosas fuera de lo normal');
  });
});
