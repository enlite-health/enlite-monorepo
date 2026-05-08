import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import * as functions from 'firebase-functions';

/**
 * ClickUpHmacMiddleware — validates X-Signature HMAC-SHA256 on ClickUp webhook requests.
 *
 * ClickUp signs the raw request body with the webhook's secret and includes the hex
 * digest in the X-Signature header. This middleware verifies that signature before
 * the controller processes the event.
 *
 * Requires rawBody to be captured upstream (express.json verify callback).
 * Uses crypto.timingSafeEqual to prevent timing-based signature oracle attacks.
 */
export class ClickUpHmacMiddleware {
  constructor(private readonly secret: string) {
    if (!secret) throw new Error('ClickUpHmacMiddleware requires a non-empty secret');
  }

  verify() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const signature = req.header('X-Signature');
      const rawBody   = req.rawBody;

      if (!signature) {
        functions.logger.warn('clickup_webhook.hmac_missing', { url: req.url });
        res.status(401).json({ success: false, error: 'X-Signature header missing' });
        return;
      }

      if (rawBody === undefined) {
        functions.logger.error('clickup_webhook.raw_body_missing', { url: req.url });
        res.status(500).json({ success: false, error: 'raw body capture failed' });
        return;
      }

      const expected = crypto
        .createHmac('sha256', this.secret)
        .update(rawBody)
        .digest('hex');

      // timingSafeEqual requires equal-length buffers; compare after that check.
      const sigBuf = Buffer.from(signature, 'utf8');
      const expBuf = Buffer.from(expected,  'utf8');
      const valid  =
        sigBuf.length === expBuf.length &&
        crypto.timingSafeEqual(sigBuf, expBuf);

      if (!valid) {
        functions.logger.warn('clickup_webhook.hmac_invalid', { url: req.url });
        res.status(401).json({ success: false, error: 'invalid signature' });
        return;
      }

      next();
    };
  }
}
