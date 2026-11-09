import { Result } from '@shared/utils/Result';
import { isClaimableWorker, isImportedWorker } from '../isClaimableWorker';

const repo = (absorbed: boolean | 'fail') => ({
  hasAbsorbedRealLogin: jest.fn().mockResolvedValue(
    absorbed === 'fail' ? Result.fail<boolean>('db down') : Result.ok(absorbed),
  ),
});

describe('isImportedWorker (definição única)', () => {
  it.each(['anacareimport_x', 'candidatoimport_x', 'pretalnimport_x', 'base1import_x', 'clickup_encuadre_x'])(
    '%s é importada',
    (uid) => expect(isImportedWorker(uid)).toBe(true),
  );
  it.each([null, undefined, '', 'uidRealFirebase', 'talentum_x'])('%s não é reclamável', (uid) =>
    expect(isImportedWorker(uid)).toBe(false),
  );
});

describe('isClaimableWorker', () => {
  it('controle positivo: sintética comum, nada absorvido → reclamável', async () => {
    const r = repo(false);
    const res = await isClaimableWorker(r, { id: 'w1', authUid: 'anacareimport_a' });
    expect(res.getValue()).toBe(true);
    expect(r.hasAbsorbedRealLogin).toHaveBeenCalledWith('w1');
  });

  it('sintética que absorveu login real → não reclamável', async () => {
    const res = await isClaimableWorker(repo(true), { id: 'w1', authUid: 'anacareimport_a' });
    expect(res.getValue()).toBe(false);
  });

  it('uid real → não reclamável, sem consultar o repositório', async () => {
    const r = repo(false);
    const res = await isClaimableWorker(r, { id: 'w1', authUid: 'uidReal' });
    expect(res.getValue()).toBe(false);
    expect(r.hasAbsorbedRealLogin).not.toHaveBeenCalled();
  });

  it('falha do repositório → Result.fail (nunca reclamável por omissão)', async () => {
    const res = await isClaimableWorker(repo('fail'), { id: 'w1', authUid: 'anacareimport_a' });
    expect(res.isFailure).toBe(true);
  });
});
