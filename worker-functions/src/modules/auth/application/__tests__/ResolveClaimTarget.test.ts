import { ResolveClaimTarget } from '../ResolveClaimTarget';

describe('ResolveClaimTarget', () => {
  it('pergunta ao ledger pelo desafio, pelo uid do requisitante e pela validade do código (10 min)', async () => {
    const ledger = { findClaimTarget: jest.fn().mockResolvedValue('w-1') };

    const r = await new ResolveClaimTarget(ledger).execute({ challengeId: 'ch-1', requesterUid: 'uid-teste-1' });

    expect(r).toBe('w-1');
    expect(ledger.findClaimTarget).toHaveBeenCalledWith({ challengeId: 'ch-1', requesterUid: 'uid-teste-1', withinMinutes: 10 });
  });

  it('o ledger não acha (outro uid, outro propósito, vencido) → null', async () => {
    const ledger = { findClaimTarget: jest.fn().mockResolvedValue(null) };
    expect(await new ResolveClaimTarget(ledger).execute({ challengeId: 'ch-1', requesterUid: 'uid-teste-2' })).toBeNull();
  });
});
