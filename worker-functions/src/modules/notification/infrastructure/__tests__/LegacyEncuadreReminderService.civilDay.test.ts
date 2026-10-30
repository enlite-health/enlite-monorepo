/** Relógio civil — o lembrete formata o dia civil do slot com `timeZone: 'UTC'` (29/10, nunca 28/10). Só mock de db: nada é enviado. */
import { LegacyEncuadreReminderService } from '../LegacyEncuadreReminderService';

describe('LegacyEncuadreReminderService — dia civil', () => {
  it('slot_date 2026-10-29 vira "29/10" na variável do template', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ encuadre_id: 'e1', worker_id: 'w1', slot_date: '2026-10-29', slot_time: '10:00:00', meet_link: null }],
      })
      .mockResolvedValue({ rows: [] });

    await new LegacyEncuadreReminderService({ query } as never).processEncuadreReminder('w1');

    const insert = query.mock.calls.find((c) => String(c[0]).includes('messaging_outbox'))!;
    expect(JSON.parse(insert[1][1]).date).toBe('29/10');
  });
});
