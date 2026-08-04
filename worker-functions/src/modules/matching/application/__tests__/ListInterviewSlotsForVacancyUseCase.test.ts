import { ListInterviewSlotsForVacancyUseCase } from '../ListInterviewSlotsForVacancyUseCase';

describe('ListInterviewSlotsForVacancyUseCase', () => {
  let mockQuery: jest.Mock;
  let useCase: ListInterviewSlotsForVacancyUseCase;

  beforeEach(() => {
    mockQuery = jest.fn();
    useCase = new ListInterviewSlotsForVacancyUseCase({ query: mockQuery } as any);
  });

  it('vaga inexistente/deletada → job_not_found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await useCase.execute('jp-1');

    expect(result).toEqual({ ok: false, reason: 'job_not_found' });
  });

  it('devolve SÓ slots futuros com index/label/iso (lição PR #177) e nunca meet_link', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        case_number: 795,
        meet_link_1: 'https://meet.google.com/aaa-bbbb-ccc',
        meet_datetime_1: '2020-01-01T10:00:00.000Z',   // passado → fora
        meet_link_2: 'https://meet.google.com/ddd-eeee-fff',
        meet_datetime_2: '2027-04-07T10:00:00.000Z',   // futuro (Mié)
        meet_link_3: null,
        meet_datetime_3: '2027-04-08T15:30:00.000Z',   // sem link → fora
      }],
    });

    const result = await useCase.execute('jp-1');

    expect(result).toEqual({
      ok: true,
      caseNumber: 795,
      slots: [{ index: 2, label: 'Mié 07/04 10:00', iso: '2027-04-07T10:00:00.000Z' }],
    });
    expect(JSON.stringify(result)).not.toContain('meet.google.com');
  });

  it('nenhum slot futuro → slots vazio (ok:true, a Luz oferece handover)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        case_number: 100,
        meet_link_1: 'https://meet.google.com/aaa-bbbb-ccc',
        meet_datetime_1: '2020-01-01T10:00:00.000Z',
        meet_link_2: null, meet_datetime_2: null,
        meet_link_3: null, meet_datetime_3: null,
      }],
    });

    const result = await useCase.execute('jp-1');

    expect(result).toEqual({ ok: true, caseNumber: 100, slots: [] });
  });
});
