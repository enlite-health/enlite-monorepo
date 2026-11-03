/** Regra da etapa na colisão rascunho×oficial (decisão do Gabriel, 03/11). Cada caso é uma linha da regra. */
import { decideCollisionStage } from '../draftFusionStage';

describe('decideCollisionStage', () => {
  it.each([
    // oficial em etapa de entrada → adota a do rascunho (os 5 casos medidos em prod, inclusive REJECTED)
    ['INVITED', 'QUALIFIED', { action: 'ADOPT', stage: 'QUALIFIED' }],
    ['INVITED', 'IN_PROGRESS', { action: 'ADOPT', stage: 'IN_PROGRESS' }],
    ['INVITED', 'IN_DOUBT', { action: 'ADOPT', stage: 'IN_DOUBT' }],
    ['INVITED', 'REJECTED', { action: 'ADOPT', stage: 'REJECTED' }],
    // entrada → entrada diferente também adota (regra do Gabriel; a reconciliação de cadastros manteria INVITED)
    ['INVITED', 'PRE_SCREENING', { action: 'ADOPT', stage: 'PRE_SCREENING' }],
    // oficial sem etapa conta como entrada
    [null, 'QUALIFIED', { action: 'ADOPT', stage: 'QUALIFIED' }],
  ])('oficial %s + rascunho %s → %j', (official, draft, expected) => {
    expect(decideCollisionStage(official, draft)).toEqual(expected);
  });

  it('mesma etapa → KEEP', () => {
    expect(decideCollisionStage('QUALIFIED', 'QUALIFIED')).toEqual({ action: 'KEEP' });
  });

  it('rascunho sem etapa → KEEP', () => {
    expect(decideCollisionStage('INVITED', null)).toEqual({ action: 'KEEP' });
  });

  it('oficial decidida e rascunho em entrada → KEEP (a decisão fica)', () => {
    expect(decideCollisionStage('SELECTED', 'INVITED')).toEqual({ action: 'KEEP' });
  });

  it('as duas decididas e diferentes → CONFLICT', () => {
    expect(decideCollisionStage('SELECTED', 'REJECTED')).toEqual({ action: 'CONFLICT' });
    expect(decideCollisionStage('QUALIFIED', 'IN_DOUBT')).toEqual({ action: 'CONFLICT' });
  });
});
