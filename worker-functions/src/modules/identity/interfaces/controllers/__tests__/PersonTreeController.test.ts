import type { Request, Response } from 'express';
import { PersonTreeController } from '../PersonTreeController';

const PID = '11111111-1111-4111-8111-111111111111';

function res() {
  const r = { status: jest.fn(), json: jest.fn() } as unknown as Response & { status: jest.Mock; json: jest.Mock };
  r.status.mockReturnValue(r);
  return r;
}
const req = (pid: string) => ({ params: { pid } }) as unknown as Request;

describe('PersonTreeController', () => {
  it('devolve os pids da árvore, ordenados', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ pid: 'b' }, { pid: 'a' }] });
    const r = res();
    await new PersonTreeController({ query } as never).tree(req(PID), r);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('iam.person_tree'), [PID]);
    expect(r.json).toHaveBeenCalledWith(['a', 'b']);
  });

  it('árvore vazia (pid desconhecido) → 404', async () => {
    const r = res();
    await new PersonTreeController({ query: jest.fn().mockResolvedValue({ rows: [] }) } as never).tree(req(PID), r);
    expect(r.status).toHaveBeenCalledWith(404);
  });

  it('pid que não é uuid → 400, sem tocar no banco', async () => {
    const query = jest.fn();
    const r = res();
    await new PersonTreeController({ query } as never).tree(req('nao-e-uuid'), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('erro de banco → 500', async () => {
    const r = res();
    await new PersonTreeController({ query: jest.fn().mockRejectedValue(new Error('x')) } as never).tree(req(PID), r);
    expect(r.status).toHaveBeenCalledWith(500);
  });
});
