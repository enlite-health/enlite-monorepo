/**
 * A29-3 — a linha de andamento da reunião na aba Admissão (spec 050 F29, §19.3). O ESTADO vem do servidor (`callProgress.state`);
 * a tela só escolhe o texto pela chave e mostra a hora no fuso do país do paciente. Fuso do teste = Asia/Tokyo (+09), que NÃO coincide
 * com Buenos Aires (-03): a hora certa só sai se o fuso for o explícito.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { i18nMock, appt, NOW, tEs } from './admissionTestKit';

vi.mock('react-i18next', () => i18nMock);

import { AdmissionAppointmentRow } from '../AdmissionAppointmentRow';
import type { AdmissionAppointment } from '@infrastructure/http/AdminAdmissionApiService';

const ta = (k: string): string => tEs(`admin.patients.detail.admissionTab.row.${k}`);
const row = (over: Partial<AdmissionAppointment>, timeZone = 'Asia/Tokyo') =>
  render(
    <AdmissionAppointmentRow
      appointment={appt({ meetLink: null, ...over })}
      timeZone={timeZone}
      canResendCell={false}
      canCancel={false}
      now={NOW}
      onResend={() => undefined}
      onCancel={() => undefined}
    />,
  );
const line = () => screen.getByTestId('admission-call-progress-a1');

// 14:02 UTC = 23:02 em Tóquio (e 11:02 em Buenos Aires)
const AT = '2026-10-12T14:02:00.000Z';

describe('A29-3 — cada estado mostra o texto e a hora no fuso do país', () => {
  it('em andamento: "En curso desde 23:02" (Tóquio), não 11:02 (Buenos Aires)', () => {
    row({ callProgress: { state: 'in_progress', at: AT } });
    expect(line()).toHaveTextContent(`${ta('callInProgress')} 23:02`);
    expect(line()).not.toHaveTextContent('11:02');
    expect(line()).toHaveAttribute('data-state', 'in_progress');
  });

  it('terminou: "Terminó a las 23:02"', () => {
    row({ callProgress: { state: 'ended', at: AT } });
    expect(line()).toHaveTextContent(`${ta('callEnded')} 23:02`);
  });

  it('resumo pronto: "Resumen listo a las 23:02"', () => {
    row({ callProgress: { state: 'summary_ready', at: AT } });
    expect(line()).toHaveTextContent(`${ta('summaryReady')} 23:02`);
  });

  it('resumo em preparação: só o texto, sem hora', () => {
    row({ callProgress: { state: 'summary_preparing', at: AT } });
    expect(line().textContent?.trim()).toBe(ta('summaryPreparing'));
  });

  it('reaberta depois do resumo: o aviso, sem hora e SEM prometer botão de refazer', () => {
    row({ callProgress: { state: 'reopened_after_summary', at: AT } });
    expect(line().textContent?.trim()).toBe(ta('reopenedAfterSummary'));
    expect(line().textContent ?? '').not.toMatch(/reintent|rehacer|refaz|refazer|bot[oó]n|clic/i);
  });

  it('a hora é a do país do paciente: o mesmo instante em Buenos Aires mostra 11:02 (controle)', () => {
    row({ callProgress: { state: 'in_progress', at: AT } }, 'America/Argentina/Buenos_Aires');
    expect(line()).toHaveTextContent(`${ta('callInProgress')} 11:02`);
  });

  it('vazio (none), ausente e estado desconhecido: sem a linha', () => {
    const a = row({ callProgress: { state: 'none', at: null } });
    expect(screen.queryByTestId('admission-call-progress-a1')).not.toBeInTheDocument();
    a.unmount();
    const b = row({ callProgress: undefined });
    expect(screen.queryByTestId('admission-call-progress-a1')).not.toBeInTheDocument();
    b.unmount();
    row({ callProgress: { state: 'estado_futuro' as never, at: AT } });
    expect(screen.queryByTestId('admission-call-progress-a1')).not.toBeInTheDocument();
  });

  it('os dois spans de início e fim reais seguem como estão', () => {
    row({ conferenceStartedAt: AT, conferenceEndedAt: '2026-10-12T14:40:00.000Z', callProgress: { state: 'ended', at: '2026-10-12T14:40:00.000Z' } });
    expect(screen.getByTestId('admission-conference-start-a1')).toHaveTextContent('23:02');
    expect(screen.getByTestId('admission-conference-end-a1')).toHaveTextContent('23:40');
  });
});
