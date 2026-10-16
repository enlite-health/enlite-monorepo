import { TherapeuticContactReminderHealthService } from '../TherapeuticContactReminderHealthService';

describe('TherapeuticContactReminderHealthService (spec 048)', () => {
  it('conta SÓ lembrete aberto vencido além do limiar (24h por padrão) — o limiar é parâmetro da query, não de TS', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ overdue: 2, oldest_hours: 50 }] });
    const h = await new TherapeuticContactReminderHealthService({ query } as never).getHealth();
    expect(h).toEqual({ overdue: 2, oldestOverdueHours: 50 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('sent_at IS NULL AND cancelled_at IS NULL');
    expect(sql).toContain('due_at < now() - make_interval(hours => $1::int)');
    expect(params).toEqual([24]);
  });

  it('nenhum vencido: 0/0 (idade null do SQL vira 0)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ overdue: 0, oldest_hours: null }] });
    expect(await new TherapeuticContactReminderHealthService({ query } as never).getHealth(48)).toEqual({ overdue: 0, oldestOverdueHours: 0 });
    expect(query.mock.calls[0][1]).toEqual([48]);
  });
});
