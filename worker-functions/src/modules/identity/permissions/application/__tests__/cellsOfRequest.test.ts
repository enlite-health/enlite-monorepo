import type { Request } from 'express';
import { cellsOfRequest } from '../cellsOfRequest';

describe('cellsOfRequest — os dois estados que não podem se confundir', () => {
  it('engine não decidiu → null (e NÃO array vazio)', () => {
    expect(cellsOfRequest({} as Request)).toBeNull();
  });

  it('ator conhecido e sem nenhuma célula → array vazio, que não é null', () => {
    const cells = cellsOfRequest({ permissionCells: [] } as unknown as Request);
    expect(cells).toEqual([]);
    expect(cells).not.toBeNull();
  });

  it('células resolvidas passam intactas', () => {
    expect(cellsOfRequest({ permissionCells: ['worker:read'] } as unknown as Request)).toEqual([
      'worker:read',
    ]);
  });
});
