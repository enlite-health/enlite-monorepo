import { AlcanceAssistentesUseCase } from '../AlcanceAssistentesUseCase';

const uc = (cells: string[]) => new AlcanceAssistentesUseCase(async () => cells);

describe('AlcanceAssistentesUseCase', () => {
  it('maria + publico', async () => {
    expect(await uc(['assistente_maria:chat', 'conhecimento_publico:read']).executar('u1')).toEqual({
      gestoras: ['maria'],
      conhecimento: ['publico'],
    });
  });

  it('sem células -> vazio', async () => {
    expect(await uc([]).executar('u1')).toEqual({ gestoras: [], conhecimento: [] });
  });

  it('conhecimento_default:read nunca aparece', async () => {
    const r = await uc(['conhecimento_default:read', 'conhecimento_publico:read']).executar('u1');
    expect(r.conhecimento).toEqual(['publico']);
    expect(JSON.stringify(r)).not.toContain('default');
  });

  it('ordem = ordem das constantes (células embaralhadas)', async () => {
    const r = await uc([
      'conhecimento_tecnico:read',
      'assistente_candela:chat',
      'conhecimento_publico:read',
      'assistente_maria:chat',
      'assistente_lucero:chat',
    ]).executar('u1');
    expect(r.gestoras).toEqual(['maria', 'lucero', 'candela']);
    expect(r.conhecimento).toEqual(['publico', 'tecnico']);
  });

  it('falha ao resolver células -> rejeita (nunca lista vazia)', async () => {
    const falha = new AlcanceAssistentesUseCase(async () => {
      throw new Error('db fora');
    });
    await expect(falha.executar('u1')).rejects.toThrow('db fora');
  });

  it('repassa o uid ao resolver', async () => {
    const resolver = jest.fn().mockResolvedValue([]);
    await new AlcanceAssistentesUseCase(resolver).executar('uid-9');
    expect(resolver).toHaveBeenCalledWith('uid-9');
  });
});
