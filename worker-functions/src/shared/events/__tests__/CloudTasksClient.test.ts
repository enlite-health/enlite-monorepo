const mockCreateTask = jest.fn().mockResolvedValue([{ name: 'projects/p/locations/l/queues/q/tasks/t-1' }]);
const mockDeleteTask = jest.fn().mockResolvedValue(undefined);

jest.mock('@google-cloud/tasks', () => ({
  CloudTasksClient: jest.fn().mockImplementation(() => ({
    createTask: mockCreateTask,
    deleteTask: mockDeleteTask,
    queuePath: jest.fn(
      (project: string, location: string, queue: string) =>
        `projects/${project}/locations/${location}/queues/${queue}`,
    ),
  })),
}));

import { CloudTasksClient } from '../CloudTasksClient';

describe('CloudTasksClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    mockCreateTask.mockClear();
    mockDeleteTask.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns null in test/mock mode (no GCP_PROJECT_ID)', async () => {
    const client = new CloudTasksClient();
    const result = await client.schedule({
      queue: 'interview-reminders',
      url: '/api/internal/reminders/qualified',
      body: { workerId: 'w-1' },
    });
    expect(result).toBeNull();
  });

  it('formats scheduleTime as seconds timestamp', async () => {
    // Enable by setting GCP_PROJECT_ID and non-test env
    process.env = {
      ...originalEnv,
      GCP_PROJECT_ID: 'test-project',
      NODE_ENV: 'production',
      CLOUD_TASKS_QUEUE_LOCATION: 'us-central1',
      CLOUD_RUN_SERVICE_URL: 'https://example.com',
      INTERNAL_TOKEN_SECRET: 'secret',
    };

    const client = new CloudTasksClient();
    const scheduleTime = '2026-04-01T14:00:00Z';

    await client.schedule({
      queue: 'interview-reminders',
      url: '/api/internal/reminders/qualified',
      body: { workerId: 'w-1' },
      scheduleTime,
    });

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateTask.mock.calls[0][0];
    expect(callArgs.task.scheduleTime.seconds).toBe(
      Math.floor(new Date(scheduleTime).getTime() / 1000),
    );
  });

  it('schedules without delay when scheduleTime is omitted', async () => {
    process.env = {
      ...originalEnv,
      GCP_PROJECT_ID: 'test-project',
      NODE_ENV: 'production',
      CLOUD_TASKS_QUEUE_LOCATION: 'us-central1',
      CLOUD_RUN_SERVICE_URL: 'https://example.com',
      INTERNAL_TOKEN_SECRET: 'secret',
    };

    const client = new CloudTasksClient();
    await client.schedule({
      queue: 'interview-reminders',
      url: '/api/internal/reminders/qualified',
      body: { workerId: 'w-1' },
    });

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateTask.mock.calls[0][0];
    expect(callArgs.task.scheduleTime).toBeUndefined();
  });

  // ─── deleteTask ───────────────────────────────────────────────────

  it('deleteTask returns silently in test/mock mode', async () => {
    const client = new CloudTasksClient();
    await expect(client.deleteTask('task-to-delete')).resolves.toBeUndefined();
    expect(mockDeleteTask).not.toHaveBeenCalled(); // mock mode skips GCP call
  });

  it('deleteTask calls GCP client in production mode', async () => {
    process.env = {
      ...originalEnv,
      GCP_PROJECT_ID: 'test-project',
      NODE_ENV: 'production',
      CLOUD_TASKS_QUEUE_LOCATION: 'us-central1',
      CLOUD_RUN_SERVICE_URL: 'https://example.com',
      INTERNAL_TOKEN_SECRET: 'secret',
    };

    const client = new CloudTasksClient();
    await client.deleteTask('projects/p/locations/l/queues/q/tasks/t-1');

    expect(mockDeleteTask).toHaveBeenCalledWith({
      name: 'projects/p/locations/l/queues/q/tasks/t-1',
    });
  });

  // ─── nome determinístico (spec 049, M2) ──────────────────────────

  const prodEnv = () => ({
    ...originalEnv,
    GCP_PROJECT_ID: 'test-project',
    NODE_ENV: 'production',
    CLOUD_TASKS_QUEUE_LOCATION: 'us-central1',
    CLOUD_RUN_SERVICE_URL: 'https://example.com',
    INTERNAL_TOKEN_SECRET: 'secret',
  });

  it('com taskId, a task leva o nome `queuePath/tasks/<taskId>` (o Cloud Tasks deduplica por ele)', async () => {
    process.env = prodEnv();
    await new CloudTasksClient().schedule({
      queue: 'admission-reminders',
      url: '/api/internal/reminders/admission-30min',
      body: { appointmentId: 'a1' },
      taskId: 'admission-reminder-a1',
    });
    const { task } = mockCreateTask.mock.calls[0][0];
    expect(task.name).toBe('projects/test-project/locations/us-central1/queues/admission-reminders/tasks/admission-reminder-a1');
  });

  it('sem taskId a task NÃO leva nome (o Google gera) — os demais chamadores não mudam', async () => {
    process.env = prodEnv();
    await new CloudTasksClient().schedule({ queue: 'interview-reminders', url: '/x', body: {} });
    expect(mockCreateTask.mock.calls[0][0].task.name).toBeUndefined();
  });
});
