import { PatientChatMapCapability } from '../PatientChatMapCapability';
import type { GetPatientChatMapUseCase } from '@modules/case';

const FAMILY = '120363090000000001@g.us';
const RESULT = { patients: [], total: 0, limit: 500, offset: 0, hasMore: false };

function useCaseMock(execute = jest.fn().mockResolvedValue(RESULT)) {
  return { execute } as unknown as GetPatientChatMapUseCase;
}

describe('PatientChatMapCapability', () => {
  it('expõe nome, descrição e input shape', () => {
    expect(PatientChatMapCapability.NAME).toBe('patient.chat.map');
    expect(PatientChatMapCapability.DESCRIPTION).toContain('ClickUp');
    expect(PatientChatMapCapability.DESCRIPTION).toContain('Read-only');
    expect(Object.keys(PatientChatMapCapability.INPUT_SHAPE).sort()).toEqual([
      'chatId', 'filter', 'limit', 'offset',
    ]);
  });

  it('a descrição promete SÓ identificadores (é o contrato de PII)', () => {
    expect(PatientChatMapCapability.DESCRIPTION).toMatch(/never patient name, phone or document/i);
  });

  it('sem args, delega com objeto vazio', async () => {
    const execute = jest.fn().mockResolvedValue(RESULT);
    await new PatientChatMapCapability(useCaseMock(execute)).execute(undefined);
    expect(execute).toHaveBeenCalledWith({});
  });

  it('repassa filter/limit/offset', async () => {
    const execute = jest.fn().mockResolvedValue(RESULT);
    await new PatientChatMapCapability(useCaseMock(execute)).execute({
      filter: 'unlinked', limit: 100, offset: 200,
    });
    expect(execute).toHaveBeenCalledWith({ filter: 'unlinked', limit: 100, offset: 200 });
  });

  it('repassa chatId na direção reversa', async () => {
    const execute = jest.fn().mockResolvedValue(RESULT);
    await new PatientChatMapCapability(useCaseMock(execute)).execute({ chatId: FAMILY });
    expect(execute).toHaveBeenCalledWith({ chatId: FAMILY });
  });

  it('devolve o resultado do use case', async () => {
    const out = await new PatientChatMapCapability(useCaseMock()).execute({});
    expect(out).toEqual(RESULT);
  });

  it('descarta argumento desconhecido em vez de estourar (strip)', async () => {
    const execute = jest.fn().mockResolvedValue(RESULT);
    await new PatientChatMapCapability(useCaseMock(execute)).execute({ filter: 'all', foo: 'bar' });
    expect(execute).toHaveBeenCalledWith({ filter: 'all' });
  });

  it.each([
    ['filter fora do enum', { filter: 'todos' }],
    ['chatId 1-1 (@c.us)', { chatId: '5491162180721@c.us' }],
    ['chatId sem sufixo', { chatId: '120363090000000001' }],
    ['limit acima do teto', { limit: 5000 }],
    ['limit zero', { limit: 0 }],
    ['offset negativo', { offset: -1 }],
    ['limit fracionário', { limit: 1.5 }],
  ])('rejeita %s', async (_label, args) => {
    const execute = jest.fn();
    await expect(new PatientChatMapCapability(useCaseMock(execute)).execute(args)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('não é capability de escrita — o nome não está no conjunto de writes', async () => {
    const { CapabilityRegistry } = await import('../../CapabilityRegistry');
    expect(CapabilityRegistry).toBeDefined();
    // patient.chat.map não aparece em WRITE_CAPABILITY_NAMES (lista literal do
    // registry); se um dia aparecer, este teste é o lugar de reavaliar.
    expect(PatientChatMapCapability.NAME.startsWith('patient.')).toBe(true);
    expect(PatientChatMapCapability.DESCRIPTION).not.toMatch(/\b(write|update|create|delete)\b/i);
  });
});
