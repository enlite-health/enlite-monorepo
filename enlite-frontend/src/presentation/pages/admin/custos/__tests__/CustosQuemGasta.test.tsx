import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustosQuemGasta } from '../CustosQuemGasta';
import { buildRows, TOP_ROWS_SHOWN } from '../custosRows';
import { overview, usarIdioma } from './custosTestUtils';

const trinta = Array.from({ length: 30 }, (_, i) => ({ service: 'Cloud Run', resource: `recurso-${String(i + 1).padStart(2, '0')}`, total: 100 - i * 2 }));
const comTrinta = () => overview({
  monthTotal: 3000,
  byResource: [...trinta, { service: '__none__', resource: '__none__', total: 19.8 }],
});

describe('buildRows (puro)', () => {
  it('byResource de 30 linhas: no máx. 8 nomeadas, "sem recurso" SEMPRE visível e "demais" = total − soma exibida', () => {
    const rows = buildRows('resource', comTrinta());
    const nomeadas = rows.filter((r) => r.kind === 'normal');
    expect(nomeadas).toHaveLength(TOP_ROWS_SHOWN);
    expect(rows.filter((r) => r.kind === 'none')).toHaveLength(1);
    const demais = rows.find((r) => r.kind === 'rest')!;
    const exibido = rows.filter((r) => r.kind !== 'rest').reduce((s, r) => s + (r.total ?? 0), 0);
    expect(demais.total).toBeCloseTo(3000 - exibido, 6);
    expect(rows[rows.length - 1].kind).toBe('rest');
  });

  it('a linha sem recurso aparece mesmo valendo menos que o corte (fora do topo por valor)', () => {
    const ov = comTrinta();
    ov.byResource[ov.byResource.length - 1].total = 0.4;
    expect(buildRows('resource', ov).some((r) => r.kind === 'none')).toBe(true);
  });

  it('o maior contribuinte entra mesmo fora do topo e vem realçado com "% do aumento"', () => {
    const ov = comTrinta();
    ov.byResource.push({ service: 'Geocoding API', resource: 'clickup-patient-sync-safety-net-job', total: 0.5 });
    const alvo = buildRows('resource', ov).find((r) => r.name === 'clickup-patient-sync-safety-net-job')!;
    expect(alvo.highlight).toBe(true);
    expect(alvo.signals).toContainEqual({ kind: 'share', value: expect.closeTo(92.0, 1) });
  });

  it('aba IA não parte o total: sem "demais"; custo desconhecido vira null, não 0', () => {
    const ov = overview();
    ov.byAiCaller.push({ caller: 'sol', funcao: 'prop', total: null, currency: 'USD', source: 'estimated' });
    const rows = buildRows('ai', ov);
    expect(rows.some((r) => r.kind === 'rest')).toBe(false);
    expect(rows.find((r) => r.name === 'sol / prop')).toMatchObject({ total: null, pct: null });
  });

  it('aba Projeto: "__none__" vira linha "sem projeto"; soma das linhas = total do mês, sem "demais"', () => {
    const ov = overview({ monthTotal: 1148.4, byProject: [{ project: 'enlite-prd', total: 861.3 }, { project: 'enlite-stg', total: 287 }, { project: '__none__', total: 0.1 }] });
    const rows = buildRows('project', ov);
    expect(rows.map((r) => r.kind)).toEqual(['normal', 'normal', 'none']);
    expect(rows.some((r) => r.kind === 'rest')).toBe(false);
  });
});

describe('CustosQuemGasta (RF-A9)', () => {
  let user: ReturnType<typeof userEvent.setup>;
  beforeEach(async () => { user = userEvent.setup(); await usarIdioma('pt-BR'); });

  it('5 abas ARIA (Serviço, Recurso, Setor, IA, Projeto) e o painel certo em cada uma', async () => {
    render(<CustosQuemGasta ov={overview()} />);
    const abas = screen.getAllByRole('tab');
    expect(abas.map((a) => a.textContent)).toEqual(['Serviço', 'Recurso', 'Setor', 'IA', 'Projeto']);
    expect(screen.getByRole('tab', { name: 'Serviço' })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByTestId('custos-por-servico')).getByText('Cloud Run')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Projeto' }));
    const painel = screen.getByTestId('custos-por-projeto');
    expect(within(painel).getByText('enlite-prd')).toBeInTheDocument();
    expect(within(painel).getByText('sem projeto')).toBeInTheDocument();
    expect(within(painel).queryByText('__none__')).toBeNull();
  });

  it('teclado: → e ← movem foco e seleção entre as abas (roving tabindex)', async () => {
    render(<CustosQuemGasta ov={overview()} />);
    screen.getByRole('tab', { name: 'Serviço' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Recurso' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Recurso' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Projeto' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Serviço' })).toHaveAttribute('tabindex', '-1');
  });

  it('serviço com anomalia leva o selo "13,3× a mediana"; sem anomalia não leva nenhum', () => {
    render(<CustosQuemGasta ov={overview()} />);
    const linhas = screen.getAllByTestId('custos-linha');
    const geo = linhas.find((l) => l.textContent?.includes('Geocoding API'))!;
    expect(geo).toHaveTextContent('13,3× a mediana');
    expect(within(linhas.find((l) => l.textContent?.includes('Cloud SQL'))!).queryByText(/mediana/)).toBeNull();
  });

  it('aba Recurso com 30 linhas: "sem recurso" e "demais recursos" aparecem no DOM; maior contribuinte realçado', async () => {
    const ov = comTrinta();
    render(<CustosQuemGasta ov={ov} />);
    await user.click(screen.getByRole('tab', { name: 'Recurso' }));
    const painel = screen.getByTestId('custos-por-recurso');
    expect(within(painel).getByText('sem recurso')).toBeInTheDocument();
    expect(within(painel).getByText('demais recursos')).toBeInTheDocument();
    expect(within(painel).getAllByTestId('custos-linha').filter((l) => l.dataset.kind === 'normal')).toHaveLength(TOP_ROWS_SHOWN);
  });

  it('aba IA: selos "estimado" e "não atribuído", nota de linha estimada', async () => {
    render(<CustosQuemGasta ov={overview()} />);
    await user.click(screen.getByRole('tab', { name: 'IA' }));
    expect(screen.getByTestId('custos-selo-estimado')).toBeInTheDocument();
    expect(screen.getByTestId('custos-selo-nao-atribuido')).toHaveTextContent('não atribuído');
    expect(screen.getByText(/Linha estimada: tokens × tabela de preço/)).toBeInTheDocument();
  });

  it('D1: aba IA formata cada linha na moeda DA LINHA e a participação só soma linhas na moeda da conta', async () => {
    const ov = overview({ currency: 'BRL', monthTotal: 1000 });
    ov.byAiCaller = [
      { caller: 'triage', funcao: 'classificar', total: 100, currency: 'BRL', source: 'billing' },
      { caller: 'sol', funcao: 'gemini', total: 50, currency: 'USD', source: 'estimated' },
    ];
    const rows = buildRows('ai', ov);
    expect(rows.find((r) => r.name === 'triage / classificar')).toMatchObject({ currency: 'BRL', pct: 10 });
    expect(rows.find((r) => r.name === 'sol / gemini')).toMatchObject({ currency: 'USD', pct: null });
    render(<CustosQuemGasta ov={ov} />);
    await user.click(screen.getByRole('tab', { name: 'IA' }));
    const linhas = screen.getAllByTestId('custos-linha');
    const sol = linhas.find((l) => l.textContent?.includes('sol / gemini'))!;
    expect(sol.textContent).toMatch(/US\$|USD/);
    expect(sol.textContent).not.toMatch(/R\$/);
    expect(sol.textContent).toContain('—');
    expect(linhas.find((l) => l.textContent?.includes('triage'))!.textContent).toMatch(/R\$/);
  });

  it('cabeçalhos de coluna com text-primary (UI-4) e marcados data-single-line; nome longo com title', async () => {
    render(<CustosQuemGasta ov={overview()} />);
    await user.click(screen.getByRole('tab', { name: 'Recurso' }));
    screen.getAllByRole('columnheader').forEach((th) => {
      expect(th.className).toContain('text-primary');
      expect(th.querySelector('[data-single-line="cabecalho"]')).not.toBeNull();
    });
    expect(screen.getByTitle('assistants-service-maria-whatsapp-handler-prd').className).toContain('truncate');
  });
});
