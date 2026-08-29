import type { PoolClient } from 'pg';
import { emitFunnelStageEvent, funnelStageEventName, FUNNEL_STAGES } from '../FunnelStageEventEmitter';

describe('funnelStageEventName', () => {
  it('é funnel_stage.<etapa minúscula> — QUALIFIED bate com o evento do webhook da Talentum', () => {
    expect(funnelStageEventName('QUALIFIED')).toBe('funnel_stage.qualified');
    expect(funnelStageEventName('PRE_SCREENING')).toBe('funnel_stage.pre_screening');
    expect(FUNNEL_STAGES).toHaveLength(9);
  });
});

describe('emitFunnelStageEvent', () => {
  const base = { workerId: 'w1', jobPostingId: 'j1', actorUid: 'staff-1', source: 'kanban' as const };

  it('etapa mudou → INSERT em domain_events no MESMO client, payload com autoria/origem/etapa anterior, devolve o id', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'evt-1' }] });
    const id = await emitFunnelStageEvent({ query } as unknown as PoolClient, { ...base, previousStage: 'INVITED', targetStage: 'COMPLETED' });
    expect(id).toBe('evt-1');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO domain_events (event, payload)');
    expect(params[0]).toBe('funnel_stage.completed');
    expect(JSON.parse(params[1])).toEqual({ workerId: 'w1', jobPostingId: 'j1', previousStage: 'INVITED', source: 'kanban', actorUid: 'staff-1' });
  });

  it('mesma etapa → nenhum evento, nenhuma query', async () => {
    const query = jest.fn();
    expect(await emitFunnelStageEvent({ query } as unknown as PoolClient, { ...base, previousStage: 'QUALIFIED', targetStage: 'QUALIFIED' })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('candidatura nova (sem etapa anterior) emite; sem ator → actorUid null; RETURNING vazio → null', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const id = await emitFunnelStageEvent({ query } as unknown as PoolClient, { ...base, actorUid: null, previousStage: null, targetStage: 'INVITED' });
    expect(id).toBeNull();
    expect(JSON.parse(query.mock.calls[0][1][1])).toMatchObject({ previousStage: null, actorUid: null });
  });
});
