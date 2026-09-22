import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnaCareHoursListPage } from './AnaCareHoursListPage';
import type { AnaCareMonthSnapshot } from './types';
import type { UseAnaCareHoursSyncResult } from '@hooks/admin/useAnaCareHoursSync';

// `i18n.language`: o seletor de mês agora formata o rótulo com `formatMonthLabel(value,
// i18n.language)` (decisão do Gabriel, 20/09) — sem isso o mock derruba o componente com "Cannot
// read properties of undefined (reading 'language')".
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key),
    i18n: { language: 'es' },
  }),
}));

function snapshot(overrides: Partial<AnaCareMonthSnapshot> = {}): AnaCareMonthSnapshot {
  return {
    month: '2026-08',
    updatedAt: '2026-09-15T08:00:00-03:00',
    stale: false,
    snapshotState: 'fresco',
    circuitBreakerOpen: false,
    patients: [
      {
        anaCareId: '90000',
        linked: false,
        name: 'Lucía Fernández QA',
        providers: [{ anaCareId: 'p1', linked: true, name: 'Rocío García QA' }],
        providersCount: 1,
        shiftsCount: 1,
        hoursActualSum: 8,
        hoursScheduledSumMissingActual: 0,
        validated: 1,
        contested: 0,
        originSinCheckin: 0,
        originWebAdmin: 0,
        originApp: 1,
      },
      {
        anaCareId: '90447',
        linked: false,
        providers: [],
        providersCount: 0,
        shiftsCount: 0,
        hoursActualSum: 0,
        hoursScheduledSumMissingActual: 0,
        validated: 0,
        contested: 0,
        originSinCheckin: 0,
        originWebAdmin: 0,
        originApp: 0,
      },
    ],
    ...overrides,
  };
}

describe('AnaCareHoursListPage', () => {
  it('POSITIVO — lista os pacientes com as colunas do protótipo', () => {
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-patient-row-90000')).toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-patient-row-90447')).toBeInTheDocument();
  });

  /**
   * F6.3: `Prestadores` e `Turnos` vêm de campos PRONTOS e DIFERENTES (`providersCount` ×
   * `shiftsCount`) — nunca o mesmo número recalculado à mão. Este teste MORRE se a coluna
   * `Turnos` voltar a ler `providersCount` (sabotagem verificada manualmente, ver relatório).
   */
  it('POSITIVO — colunas "Prestadores" e "Turnos" mostram `providersCount`/`shiftsCount`, campos distintos e prontos', () => {
    const snap = snapshot({
      patients: [
        {
          anaCareId: '90222',
          linked: false,
          name: 'Marta Núñez QA',
          providers: [{ anaCareId: 'pA', linked: true, name: 'Prestador A' }],
          providersCount: 1,
          shiftsCount: 5,
          hoursActualSum: 10,
          hoursScheduledSumMissingActual: 0,
          validated: 0,
          contested: 0,
          originSinCheckin: 0,
          originWebAdmin: 0,
          originApp: 0,
        },
      ],
    });
    render(<AnaCareHoursListPage snapshot={snap} onOpenPatient={vi.fn()} />);
    const row = screen.getByTestId('anacare-hours-patient-row-90222');
    const cells = row.querySelectorAll('td');
    expect(cells[1]).toHaveTextContent('1'); // Prestadores = providersCount
    expect(cells[2]).toHaveTextContent('5'); // Turnos = shiftsCount (DIFERENTE de providersCount)
  });

  it('POSITIVO — clicar numa linha chama onOpenPatient com o anaCareId', () => {
    const onOpenPatient = vi.fn();
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={onOpenPatient} />);
    fireEvent.click(screen.getByTestId('anacare-hours-patient-row-90000'));
    expect(onOpenPatient).toHaveBeenCalledWith('90000');
  });

  it('NEGATIVO — mês sem turnos mostra o empty state "emptyNoShifts"', () => {
    render(<AnaCareHoursListPage snapshot={snapshot({ patients: [] })} onOpenPatient={vi.fn()} />);
    expect(screen.getByText('admin.anacareHours.list.emptyNoShifts')).toBeInTheDocument();
  });

  it('NEGATIVO — filtro sem resultado mostra "emptyNoMatch"', () => {
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} />);
    fireEvent.change(screen.getByTestId('anacare-hours-patient-search'), { target: { value: 'zzz-no-existe' } });
    expect(screen.getByText('admin.anacareHours.list.emptyNoMatch')).toBeInTheDocument();
  });

  it('POSITIVO — busca por paciente filtra a lista', () => {
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} />);
    fireEvent.change(screen.getByTestId('anacare-hours-patient-search'), { target: { value: 'Lucía' } });
    expect(screen.getByTestId('anacare-hours-patient-row-90000')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-patient-row-90447')).not.toBeInTheDocument();
  });

  it('POSITIVO — retrato desatualizado (stale, sincronizado) mostra o AlertBanner com a mensagem de "mais de 24 horas"', () => {
    render(<AnaCareHoursListPage snapshot={snapshot({ stale: true, snapshotState: 'velho' })} onOpenPatient={vi.fn()} />);
    expect(screen.getByText('admin.anacareHours.stale.messageSimple')).toBeInTheDocument();
  });

  /**
   * Item 3 (revisão de PR): "nunca construído" tem mensagem PRÓPRIA — antes, `stale=true`
   * sozinho fazia a tela mostrar sempre "há mais de 24 horas", falso quando o sync nunca rodou.
   * Este teste MORRE se a mensagem de "nao_construido" voltar a colapsar em `messageSimple`.
   */
  it('POSITIVO — retrato NUNCA construído (snapshotState=nao_construido) mostra mensagem própria, NÃO "mais de 24 horas"', () => {
    render(<AnaCareHoursListPage snapshot={snapshot({ stale: true, snapshotState: 'nao_construido' })} onOpenPatient={vi.fn()} />);
    expect(screen.getByText('admin.anacareHours.stale.messageNaoConstruido')).toBeInTheDocument();
    expect(screen.queryByText('admin.anacareHours.stale.messageSimple')).not.toBeInTheDocument();
  });

  it('POSITIVO — disjuntor aberto mostra o AlertBanner com a mensagem do disjuntor', () => {
    render(<AnaCareHoursListPage snapshot={snapshot({ circuitBreakerOpen: true })} onOpenPatient={vi.fn()} />);
    expect(screen.getByText('admin.anacareHours.stale.messageCircuitBreaker')).toBeInTheDocument();
  });

  // F2 (change `anacare-horas-conclusao-de-corrida`, migration 457) — 2 estados novos.
  /**
   * `desconhecido` NÃO seta `stale=true` (compat: `nao_construido || velho`, ver `types.ts`) — a
   * PROVA de que o banner tem de nascer de `snapshotState`, não só de `stale`: com `stale: false`
   * aqui, o banner antigo (que só olhava `stale || circuitBreakerOpen`) NUNCA apareceria.
   */
  it('POSITIVO — snapshotState=desconhecido (stale=false) mostra o banner com mensagem própria, NUNCA "mais de 24 horas"', () => {
    render(<AnaCareHoursListPage snapshot={snapshot({ stale: false, snapshotState: 'desconhecido' })} onOpenPatient={vi.fn()} />);
    expect(screen.getByText(/^admin\.anacareHours\.stale\.titleDesconhecido/)).toBeInTheDocument();
    expect(screen.getByText('admin.anacareHours.stale.messageDesconhecido')).toBeInTheDocument();
    expect(screen.queryByText('admin.anacareHours.stale.messageSimple')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.anacareHours.stale.messageNaoConstruido')).not.toBeInTheDocument();
  });

  it('POSITIVO — snapshotState=parcial SEM contagens (stale=false) mostra o banner com a mensagem curta (sem números)', () => {
    render(<AnaCareHoursListPage snapshot={snapshot({ stale: false, snapshotState: 'parcial' })} onOpenPatient={vi.fn()} />);
    expect(screen.getByText(/^admin\.anacareHours\.stale\.titleParcial/)).toBeInTheDocument();
    expect(screen.getByText('admin.anacareHours.stale.messageParcial')).toBeInTheDocument();
  });

  /**
   * CONTROLE POSITIVO (Decisão 9/design.md §F2) na CAMADA DE TELA: com `reservationsDone=49` de
   * `reservationsTotal=144` e `snapshotState=parcial`, a tela tem de mostrar os 2 números
   * interpolados — nunca a mensagem curta, nunca "fresco" (nenhum banner é o outro extremo do
   * mesmo bug: sabotar pra 49/144 e a tela continuar muda).
   */
  it('CONTROLE POSITIVO — snapshotState=parcial COM contagens (49/144) mostra "processadas 49 de 144" interpolado', () => {
    render(
      <AnaCareHoursListPage
        snapshot={snapshot({ stale: false, snapshotState: 'parcial', reservationsTotal: 144, reservationsDone: 49 })}
        onOpenPatient={vi.fn()}
      />,
    );
    expect(screen.getByText('admin.anacareHours.stale.messageParcialComContagem|{"done":49,"total":144}')).toBeInTheDocument();
    expect(screen.queryByText('admin.anacareHours.stale.messageParcial')).not.toBeInTheDocument();
  });

  it('NEGATIVO — snapshotState=fresco (stale=false, sem contagens) NÃO mostra banner nenhum', () => {
    render(<AnaCareHoursListPage snapshot={snapshot({ stale: false, snapshotState: 'fresco' })} onOpenPatient={vi.fn()} />);
    expect(screen.queryByText('admin.anacareHours.stale.titleParcial')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.anacareHours.stale.titleDesconhecido')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.anacareHours.stale.title')).not.toBeInTheDocument();
  });

  it('POSITIVO — troca de mês chama onMonthChange', () => {
    const onMonthChange = vi.fn();
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} onMonthChange={onMonthChange} />);
    const select = screen.getByLabelText('admin.anacareHours.monthAriaLabel') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '2026-09' } });
    expect(onMonthChange).toHaveBeenCalledWith('2026-09');
  });

  it('POSITIVO — linha com contestados e as 3 origens mostra o sufixo de contestados e os 3 selos mini de origem', () => {
    const snap = snapshot({
      patients: [
        {
          anaCareId: '90999',
          linked: false,
          name: 'Camila Torres QA',
          providers: [{ anaCareId: 'p9', linked: true, name: 'Paula Díaz QA' }],
          providersCount: 1,
          shiftsCount: 3,
          hoursActualSum: 16,
          hoursScheduledSumMissingActual: 8,
          validated: 1,
          contested: 1,
          originSinCheckin: 1,
          originWebAdmin: 1,
          originApp: 1,
        },
      ],
    });
    render(<AnaCareHoursListPage snapshot={snap} onOpenPatient={vi.fn()} />);
    const row = screen.getByTestId('anacare-hours-patient-row-90999');
    expect(row).toHaveTextContent('admin.anacareHours.list.validationSummaryContestedSuffix');
  });

  it('POSITIVO — filtro por prestador restringe a lista', () => {
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} />);
    fireEvent.focus(screen.getByTestId('anacare-hours-provider-filter'));
    fireEvent.click(screen.getByTestId('anacare-hours-provider-filter-option-p1'));
    expect(screen.getByTestId('anacare-hours-patient-row-90000')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-patient-row-90447')).not.toBeInTheDocument();
  });

  /**
   * F6.3 (defeito que o Gabriel via na tela): a rota agora manda `name` no agregado (sem turnos),
   * e a lista tem de mostrar o NOME — não mais "Sin vínculo · ID 9767". Este teste MORRE se a
   * coluna "Paciente" voltar a ler de um campo que a lista não recebe mais.
   */
  it('POSITIVO — a lista renderiza o NOME do paciente quando a rota manda `name` (nunca "Sin vínculo · ID X")', () => {
    const snap = snapshot({
      patients: [
        {
          anaCareId: '9767',
          linked: false,
          name: 'Rosa Benítez QA',
          providers: [],
          providersCount: 0,
          shiftsCount: 0,
          hoursActualSum: 0,
          hoursScheduledSumMissingActual: 0,
          validated: 0,
          contested: 0,
          originSinCheckin: 0,
          originWebAdmin: 0,
          originApp: 0,
        },
      ],
    });
    render(<AnaCareHoursListPage snapshot={snap} onOpenPatient={vi.fn()} />);
    const row = screen.getByTestId('anacare-hours-patient-row-9767');
    expect(row).toHaveTextContent('Rosa Benítez QA');
    expect(row).not.toHaveTextContent('Sin vínculo · ID 9767');
  });

  it('POSITIVO — as opções do dropdown de prestador são montadas a partir de `providers` (sem `shifts`)', () => {
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} />);
    fireEvent.focus(screen.getByTestId('anacare-hours-provider-filter'));
    expect(screen.getByTestId('anacare-hours-provider-filter-option-p1')).toHaveTextContent('Rocío García QA');
  });

  /**
   * F6.3: os dois modos de "Horas totales" têm de dar números DIFERENTES quando existe turno sem
   * check-in — `hoursActualSum` sozinho (modo `zero`) contra `hoursActualSum +
   * hoursScheduledSumMissingActual` (modo previsto). Este teste MORRE se os dois somarem sempre o
   * mesmo total (sinal de que o modo parou de fazer diferença, ex.: somando os dois campos sempre).
   */
  it('POSITIVO — modo `zero` e modo previsto de "Horas totales" dão números diferentes quando há turno sem check-in', () => {
    const snap = snapshot({
      patients: [
        {
          anaCareId: '90555',
          linked: false,
          name: 'Diego Ramos QA',
          providers: [],
          providersCount: 0,
          shiftsCount: 2,
          hoursActualSum: 8,
          hoursScheduledSumMissingActual: 6,
          validated: 0,
          contested: 0,
          originSinCheckin: 1,
          originWebAdmin: 0,
          originApp: 1,
        },
      ],
    });
    const { rerender } = render(<AnaCareHoursListPage snapshot={snap} onOpenPatient={vi.fn()} sinCheckinHoursMode="zero" />);
    expect(screen.getByTestId('anacare-hours-patient-row-90555')).toHaveTextContent('8.0 h');

    rerender(<AnaCareHoursListPage snapshot={snap} onOpenPatient={vi.fn()} sinCheckinHoursMode="scheduled" />);
    expect(screen.getByTestId('anacare-hours-patient-row-90555')).toHaveTextContent('14.0 h');
  });

  // D6 (cobertura, 18/09): `sync &&` (linhas 105-114) nunca foi exercitado com `sync` presente —
  // todos os testes acima renderizam sem a prop (serviço sem `triggerSync`, botão ausente por
  // design). Este teste cobre o ramo TRUE: o botão aparece e recebe exatamente os campos do hook.
  it('POSITIVO — com `sync` presente, o botão "Sincronizar" aparece com os campos do hook', () => {
    const sync: UseAnaCareHoursSyncResult = {
      status: 'running',
      round: 2,
      reservationsProcessed: 74,
      reservationsTotal: null,
      reservationsDone: null,
      error: null,
      resumableCursor: 50,
      interruptedMonth: null,
      start: vi.fn(),
    };
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} sync={sync} />);
    expect(screen.getByTestId('anacare-hours-sync-button')).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-sync-progress')).toHaveTextContent(
      'admin.anacareHours.sync.progress|{"round":2,"count":74}',
    );
  });
});
