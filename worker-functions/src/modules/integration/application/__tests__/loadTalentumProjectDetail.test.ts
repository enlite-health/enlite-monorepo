import { loadTalentumProjectDetail } from '../loadTalentumProjectDetail';
import type { TalentumProject } from '../../domain/ITalentumApiClient';

const item = (type: string): TalentumProject => ({
  projectId: 'p1', publicId: '', title: 't', description: '', whatsappUrl: '', slug: '', active: true,
  timestamp: '', questions: [], faq: [], type,
});

describe('loadTalentumProjectDetail', () => {
  it('PHONE_CALL: devolve o item, sem GET e sem link web', async () => {
    const getPrescreening = jest.fn();
    expect(await loadTalentumProjectDetail(item('PHONE_CALL'), { getPrescreening })).toEqual({ project: item('PHONE_CALL'), webLink: false });
    expect(getPrescreening).not.toHaveBeenCalled();
  });

  it('FULL: usa o detalhe e marca webLink', async () => {
    const detail = { ...item('FULL'), publicId: 'x' };
    expect(await loadTalentumProjectDetail(item('FULL'), { getPrescreening: async () => detail })).toEqual({ project: detail, webLink: true });
  });

  it('HTTP 400 vira "sem link web"; outro erro (Error ou não) propaga', async () => {
    const it400 = await loadTalentumProjectDetail(item('FULL'), { getPrescreening: async () => { throw new Error('GET x: HTTP 400'); } });
    expect(it400).toEqual({ project: item('FULL'), webLink: false });
    await expect(loadTalentumProjectDetail(item('FULL'), { getPrescreening: async () => { throw new Error('HTTP 500'); } })).rejects.toThrow('HTTP 500');
    await expect(loadTalentumProjectDetail(item('FULL'), { getPrescreening: () => Promise.reject('texto') })).rejects.toBe('texto');
  });
});
