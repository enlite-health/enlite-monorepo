import type { AdmissionMessageStatus } from '../../application/ports/AdmissionMessagingPorts';
import { sealForMessage, type SealMessageRow } from '../admissionSeals';

const NOW = new Date('2026-10-10T12:00:00Z');
const FUTURE = new Date('2026-10-11T12:00:00Z');
const PAST = new Date('2026-10-09T12:00:00Z');
const booked = (slotStart = FUTURE, reminderTaskName: string | null = null) => ({ status: 'booked', slotStart, reminderTaskName });
const row = (kind: SealMessageRow['kind'], attempt: number, status: AdmissionMessageStatus): SealMessageRow => ({ kind, attempt, status });

describe('sealForMessage — selos Confirmação/Lembrete (spec 049 §4.5)', () => {
  it.each([
    ['claimed', 'pending'], ['sent', 'sent'], ['delivered', 'delivered'], ['read', 'delivered'],
    ['failed', 'failed'], ['undelivered', 'failed'], ['send_failed', 'failed'], ['cancelled', 'cancelled'],
    ['skipped_no_consent', 'no_consent'], ['skipped_test', 'skipped'], ['skipped_no_phone', 'skipped'], ['skipped_no_template', 'skipped'],
  ] as const)('status %s → selo %s', (status, seal) => {
    expect(sealForMessage('confirmation', [row('confirmation', 0, status)], booked(), NOW).seal).toBe(seal);
  });

  it('sem linha: reunião cancelada → cancelled; lembrete com task → scheduled; senão none', () => {
    expect(sealForMessage('confirmation', [], { status: 'cancelled', slotStart: FUTURE, reminderTaskName: null }, NOW).seal).toBe('cancelled');
    expect(sealForMessage('reminder_30min', [], booked(FUTURE, 'admission-reminder-x'), NOW).seal).toBe('scheduled');
    expect(sealForMessage('reminder_30min', [], booked(FUTURE, null), NOW).seal).toBe('none');
    expect(sealForMessage('confirmation', [], booked(FUTURE, 'admission-reminder-x'), NOW).seal).toBe('none');
  });

  it('vale a tentativa MAIS RECENTE (reenvio entregue apaga a falha do selo) e só as linhas do próprio kind', () => {
    const rows = [row('confirmation', 0, 'send_failed'), row('confirmation', 1, 'delivered'), row('reminder_30min', 0, 'failed')];
    const v = sealForMessage('confirmation', rows, booked(), NOW);
    expect(v).toEqual({ seal: 'delivered', attempt: 1, canResend: false });
  });

  it('canResend: só falha, dentro do teto (attempt < 2), reunião ativa', () => {
    expect(sealForMessage('confirmation', [row('confirmation', 0, 'send_failed')], booked(), NOW).canResend).toBe(true);
    expect(sealForMessage('confirmation', [row('confirmation', 1, 'undelivered')], booked(), NOW).canResend).toBe(true);
    expect(sealForMessage('confirmation', [row('confirmation', 2, 'send_failed')], booked(), NOW).canResend).toBe(false);
    expect(sealForMessage('confirmation', [row('confirmation', 0, 'delivered')], booked(), NOW).canResend).toBe(false);
    expect(sealForMessage('confirmation', [row('confirmation', 0, 'send_failed')], { ...booked(), status: 'cancelled' }, NOW).canResend).toBe(false);
  });

  it('canResend do lembrete some depois do início da reunião; o da confirmação não', () => {
    expect(sealForMessage('reminder_30min', [row('reminder_30min', 0, 'send_failed')], booked(PAST), NOW).canResend).toBe(false);
    expect(sealForMessage('reminder_30min', [row('reminder_30min', 0, 'send_failed')], booked(FUTURE), NOW).canResend).toBe(true);
    expect(sealForMessage('confirmation', [row('confirmation', 0, 'send_failed')], booked(PAST), NOW).canResend).toBe(true);
  });
});
