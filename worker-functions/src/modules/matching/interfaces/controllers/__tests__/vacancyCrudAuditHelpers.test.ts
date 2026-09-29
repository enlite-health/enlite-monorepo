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
import { vacancyActorFromRequest } from '../vacancyCrudAuditHelpers';

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
