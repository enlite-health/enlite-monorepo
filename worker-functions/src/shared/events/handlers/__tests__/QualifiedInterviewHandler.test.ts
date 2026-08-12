/**
 * QualifiedInterviewHandler.test.ts
 *
 * Testa o handler do evento funnel_stage.qualified.
 *
 * Cenários:
 * 1. Enfileira mensagem qualified_worker_request com slots e case_number (sem links)
 * 2. Pula envio se vaga não encontrada
 * 3. Pula envio se vaga sem meet links configurados
 * 4. Pula envio se worker não encontrado
 * 5. Publica outbox-enqueued no Pub/Sub após inserir na outbox
 * 6. Marca interview_response = 'pending' na worker_job_applications
 * 7. Funciona com apenas 1 ou 2 meet links (opções parciais)
 * 8. formatSlotOption formata datetime corretamente
 */

import {
  createQualifiedInterviewHandler,
  formatSlotOption,
} from '../QualifiedInterviewHandler';

describe('QualifiedInterviewHandler', () => {
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let mockPubsub: { publish: jest.Mock };
  let mockTokenService: { generate: jest.Mock };
  let handler: (payload: Record<string, unknown>) => Promise<void>;

  const payload = {
    workerId: 'worker-1',
    jobPostingId: 'job-1',
  };

  // Datas FUTURAS fixas (2027): o handler descarta slot no passado.
  const DT_1 = '2027-04-07T10:00:00Z';
  const DT_2 = '2027-04-08T15:00:00Z';
  const DT_3 = '2027-04-09T09:00:00Z';

  const vacancyRow = {
    case_number: 42,
    meet_link_1: 'https://meet.google.com/abc-1',
    meet_datetime_1: DT_1,
    meet_link_2: 'https://meet.google.com/abc-2',
    meet_datetime_2: DT_2,
    meet_link_3: 'https://meet.google.com/abc-3',
    meet_datetime_3: DT_3,
  };

  beforeEach(() => {
    mockQuery = jest.fn();
    mockDb = { query: mockQuery };
    mockPubsub = { publish: jest.fn().mockResolvedValue(null) };
    mockTokenService = { generate: jest.fn().mockResolvedValue('tk_abc123def456') };
    handler = createQualifiedInterviewHandler(
      mockDb as any,
      mockPubsub as any,
      mockTokenService as any,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('enfileira mensagem qualified_worker_request com slots e case_number (sem links)', async () => {
    mockQuery
      // 1. SELECT job_posting (case_number + meet links)
      .mockResolvedValueOnce({ rows: [vacancyRow] })
      // 2. SELECT worker
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] })
      // 3. INSERT outbox
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      // 4. UPDATE worker_job_applications
      .mockResolvedValueOnce({ rows: [] });

    await handler(payload);

    // Verifica INSERT na outbox com template qualified_worker_request
    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[0]).toContain('qualified_worker_request');
    expect(insertCall[1][1]).toBe('job-1'); // coluna job_posting_id preenchida
    const vars = JSON.parse(insertCall[1][2]);
    expect(vars.slot_1).toBe(formatSlotOption(DT_1));
    expect(vars.slot_2).toBe(formatSlotOption(DT_2));
    expect(vars.slot_3).toBe(formatSlotOption(DT_3));
    expect(vars.case_number).toBe('42');
    expect(vars.job_posting_id).toBe('job-1');
    // Links não são enviados — BookSlotFromWhatsAppUseCase busca do job_postings
    expect(vars.link_1).toBeUndefined();
    expect(vars.link_2).toBeUndefined();
    expect(vars.link_3).toBeUndefined();
  });

  it('pula envio se vaga não encontrada', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await handler(payload);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  it('pula envio se vaga sem meet links configurados (todos null)', async () => {
    const emptyVacancy = {
      case_number: 42,
      meet_link_1: null,
      meet_datetime_1: null,
      meet_link_2: null,
      meet_datetime_2: null,
      meet_link_3: null,
      meet_datetime_3: null,
    };
    mockQuery.mockResolvedValueOnce({ rows: [emptyVacancy] });

    await handler(payload);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  it('pula envio se meet_link_1 existe mas meet_datetime_1 é null', async () => {
    const linkSemDatetime = {
      case_number: 42,
      meet_link_1: 'https://meet.google.com/abc-1',
      meet_datetime_1: null,
      meet_link_2: null,
      meet_datetime_2: null,
      meet_link_3: null,
      meet_datetime_3: null,
    };
    mockQuery.mockResolvedValueOnce({ rows: [linkSemDatetime] });

    await handler(payload);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  it('pula envio se meet_datetime_1 existe mas meet_link_1 é null', async () => {
    const datetimeSemLink = {
      case_number: 42,
      meet_link_1: null,
      meet_datetime_1: DT_1,
      meet_link_2: null,
      meet_datetime_2: null,
      meet_link_3: null,
      meet_datetime_3: null,
    };
    mockQuery.mockResolvedValueOnce({ rows: [datetimeSemLink] });

    await handler(payload);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  it('pula envio se worker não encontrado', async () => {
    mockQuery
      // 1. SELECT job_posting — encontra vaga
      .mockResolvedValueOnce({ rows: [vacancyRow] })
      // 2. SELECT worker — não encontra
      .mockResolvedValueOnce({ rows: [] });

    await handler(payload);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  it('publica outbox-enqueued no Pub/Sub após inserir na outbox', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [vacancyRow] })
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-99' }] })
      .mockResolvedValueOnce({ rows: [] });

    await handler(payload);

    expect(mockPubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-99' });
  });

  it('marca interview_response = pending na worker_job_applications', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [vacancyRow] })
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await handler(payload);

    const updateCall = mockQuery.mock.calls[3];
    expect(updateCall[0]).toContain('interview_response');
    expect(updateCall[0]).toContain('pending');
    expect(updateCall[1]).toEqual(['worker-1', 'job-1']);
  });

  it('com 2 meet links, slot_3 repete o último horário válido (nunca vazio)', async () => {
    const twoLinksVacancy = {
      case_number: 42,
      meet_link_1: 'https://meet.google.com/abc-1',
      meet_datetime_1: DT_1,
      meet_link_2: 'https://meet.google.com/abc-2',
      meet_datetime_2: DT_2,
      meet_link_3: null,
      meet_datetime_3: null,
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [twoLinksVacancy] })
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await handler(payload);

    const insertCall = mockQuery.mock.calls[2];
    const vars = JSON.parse(insertCall[1][2]);
    expect(vars.slot_1).toBe(formatSlotOption(DT_1));
    expect(vars.slot_2).toBe(formatSlotOption(DT_2));
    expect(vars.slot_3).toBe(formatSlotOption(DT_2)); // repete, não vazio
  });

  it('com apenas 1 meet link, slots 2 e 3 repetem o horário 1 (nunca vazios)', async () => {
    const partialVacancy = {
      case_number: 42,
      meet_link_1: 'https://meet.google.com/abc-1',
      meet_datetime_1: DT_1,
      meet_link_2: null,
      meet_datetime_2: null,
      meet_link_3: null,
      meet_datetime_3: null,
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [partialVacancy] })
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await handler(payload);

    const insertCall = mockQuery.mock.calls[2];
    const vars = JSON.parse(insertCall[1][2]);
    expect(vars.slot_1).toBe(formatSlotOption(DT_1));
    expect(vars.slot_2).toBe(formatSlotOption(DT_1));
    expect(vars.slot_3).toBe(formatSlotOption(DT_1));
  });

  it('descarta slot no PASSADO: convite usa só os futuros', async () => {
    const mixedVacancy = {
      case_number: 42,
      meet_link_1: 'https://meet.google.com/abc-1',
      meet_datetime_1: '2026-06-08T11:30:00Z', // passado (bug real de prod: "Lun 08/06")
      meet_link_2: 'https://meet.google.com/abc-2',
      meet_datetime_2: DT_2,
      meet_link_3: null,
      meet_datetime_3: null,
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [mixedVacancy] })
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await handler(payload);

    const insertCall = mockQuery.mock.calls[2];
    const vars = JSON.parse(insertCall[1][2]);
    expect(vars.slot_1).toBe(formatSlotOption(DT_2));
    expect(vars.slot_2).toBe(formatSlotOption(DT_2));
    expect(vars.slot_3).toBe(formatSlotOption(DT_2));
  });

  it('pula envio se TODOS os slots estão no passado', async () => {
    const staleVacancy = {
      case_number: 42,
      meet_link_1: 'https://meet.google.com/abc-1',
      meet_datetime_1: '2026-06-08T11:30:00Z',
      meet_link_2: 'https://meet.google.com/abc-2',
      meet_datetime_2: '2026-06-17T11:30:00Z',
      meet_link_3: null,
      meet_datetime_3: null,
    };
    mockQuery.mockResolvedValueOnce({ rows: [staleVacancy] });

    await handler(payload);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  it('case_number null produz "—" (variável vazia é rejeitada pela Meta)', async () => {
    const vacancyNullCase = {
      ...vacancyRow,
      case_number: null,
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [vacancyNullCase] })
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await handler(payload);

    const insertCall = mockQuery.mock.calls[2];
    const vars = JSON.parse(insertCall[1][2]);
    expect(vars.case_number).toBe('—');
  });

  it('inclui job_posting_id nas variáveis da outbox', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [vacancyRow] })
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await handler(payload);

    const insertCall = mockQuery.mock.calls[2];
    const vars = JSON.parse(insertCall[1][2]);
    expect(vars.job_posting_id).toBe('job-1');
  });

  it('insere na outbox com status pending e attempts 0', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [vacancyRow] })
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await handler(payload);

    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[0]).toContain("'pending'");
    expect(insertCall[0]).toContain('0');
    expect(insertCall[1][0]).toBe('worker-1');
    expect(insertCall[1][1]).toBe('job-1');
  });

  describe('formatSlotOption', () => {
    it('formata datetime ISO para "Dia DD/MM HH:MM"', () => {
      expect(formatSlotOption('2026-04-07T10:00:00Z')).toBe('Mar 07/04 10:00');
    });

    it('formata horário com minutos', () => {
      expect(formatSlotOption('2026-04-08T15:30:00Z')).toBe('Mié 08/04 15:30');
    });

    it('aceita objeto Date', () => {
      const date = new Date('2026-04-09T09:00:00Z');
      expect(formatSlotOption(date)).toBe('Jue 09/04 09:00');
    });

    it('formata sábado e domingo corretamente', () => {
      expect(formatSlotOption('2026-04-11T14:00:00Z')).toBe('Sáb 11/04 14:00');
      expect(formatSlotOption('2026-04-12T08:00:00Z')).toBe('Dom 12/04 08:00');
    });
  });
});
