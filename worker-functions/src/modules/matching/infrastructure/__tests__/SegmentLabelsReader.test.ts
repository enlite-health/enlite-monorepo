import { SegmentLabelsReader } from '../SegmentLabelsReader';

describe('SegmentLabelsReader (DD-17)', () => {
  it('lê todos os rótulos por sort_order, sem filtrar `active`', async () => {
    const query = jest.fn(async () => ({ rows: [{ label: 'SEG-A' }, { label: 'SEG-B' }] }));
    const labels = await new SegmentLabelsReader({ query } as never).list();
    expect(labels).toEqual(['SEG-A', 'SEG-B']);
    const sql = (query.mock.calls[0] as unknown as [string])[0];
    expect(sql).toContain('FROM therapeutic_segments');
    expect(sql).toContain('ORDER BY sort_order, lower(label)');
    expect(sql).not.toMatch(/active/i);
  });

  it('banco sem segmentos devolve lista vazia (o gerador é quem recusa)', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    expect(await new SegmentLabelsReader({ query } as never).list()).toEqual([]);
  });
});
