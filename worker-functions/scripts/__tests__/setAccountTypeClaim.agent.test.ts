/** `set-account-type-claim` pula `account_type='agent'` (spec 078, M2): conta de serviço sem usuário Firebase; staff/worker seguem gravando. */
import { processarContas, semUsuarioFirebase, type ClaimDeps } from '../set-account-type-claim';

function deps(): ClaimDeps & { getUser: jest.Mock; setClaim: jest.Mock; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    getUser: jest.fn().mockResolvedValue({ customClaims: {} }),
    setClaim: jest.fn().mockResolvedValue(undefined),
    log: (l: string) => logs.push(l),
  };
}
const EXEC = { dryRun: false, showAll: false };

describe('set-account-type-claim — agent não tem usuário Firebase', () => {
  it('semUsuarioFirebase: só agent', () => {
    expect(semUsuarioFirebase('agent')).toBe(true);
    expect(['staff', 'worker', 'client'].map(semUsuarioFirebase)).toEqual([false, false, false]);
  });

  it('linha agent: nenhuma chamada ao Firebase (getUser e setClaim com 0 chamadas) e imprime o motivo', async () => {
    const d = deps();
    const t = await processarContas([{ firebase_uid: 'agent:luz', account_type: 'agent' }], d, EXEC);
    expect(d.getUser).toHaveBeenCalledTimes(0);
    expect(d.setClaim).toHaveBeenCalledTimes(0);
    expect(t).toMatchObject({ pulados: 1, gravados: 0, invalidos: 0 });
    expect(d.logs.join('\n')).toContain('pulado (agent: sem usuário Firebase)');
  });

  it('controle positivo: staff e worker seguem gravando o claim (calls >= 1)', async () => {
    const d = deps();
    const t = await processarContas(
      [
        { firebase_uid: 's1', account_type: 'staff' },
        { firebase_uid: 'w1', account_type: 'worker' },
      ],
      d,
      EXEC,
    );
    expect(d.setClaim.mock.calls).toEqual([['s1', 'staff'], ['w1', 'worker']]);
    expect(t).toMatchObject({ gravados: 2, pulados: 0 });
  });

  it('mistura: agent no meio de staff/worker — só o agent é pulado, nem em dry-run chama o IdP para ele', async () => {
    const d = deps();
    const t = await processarContas(
      [
        { firebase_uid: 's1', account_type: 'staff' },
        { firebase_uid: 'agent:luz', account_type: 'agent' },
        { firebase_uid: 'w1', account_type: 'worker' },
      ],
      d,
      { dryRun: true, showAll: false },
    );
    expect(d.getUser.mock.calls.map((c) => c[0])).toEqual(['s1', 'w1']);
    expect(d.setClaim).toHaveBeenCalledTimes(0);
    expect(t.pulados).toBe(1);
  });
});
