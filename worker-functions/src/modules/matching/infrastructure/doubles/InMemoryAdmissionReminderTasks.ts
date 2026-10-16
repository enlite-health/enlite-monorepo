import type { AdmissionReminderTasksPort, ReminderScheduleResult } from '../../application/ports/AdmissionMessagingPorts';

/**
 * Dublê do agendador: reproduz a regra do Cloud Tasks (mesmo nome → ALREADY_EXISTS). Sem `taskId` o nome é gerado
 * (como no Google) e nada deduplica — é o que a sabotagem do teste A2-3 explora.
 */
export class InMemoryAdmissionReminderTasks implements AdmissionReminderTasksPort {
  readonly tasks = new Map<string, { appointmentId: string; runAtISO: string }>();
  readonly cancelled: string[] = [];
  private seq = 0;

  async schedule(input: { taskId: string; appointmentId: string; runAtISO: string }): Promise<ReminderScheduleResult> {
    const name = input.taskId ?? `auto-${(this.seq += 1)}`;
    if (this.tasks.has(name)) return { status: 'already_exists' };
    this.tasks.set(name, { appointmentId: input.appointmentId, runAtISO: input.runAtISO });
    return { status: 'scheduled', taskName: name };
  }

  async cancel(taskName: string): Promise<void> {
    this.cancelled.push(taskName);
    this.tasks.delete(taskName);
  }
}
