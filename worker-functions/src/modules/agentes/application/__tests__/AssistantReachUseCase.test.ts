import { AssistantReachUseCase } from '../AssistantReachUseCase';

const uc = (cells: string[]) => new AssistantReachUseCase(async () => cells);

describe('AssistantReachUseCase', () => {
  it('maria + public', async () => {
    expect(await uc(['assistant_maria:chat', 'knowledge_public:read']).execute('u1')).toEqual({
      assistants: ['maria'],
      knowledge: ['PUBLIC'],
    });
  });

  it('no cells -> empty', async () => {
    expect(await uc([]).execute('u1')).toEqual({ assistants: [], knowledge: [] });
  });

  it('knowledge_default:read never shows up', async () => {
    const r = await uc(['knowledge_default:read', 'knowledge_public:read']).execute('u1');
    expect(r.knowledge).toEqual(['PUBLIC']);
    expect(JSON.stringify(r)).not.toContain('DEFAULT');
  });

  it('order = order of the constants (shuffled cells)', async () => {
    const r = await uc([
      'knowledge_technical:read',
      'assistant_candela:chat',
      'knowledge_public:read',
      'assistant_maria:chat',
      'assistant_lucero:chat',
    ]).execute('u1');
    expect(r.assistants).toEqual(['maria', 'lucero', 'candela']);
    expect(r.knowledge).toEqual(['PUBLIC', 'TECHNICAL']);
  });

  it('failure to resolve the cells -> rejects (never an empty list)', async () => {
    const failing = new AssistantReachUseCase(async () => {
      throw new Error('db down');
    });
    await expect(failing.execute('u1')).rejects.toThrow('db down');
  });

  it('passes the uid to the resolver', async () => {
    const resolver = jest.fn().mockResolvedValue([]);
    await new AssistantReachUseCase(resolver).execute('uid-9');
    expect(resolver).toHaveBeenCalledWith('uid-9');
  });
});
