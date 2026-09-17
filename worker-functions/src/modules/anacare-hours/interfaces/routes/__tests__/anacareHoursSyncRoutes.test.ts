/**
 * F4 (task 4.8) — prova no nível HTTP: o botão (`/api/admin/.../sync`) e o Cloud Scheduler
 * (`/api/internal/.../sync`) são DUAS rotas, mas chamam o MESMO `AnaCareHoursSyncController` (a
 * mesma instância, como monta `index.ts`) — então um disparo concorrente entre as duas rotas
 * também dedupa. Sabotagem: montar cada rota com um controller DIFERENTE prova que aí NÃO dedupa
 * (2 rodadas reais) — evidenciando que é a instância compartilhada quem garante 4.8, não a rota.
 */
import express from 'express';
import request from 'supertest';
import { PermissionMiddleware, type AuthMiddleware } from '@modules/identity';
import { createAnaCareHoursSyncAdminRoutes, createAnaCareHoursSyncInternalRoutes } from '../anacareHoursSyncRoutes';
import { AnaCareHoursSyncController } from '../../controllers/AnaCareHoursSyncController';
import { AnaCareHoursSyncRunner } from '../../../application/AnaCareHoursSyncRunner';
import type { AnaCareShiftsSource, ListShiftsParams, SourceShiftDTO } from '../../../domain/AnaCareShiftsSource';
import type { EnliteDirectorySnapshot, EnliteDirectorySource } from '../../../domain/AnaCareHoursSyncPorts';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

const { reportError: reportErrorMock } = jest.requireMock('@shared/logging') as { reportError: jest.Mock };

function authDouble(): AuthMiddleware {
  const passa = () => (req: express.Request, _res: unknown, next: express.NextFunction) => {
    req.authContext ??= { principal: { id: 'dublê-staff', roles: ['admin'] } } as never;
    next();
  };
  return { requireStaff: passa, requireStaffOrApiKey: passa, requireAuth: passa } as unknown as AuthMiddleware;
}

function permissionsDouble(): PermissionMiddleware {
  return new PermissionMiddleware({
    client: { resolve: jest.fn(), can: jest.fn(), isFeatureAvailable: jest.fn(), featureConfig: jest.fn(), invalidate: jest.fn() },
    audit: { record: jest.fn() },
    env: {},
  });
}

class CountingShiftsSource implements AnaCareShiftsSource {
  calls = 0;
  async listShifts(_params: ListShiftsParams): Promise<{ shifts: SourceShiftDTO[]; skipped: { noProvider: number; noPatient: number } }> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { shifts: [], skipped: { noProvider: 0, noPatient: 0 } };
  }
  async getShift(): Promise<SourceShiftDTO | null> {
    return null;
  }
  async getRetratoStatus() {
    return { stale: false, circuitBreakerOpen: false };
  }
}

function buildApp(controller: AnaCareHoursSyncController): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAnaCareHoursSyncAdminRoutes(controller, authDouble(), permissionsDouble()));
  app.use('/api/internal', createAnaCareHoursSyncInternalRoutes(controller));
  return app;
}

describe('rotas de sync — botão (admin) e Cloud Scheduler (internal) compartilham o guard (4.8)', () => {
  it('MESMA instância de controller: disparo manual + cron concorrentes dedupam (1 request à fonte)', async () => {
    const source = new CountingShiftsSource();
    // `ANACARE_DIRECTORY_MIN_ABSOLUTE` explícita: sem histórico (repositório fake novo), o runner
    // agora é fail-closed na 1ª rodada sem essa env (item 4 da revisão de PR) — este teste prova
    // dedup de disparo concorrente, não o alarme do diretório.
    const runner = new AnaCareHoursSyncRunner(source, undefined, undefined, undefined, undefined, undefined, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });
    const controller = new AnaCareHoursSyncController(() => runner);
    const app = buildApp(controller);

    const [manual, cron] = await Promise.all([
      request(app).post('/api/admin/anacare-hours/sync').send({}),
      request(app).post('/api/internal/anacare-hours/sync').send({}),
    ]);

    expect(manual.status).toBe(200);
    expect(cron.status).toBe(200);
    expect(source.calls).toBe(1);
  });

  it('SABOTAGEM: controllers DIFERENTES (sem instância compartilhada) NÃO dedupam entre as rotas', async () => {
    const source = new CountingShiftsSource();
    const runnerA = new AnaCareHoursSyncRunner(source, undefined, undefined, undefined, undefined, undefined, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });
    const runnerB = new AnaCareHoursSyncRunner(source, undefined, undefined, undefined, undefined, undefined, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });
    const appSabotado = express();
    appSabotado.use(express.json());
    appSabotado.use('/api/admin', createAnaCareHoursSyncAdminRoutes(new AnaCareHoursSyncController(() => runnerA), authDouble(), permissionsDouble()));
    appSabotado.use('/api/internal', createAnaCareHoursSyncInternalRoutes(new AnaCareHoursSyncController(() => runnerB)));

    await Promise.all([
      request(appSabotado).post('/api/admin/anacare-hours/sync').send({}),
      request(appSabotado).post('/api/internal/anacare-hours/sync').send({}),
    ]);

    expect(source.calls).toBe(2); // prova que o dedup depende da instância COMPARTILHADA, não da rota isolada
  });
});

/**
 * Gate `revisao-pr` (fecho 17/09) — TAREFA A: o carimbo da corrida (`anacare_sync_run`, migration
 * 443) passa a ser resolvido pelo SERVIDOR (`AnaCareHoursSyncRunner.resolveRunStartedAt`), nunca
 * mais recebido do corpo HTTP. Antes (passo 2, apagado aqui), o detector de colisão só funcionava
 * se o CLIENTE reenviasse `runStartedAt` — o Cloud Scheduler real nunca fazia isso (posta corpo
 * fixo, não lê a resposta), então a detecção ficava DESLIGADA em produção. Aqui as DUAS chamadas
 * passam pelo Express de verdade (`supertest`), a 2ª reenviando só `cursor` (nunca `runStartedAt` —
 * o schema nem aceita mais o campo) — prova que o servidor detecta a colisão SOZINHO.
 */
describe('carimbo da corrida (migration 443) — o servidor resolve, o cliente não propaga nada (gate revisao-pr)', () => {
  /** 2 reservas, mesmo paciente nas duas — o cenário real que o detector existe para pegar. */
  class DuasReservasMesmoPacienteSource implements AnaCareShiftsSource {
    calls: string[] = [];
    async listShifts(params: ListShiftsParams): Promise<{ shifts: SourceShiftDTO[]; skipped: { noProvider: number; noPatient: number } }> {
      this.calls.push(params.reservationId ?? '?');
      // Latência real o bastante para o orçamento de 20ms da 1ª rodada estourar DEPOIS de R1.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const shift: SourceShiftDTO = {
        sourceShiftId: `${params.reservationId}-s0`,
        anaCarePatientId: 'AC-PAT-COLIDE', // MESMO paciente em R1 e R2.
        anaCareNurseId: 'N0',
        date: `${params.month}-10`,
        scheduledStart: null,
        scheduledEnd: null,
        actualStart: `${params.month}-10T10:00:00.000Z`,
        actualEnd: `${params.month}-10T11:00:00.000Z`,
        checkinSource: 'app',
        isFinalized: true,
      };
      return { shifts: [shift], skipped: { noProvider: 0, noPatient: 0 } };
    }
    async getShift(): Promise<SourceShiftDTO | null> {
      return null;
    }
    async getRetratoStatus() {
      return { stale: false, circuitBreakerOpen: false };
    }
  }

  class DuasReservasDirectory implements EnliteDirectorySource {
    async fetch(): Promise<EnliteDirectorySnapshot> {
      return {
        entries: [{ reservationId: 'R1' }, { reservationId: 'R2' }],
        counts: { activo: 2, terminado: 0, total: 2 },
        partial: false,
      };
    }
  }

  it('2ª chamada HTTP retomando só por cursor (sem runStartedAt nenhum): colisão DETECTADA automaticamente (409, nada gravado do lote)', async () => {
    const source = new DuasReservasMesmoPacienteSource();
    const runner = new AnaCareHoursSyncRunner(source, undefined, undefined, undefined, new DuasReservasDirectory(), undefined, {
      ANACARE_DIRECTORY_MIN_ABSOLUTE: '1',
    });
    const controller = new AnaCareHoursSyncController(() => runner);
    const app = buildApp(controller);

    // 1ª chamada: orçamento (20ms) estoura DEPOIS de processar R1 (30ms) — para com nextCursor=1,
    // sem ainda ter tocado R2. Escreve o paciente colidente via R1. O SERVIDOR grava o carimbo da
    // corrida em `anacare_sync_run` (aqui, o fake em memória) — o cliente não vê nem manda nada.
    const r1 = await request(app).post('/api/admin/anacare-hours/sync').send({ month: '2026-09', budgetMs: 20 });
    expect(r1.status).toBe(200);
    expect(r1.body.nextCursor).toBe(1);
    // `runStartedAt` ainda sai na RESPOSTA (observabilidade) — só não é mais aceito como ENTRADA.
    expect(typeof r1.body.runStartedAt).toBe('string');
    expect(source.calls).toEqual(['R1']);

    // 2ª chamada: só reenvia `cursor` — nunca `runStartedAt` (nem existe mais no schema). Processa
    // R2, que agrega o MESMO paciente (AC-PAT-COLIDE) já gravado pela 1ª chamada NESTA corrida. O
    // runner lê o carimbo da corrida do PRÓPRIO repositório (`syncRunRepository.getRunStartedAt`),
    // não de nada que o cliente mandou.
    const r2 = await request(app).post('/api/admin/anacare-hours/sync').send({ month: '2026-09', budgetMs: 100000, cursor: r1.body.nextCursor });

    expect(r2.status).toBe(409); // TAREFA D: código dedicado, não mais "Internal error" genérico
    expect(r2.body).toMatchObject({ success: false, code: 'ANACARE_PATIENT_MONTH_COLLISION' });
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('já foram gravados NESTA MESMA corrida') }),
      { source: 'AnaCareHoursSyncController.trigger.manual' },
    );
  });

  it('mesmo que o cliente MANDE um runStartedAt (ex.: script antigo) o schema ignora o campo — a colisão é detectada do mesmo jeito, nunca desligada por um valor do cliente', async () => {
    const source = new DuasReservasMesmoPacienteSource();
    const runner = new AnaCareHoursSyncRunner(source, undefined, undefined, undefined, new DuasReservasDirectory(), undefined, {
      ANACARE_DIRECTORY_MIN_ABSOLUTE: '1',
    });
    const controller = new AnaCareHoursSyncController(() => runner);
    const app = buildApp(controller);

    const r1 = await request(app).post('/api/admin/anacare-hours/sync').send({ month: '2026-09', budgetMs: 20 });
    expect(r1.status).toBe(200);
    expect(r1.body.nextCursor).toBe(1);

    // Um script antigo mandando um `runStartedAt` no FUTURO (o exato buraco 2 medido pelo gate:
    // antes, isso desligava o detector inteiro) — o schema não tem mais o campo, então é
    // silenciosamente descartado pelo zod, e o resultado é IDÊNTICO ao teste acima.
    const r2 = await request(app)
      .post('/api/admin/anacare-hours/sync')
      .send({ month: '2026-09', budgetMs: 100000, cursor: r1.body.nextCursor, runStartedAt: '2099-01-01T00:00:00.000Z' });

    expect(r2.status).toBe(409);
    expect(r2.body).toMatchObject({ success: false, code: 'ANACARE_PATIENT_MONTH_COLLISION' });
  });
});
