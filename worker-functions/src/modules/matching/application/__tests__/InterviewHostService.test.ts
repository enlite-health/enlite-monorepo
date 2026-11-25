/**
 * InterviewHostService.test.ts — spec 055: R1 (só staff ativo), Quitar (dois fluxos false → inativa), reativação e linha sem usuário.
 */
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ query: jest.fn() }),
}));

import { InterviewHostService } from '../InterviewHostService';
import type { InterviewHostRecord } from '../../infrastructure/InterviewHostRepository';
import {
  InterviewHostAlreadyActiveError,
  InterviewHostNotFoundError,
  InterviewHostUserNotEligibleError,
} from '../InterviewHostErrors';

const USER = { uid: 'u1', displayName: 'Florencia', email: 'flor@enlite.health' };
const record = (over: Partial<InterviewHostRecord> = {}): InterviewHostRecord => ({
  id: 'h1', email: USER.email, userUid: 'u1', countries: ['AR'], doesEnquadre: true, doesAdmission: true, active: true, ...over,
});

function build(opts: { eligible?: boolean; existing?: InterviewHostRecord | null; byId?: InterviewHostRecord | null } = {}) {
  const repo = {
    listAdmin: jest.fn(),
    searchCandidates: jest.fn(async () => [USER]),
    findEligibleUser: jest.fn(async () => (opts.eligible === false ? null : USER)),
    findByUserOrEmail: jest.fn(async () => opts.existing ?? null),
    findById: jest.fn(async () => (opts.byId === undefined ? record() : opts.byId)),
    insert: jest.fn(async () => 'new-id'),
    update: jest.fn(async () => undefined),
  };
  const tactiq = {
    statesFor: jest.fn(async () => new Map([['flor@enlite.health', 'linked' as const]])),
    seatsDeclaredFor: jest.fn(async () => new Set(['flor@enlite.health'])),
    declareSeat: jest.fn(async () => ({ changed: true })),
  };
  const service = new InterviewHostService({ db: {} as never, repo: repo as never, tactiq });
  return { service, repo, tactiq };
}

describe('InterviewHostService', () => {
  describe('create', () => {
    it('R1: recusa quem não é staff ativo (uid inexistente, worker ou desativado)', async () => {
      const { service, repo } = build({ eligible: false });
      await expect(service.create({ userUid: 'x', countries: ['AR'], doesEnquadre: true, doesAdmission: true }, 'admin')).rejects.toBeInstanceOf(
        InterviewHostUserNotEligibleError,
      );
      expect(repo.insert).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('usuário válido e sem linha → insere ativa com os fluxos marcados', async () => {
      const { service, repo } = build();
      await expect(service.create({ userUid: 'u1', countries: ['AR', 'BR'], doesEnquadre: true, doesAdmission: false }, 'admin')).resolves.toEqual({ id: 'new-id' });
      expect(repo.insert).toHaveBeenCalledWith(USER, expect.objectContaining({ countries: ['AR', 'BR'], doesEnquadre: true, doesAdmission: false, active: true, updatedBy: 'admin' }), expect.anything());
    });

    it('pessoa que já existe INATIVA → reativa a mesma linha (update com o usuário), sem inserir', async () => {
      const { service, repo } = build({ existing: record({ active: false }) });
      await expect(service.create({ userUid: 'u1', countries: ['AR'], doesEnquadre: true, doesAdmission: true }, 'admin')).resolves.toEqual({ id: 'h1' });
      expect(repo.insert).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith('h1', expect.objectContaining({ active: true }), expect.anything(), USER);
    });

    it('pessoa que já está ATIVA → 409 (editar é PATCH)', async () => {
      const { service } = build({ existing: record() });
      await expect(service.create({ userUid: 'u1', countries: ['AR'], doesEnquadre: true, doesAdmission: true }, 'admin')).rejects.toBeInstanceOf(
        InterviewHostAlreadyActiveError,
      );
    });
  });

  describe('update', () => {
    it('os dois fluxos desligados → active=false (Quitar), sem exigir usuário elegível', async () => {
      const { service, repo } = build({ eligible: false });
      await service.update('h1', { doesEnquadre: false, doesAdmission: false }, 'admin');
      expect(repo.update).toHaveBeenCalledWith('h1', expect.objectContaining({ doesEnquadre: false, doesAdmission: false, active: false }), expect.anything());
    });

    it('desligar só um fluxo mantém ativa e preserva o outro e os países', async () => {
      const { service, repo } = build();
      await service.update('h1', { doesAdmission: false }, 'admin');
      expect(repo.update).toHaveBeenCalledWith('h1', expect.objectContaining({ doesEnquadre: true, doesAdmission: false, countries: ['AR'], active: true }), expect.anything());
    });

    it('linha SEM usuário (Ana Joulie) só aceita Quitar; religar/editar é recusado (R1)', async () => {
      const { service, repo } = build({ byId: record({ userUid: null }) });
      await expect(service.update('h1', { countries: ['BR'] }, 'admin')).rejects.toBeInstanceOf(InterviewHostUserNotEligibleError);
      expect(repo.update).not.toHaveBeenCalled();
      await service.update('h1', { doesEnquadre: false, doesAdmission: false }, 'admin');
      expect(repo.update).toHaveBeenCalledTimes(1);
    });

    it('linha inexistente → not found', async () => {
      const { service } = build({ byId: null });
      await expect(service.update('nope', { doesEnquadre: false }, 'admin')).rejects.toBeInstanceOf(InterviewHostNotFoundError);
    });
  });

  describe('list', () => {
    it('devolve a linha com o estado do Tactiq por e-mail (missing quando não há vínculo)', async () => {
      const { service, repo, tactiq } = build();
      repo.listAdmin.mockResolvedValue([
        { id: 'h1', email: 'flor@enlite.health', userMissing: false },
        { id: 'h2', email: 'anajoulie@enlite.health', userMissing: true },
      ]);
      const items = await service.list();
      expect(tactiq.statesFor).toHaveBeenCalledWith(['flor@enlite.health', 'anajoulie@enlite.health']);
      expect(items.map((i) => i.tactiq)).toEqual(['linked', 'missing']);
      expect(items[1].userMissing).toBe(true);
    });

    it('F5: `tactiqSeatDeclared` vem da trilha (por e-mail em minúsculas), nunca calculado aqui', async () => {
      const { service, repo, tactiq } = build();
      repo.listAdmin.mockResolvedValue([
        { id: 'h1', email: 'flor@enlite.health', userMissing: false },
        { id: 'h2', email: 'Anajoulie@enlite.health', userMissing: false },
      ]);
      const items = await service.list();
      expect(tactiq.seatsDeclaredFor).toHaveBeenCalledWith(['flor@enlite.health', 'Anajoulie@enlite.health']);
      expect(items.map((i) => i.tactiqSeatDeclared)).toEqual([true, false]);
    });
  });

  describe('setTactiqSeat (F5, D16)', () => {
    it('entrega o e-mail da linha, o valor e o ator ao serviço do vínculo', async () => {
      const { service, tactiq } = build();
      await service.setTactiqSeat('h1', true, 'master-1');
      expect(tactiq.declareSeat).toHaveBeenCalledWith({ email: USER.email, assigned: true, actorUid: 'master-1' }, expect.anything());
    });

    it('linha inexistente → InterviewHostNotFoundError e nada é declarado', async () => {
      const { service, tactiq } = build({ byId: null });
      await expect(service.setTactiqSeat('nope', true, 'master-1')).rejects.toBeInstanceOf(InterviewHostNotFoundError);
      expect(tactiq.declareSeat).not.toHaveBeenCalled();
    });
  });
});
