import { describe, it, expect } from 'vitest';
import { ApiError } from '@infrastructure/http/ApiError';
import { panelErrorKey } from '../panelErrors';

describe('panelErrorKey — o `code` estável decide, a frase não', () => {
  it.each([
    ['last_manager', 409, 'admin.access.group.lastManager'],
    ['system_group', 409, 'admin.access.group.systemGroup'],
    ['duplicate_name', 409, 'admin.access.group.duplicateName'],
    ['reason_required', 400, 'admin.access.group.reasonRequired'],
  ])('%s → %s', (code, status, key) => {
    expect(panelErrorKey(new ApiError({ success: false, error: 'x', code }, status))).toBe(key);
  });
  it('404 sem código → notFound', () => {
    expect(panelErrorKey(new ApiError({ success: false, error: 'x' }, 404))).toBe('admin.access.group.notFound');
  });
  it('ApiError sem código conhecido e erro que não é ApiError → genérico', () => {
    expect(panelErrorKey(new ApiError({ success: false, error: 'x' }, 500))).toBe('admin.access.group.error');
    expect(panelErrorKey(new Error('rede'))).toBe('admin.access.group.error');
  });
});
