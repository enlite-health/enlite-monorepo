import { mapPeriskopeAckToDeliveryStatus } from '../periskopeAckMapping';

// Semântica oficial: https://docs.periskope.app/api-reference/delivery-status.md
describe('mapPeriskopeAckToDeliveryStatus', () => {
  it('mapeia 1 (sent to WhatsApp servers) para "sent"', () => {
    expect(mapPeriskopeAckToDeliveryStatus(1)).toBe('sent');
  });

  it('mapeia 2 (delivered to WhatsApp SERVERS, não ao destinatário) para "sent"', () => {
    expect(mapPeriskopeAckToDeliveryStatus(2)).toBe('sent');
  });

  it('mapeia 3 (delivered to all recipients — aparelho) para "delivered"', () => {
    expect(mapPeriskopeAckToDeliveryStatus(3)).toBe('delivered');
  });

  it('mapeia 4 (read by all) para "read"', () => {
    expect(mapPeriskopeAckToDeliveryStatus(4)).toBe('read');
  });

  it('mapeia 5 (played — áudio/vídeo) para "read"', () => {
    expect(mapPeriskopeAckToDeliveryStatus(5)).toBe('read');
  });

  it('mapeia -1 (failed) para "failed"', () => {
    expect(mapPeriskopeAckToDeliveryStatus(-1)).toBe('failed');
  });

  it('retorna null para 0 (pending send — fila local)', () => {
    expect(mapPeriskopeAckToDeliveryStatus(0)).toBeNull();
  });

  it('retorna null para valores desconhecidos (defensivo — nunca inventa status novo)', () => {
    expect(mapPeriskopeAckToDeliveryStatus(99)).toBeNull();
  });
});
