import { STATUS_POR_CODIGO } from '../permissionErrorHttp';

describe('permissionErrorHttp', () => {
  it('master_only_cell (granting a Master-only cell to a non-Master group) maps to HTTP 422', () => {
    expect(STATUS_POR_CODIGO.master_only_cell).toBe(422);
  });
});
