/**
 * RealAdmissionReminderTasks.test.ts — o adapter do Cloud Tasks: o nome determinístico chega ao `schedule` e o gRPC
 * ALREADY_EXISTS (código 6) vira `already_exists` (spec 049 M2/A2-3). O cliente é dublado; nada sai.
 */
import { RealAdmissionReminderTasks, ADMISSION_REMINDER_QUEUE, ADMISSION_REMINDER_URL } from '../RealAdmissionReminderTasks';
import type { CloudTasksClient } from '@shared/events/CloudTasksClient';

function adapterWith(schedule: jest.Mock, deleteTask: jest.Mock = jest.fn()) {
  const OLD = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production'; // a trava de construtor só deixa instanciar fora de teste
  try {
    return new RealAdmissionReminderTasks({ schedule, deleteTask } as unknown as CloudTasksClient);
  } finally {
    process.env.NODE_ENV = OLD;
  }
}

const INPUT = { taskId: 'admission-reminder-a1', appointmentId: 'a1', runAtISO: '2026-08-03T12:30:00.000Z' };

describe('RealAdmissionReminderTasks', () => {
  it('passa fila, URL, corpo, horário e o taskId (nome determinístico) ao CloudTasksClient', async () => {
    const schedule = jest.fn().mockResolvedValue('projects/p/locations/l/queues/admission-reminders/tasks/admission-reminder-a1');
    const res = await adapterWith(schedule).schedule(INPUT);
    expect(res).toEqual({ status: 'scheduled', taskName: 'projects/p/locations/l/queues/admission-reminders/tasks/admission-reminder-a1' });
    expect(schedule).toHaveBeenCalledWith({
      queue: ADMISSION_REMINDER_QUEUE,
      url: ADMISSION_REMINDER_URL,
      body: { appointmentId: 'a1' },
      scheduleTime: INPUT.runAtISO,
      taskId: 'admission-reminder-a1',
    });
  });

  it('gRPC ALREADY_EXISTS (code 6) → already_exists; qualquer outro erro propaga', async () => {
    expect(await adapterWith(jest.fn().mockRejectedValue(Object.assign(new Error('6 ALREADY_EXISTS: task exists'), { code: 6 }))).schedule(INPUT)).toEqual({ status: 'already_exists' });
    expect(await adapterWith(jest.fn().mockRejectedValue(new Error('6 ALREADY_EXISTS'))).schedule(INPUT)).toEqual({ status: 'already_exists' });
    await expect(adapterWith(jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 14 }))).schedule(INPUT)).rejects.toThrow('boom');
  });

  it('Cloud Tasks desligado (schedule devolve null) → disabled; cancel delega ao deleteTask', async () => {
    expect(await adapterWith(jest.fn().mockResolvedValue(null)).schedule(INPUT)).toEqual({ status: 'disabled' });
    const del = jest.fn().mockResolvedValue(undefined);
    await adapterWith(jest.fn(), del).cancel('projects/p/tasks/t');
    expect(del).toHaveBeenCalledWith('projects/p/tasks/t');
  });
});
