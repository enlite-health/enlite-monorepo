/**
 * vacancyCrudAuditHelpers.test.ts — `vacancyActorFromRequest` (spec 029).
 *
 * Achado: o botão "ativar recrutamento" gravava `job_posting_audit_log` com
 * `actor_type=SYSTEM`/`actor_user_id=null` mesmo com um operador humano
 * autenticado clicando — `AuthMiddleware` grava `req.user.uid`
 * (AuthMiddleware.ts:216-217), mas `ActivateRecruitmentUseCase` nunca recebia
 * esse dado. Este helper é a peça nova, compartilhada entre
 * `VacancyCrudController.extractHumanActor` (delega, sempre força `'HUMAN'`) e
 * o novo call site de `AdminPatientContractedServicesController.activateRecruitment`.
 *
 * `loggingAls` NÃO é mockado aqui — é a implementação real (`AsyncLocalStorage`),
 * que devolve `undefined` fora de um `.run()`, exatamente o caso "sem trace"
 * abaixo.
 */
import type { Request } from 'express';
import { loggingAls } from '@shared/logging';
import { lockLiveVacancySnapshot, softDeleteVacancyRow, vacancyActorFromRequest } from '../vacancyCrudAuditHelpers';

function makeReq(user?: { uid?: string }): Request {
  return { user } as unknown as Request;
}

describe('vacancyActorFromRequest', () => {
  it('req COM user.uid → HUMAN, actorUserId = uid, actorLabel repassado', () => {
    const actor = vacancyActorFromRequest(makeReq({ uid: 'staff-uid-1' }), 'activate_recruitment');
    expect(actor).toMatchObject({
      actorUserId: 'staff-uid-1',
      actorType: 'HUMAN',
      actorLabel: 'activate_recruitment',
    });
  });

  it('req SEM `user` (não-autenticado / middleware ausente) → SYSTEM, actorUserId null, sem lançar', () => {
    const actor = vacancyActorFromRequest(makeReq(undefined), 'activate_recruitment');
    expect(actor).toMatchObject({
      actorUserId: null,
      actorType: 'SYSTEM',
      actorLabel: 'activate_recruitment',
    });
  });

  it('req COM `user` mas SEM `uid` (ex: shape só com `roles`) → SYSTEM, actorUserId null', () => {
    const actor = vacancyActorFromRequest(makeReq({}), 'activate_recruitment');
    expect(actor.actorUserId).toBeNull();
    expect(actor.actorType).toBe('SYSTEM');
  });

  it('actorLabel é sempre o que o caller passou (identifica o CAMINHO, não o ator)', () => {
    const actor = vacancyActorFromRequest(makeReq({ uid: 'u-1' }), 'admin_panel');
    expect(actor.actorLabel).toBe('admin_panel');
  });

  it('traceId ausente (fora de um loggingAls.run) → null', () => {
    const actor = vacancyActorFromRequest(makeReq({ uid: 'u-1' }), 'activate_recruitment');
    expect(actor.traceId).toBeNull();
  });

  it('traceId presente (dentro de um loggingAls.run) → lido do ALS store', () => {
    let actor: ReturnType<typeof vacancyActorFromRequest> | undefined;
    loggingAls.run({ traceId: 'trace-abc' }, () => {
      actor = vacancyActorFromRequest(makeReq({ uid: 'u-1' }), 'activate_recruitment');
    });
    expect(actor?.traceId).toBe('trace-abc');
  });
});

// ─── SQL do DELETE de vaga extraído (reusado pela fusão rascunho→oficial) ─────
describe('lockLiveVacancySnapshot / softDeleteVacancyRow', () => {
  const clientWith = (rows: unknown[]) => ({ query: jest.fn(async () => ({ rows })) });

  it('snapshot: só vaga VIVA, travada FOR UPDATE; devolve a linha', async () => {
    const c = clientWith([{ id: 'v1', is_draft: true }]);
    await expect(lockLiveVacancySnapshot(c as never, 'v1')).resolves.toEqual({ id: 'v1', is_draft: true });
    const [sql, params] = c.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/WHERE id = \$1 AND deleted_at IS NULL FOR UPDATE$/);
    expect(params).toEqual(['v1']);
  });

  it('snapshot: vaga inexistente/apagada → null', async () => {
    await expect(lockLiveVacancySnapshot(clientWith([]) as never, 'v1')).resolves.toBeNull();
  });

  it('soft-delete: status CLOSED + deleted_at; true quando a linha existe, false quando não', async () => {
    const ok = clientWith([{ id: 'v1' }]);
    await expect(softDeleteVacancyRow(ok as never, 'v1')).resolves.toBe(true);
    expect((ok.query.mock.calls[0] as unknown as [string])[0]).toMatch(/SET status = 'CLOSED', deleted_at = NOW\(\)/);
    await expect(softDeleteVacancyRow(clientWith([]) as never, 'v1')).resolves.toBe(false);
  });
});
