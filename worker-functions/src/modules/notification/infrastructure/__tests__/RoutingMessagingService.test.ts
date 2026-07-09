/**
 * RoutingMessagingService.test.ts
 *
 * Cenários:
 * 1. sem options.channel → despacha pro concreto default (twilio)
 * 2. sem options.channel, default configurado periskope → despacha periskope
 * 3. options.channel='twilio' explícito → sempre twilio, mesmo com default periskope
 * 4. options.channel='periskope', canal NÃO pausado → despacha periskope
 * 5. options.channel='periskope', canal PAUSADO → Result.fail(PERISKOPE_PAUSED_ERROR),
 *    concreto periskope NUNCA é chamado
 * 6. sendWithContentSid sempre delega ao twilio (Content API é conceito Twilio-only)
 */
import { RoutingMessagingService, PERISKOPE_PAUSED_ERROR } from '../RoutingMessagingService';
import { Result } from '@shared/utils/Result';

function makeConcrete(name: string) {
  return {
    sendWhatsApp: jest.fn().mockResolvedValue(
      Result.ok({ externalId: `${name}-sid`, status: 'queued', to: '+5511999990000' }),
    ),
    sendWithContentSid: jest.fn().mockResolvedValue(
      Result.ok({ externalId: `${name}-content-sid`, status: 'queued', to: '+5511999990000' }),
    ),
  };
}

describe('RoutingMessagingService', () => {
  let twilio: ReturnType<typeof makeConcrete>;
  let periskope: ReturnType<typeof makeConcrete>;
  let pauseCache: { isPaused: jest.Mock };

  beforeEach(() => {
    twilio = makeConcrete('twilio');
    periskope = makeConcrete('periskope');
    pauseCache = { isPaused: jest.fn().mockResolvedValue(false) };
  });

  it('sem channel → despacha pro default (twilio)', async () => {
    const router = new RoutingMessagingService(twilio as any, periskope as any, pauseCache as any, 'twilio');

    const result = await router.sendWhatsApp({ to: '+5511999999999', templateSlug: 'tpl' });

    expect(result.isSuccess).toBe(true);
    expect(twilio.sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(periskope.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('sem channel, default=periskope → despacha periskope', async () => {
    const router = new RoutingMessagingService(twilio as any, periskope as any, pauseCache as any, 'periskope');

    await router.sendWhatsApp({ to: '+5511999999999', templateSlug: 'tpl' });

    expect(periskope.sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('channel=twilio explícito prevalece sobre default periskope', async () => {
    const router = new RoutingMessagingService(twilio as any, periskope as any, pauseCache as any, 'periskope');

    await router.sendWhatsApp({ to: '+5511999999999', templateSlug: 'tpl', channel: 'twilio' });

    expect(twilio.sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(periskope.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('channel=periskope, não pausado → despacha periskope', async () => {
    const router = new RoutingMessagingService(twilio as any, periskope as any, pauseCache as any, 'twilio');

    const result = await router.sendWhatsApp({ to: '+5511999999999', templateSlug: 'tpl', channel: 'periskope' });

    expect(result.isSuccess).toBe(true);
    expect(pauseCache.isPaused).toHaveBeenCalledWith('periskope');
    expect(periskope.sendWhatsApp).toHaveBeenCalledTimes(1);
  });

  it('channel=periskope, PAUSADO → Result.fail reprocessável, periskope nunca chamado', async () => {
    pauseCache.isPaused.mockResolvedValue(true);
    const router = new RoutingMessagingService(twilio as any, periskope as any, pauseCache as any, 'twilio');

    const result = await router.sendWhatsApp({ to: '+5511999999999', templateSlug: 'tpl', channel: 'periskope' });

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe(PERISKOPE_PAUSED_ERROR);
    expect(periskope.sendWhatsApp).not.toHaveBeenCalled();
    expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('sendWithContentSid sempre delega ao twilio', async () => {
    const router = new RoutingMessagingService(twilio as any, periskope as any, pauseCache as any, 'periskope');

    await router.sendWithContentSid('+5511999999999', 'HXabc', { '1': 'Maria' });

    expect(twilio.sendWithContentSid).toHaveBeenCalledWith('+5511999999999', 'HXabc', { '1': 'Maria' });
    expect(periskope.sendWithContentSid).not.toHaveBeenCalled();
  });
});
