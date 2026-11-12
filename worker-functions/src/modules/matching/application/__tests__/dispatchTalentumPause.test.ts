/** O helper ÚNICO do pós-commit (spec 084 R13): tenta pausar/retomar sem derrubar nada; lista vazia não faz nada. */
jest.mock('@shared/database/requestDbSession', () => ({
  ...jest.requireActual('@shared/database/requestDbSession'),
  withSystemDbContext: async (_n: string, fn: () => Promise<unknown>) => fn(),
}));
const mockReport = jest.fn();
jest.mock('@shared/logging', () => ({ ...jest.requireActual('@shared/logging'), reportError: (...a: unknown[]) => mockReport(...a) }));
import { dispatchTalentumPause } from '../dispatchTalentumPause';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('dispatchTalentumPause', () => {
  beforeEach(() => mockReport.mockClear());

  it('pausa e retoma os ids pedidos, na ordem', async () => {
    const side = { pause: jest.fn(async () => []), resume: jest.fn(async () => []) };
    dispatchTalentumPause(side, { pause: ['a'], resume: ['b'] }, 't');
    await tick(); await tick();
    expect(side.pause).toHaveBeenCalledWith(['a']);
    expect(side.resume).toHaveBeenCalledWith(['b']);
  });

  it('nada a fazer: nem agenda', async () => {
    const side = { pause: jest.fn(), resume: jest.fn() };
    dispatchTalentumPause(side as never, {}, 't');
    dispatchTalentumPause(side as never, { pause: [], resume: [] }, 't');
    await tick();
    expect(side.pause).not.toHaveBeenCalled();
  });

  it('falha NÃO lança e é reportada (a vaga segue PENDING, visível na lista manual)', async () => {
    const side = { pause: jest.fn(async () => { throw new Error('talentum fora'); }), resume: jest.fn() };
    dispatchTalentumPause(side as never, { pause: ['a'] }, 'Fonte');
    await tick(); await tick();
    expect(mockReport).toHaveBeenCalledWith(expect.any(Error), { source: 'Fonte:talentum' });
  });
});
