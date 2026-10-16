import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import {
  AdmissionRealAdapterInTestError,
  type AdmissionReminderTasksPort,
  type ReminderScheduleResult,
} from '../application/ports/AdmissionMessagingPorts';

/** Cloud Tasks queue for the 30-min-before admission reminder. */
export const ADMISSION_REMINDER_QUEUE = 'admission-reminders';
/** Endpoint the reminder Cloud Task calls back into. */
export const ADMISSION_REMINDER_URL = '/api/internal/reminders/admission-30min';

/** gRPC ALREADY_EXISTS. */
const GRPC_ALREADY_EXISTS = 6;

/**
 * Adapter REAL do agendador do lembrete (Cloud Tasks). A task tem nome determinístico, então um segundo agendamento
 * da mesma reunião volta `already_exists` em vez de criar outra task (M2). Trava de código: lança se instanciado com
 * NODE_ENV=test — teste usa o dublê (`InMemoryAdmissionReminderTasks`).
 */
export class RealAdmissionReminderTasks implements AdmissionReminderTasksPort {
  private readonly client: CloudTasksClient;

  constructor(client?: CloudTasksClient) {
    if (process.env.NODE_ENV === 'test') throw new AdmissionRealAdapterInTestError('RealAdmissionReminderTasks');
    this.client = client ?? new CloudTasksClient();
  }

  async schedule(input: { taskId: string; appointmentId: string; runAtISO: string }): Promise<ReminderScheduleResult> {
    try {
      const taskName = await this.client.schedule({
        queue: ADMISSION_REMINDER_QUEUE,
        url: ADMISSION_REMINDER_URL,
        body: { appointmentId: input.appointmentId },
        scheduleTime: input.runAtISO,
        taskId: input.taskId,
      });
      return taskName ? { status: 'scheduled', taskName } : { status: 'disabled' };
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown };
      if (e?.code === GRPC_ALREADY_EXISTS || String(e?.message ?? '').includes('ALREADY_EXISTS')) {
        return { status: 'already_exists' };
      }
      throw err;
    }
  }

  async cancel(taskName: string): Promise<void> {
    await this.client.deleteTask(taskName);
  }
}
