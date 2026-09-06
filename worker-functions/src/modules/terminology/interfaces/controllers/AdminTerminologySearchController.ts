/**
 * AdminTerminologySearchController — GET /api/admin/terminology/search?q=&lang=es&chapters=06,08
 * (spec 016 F2, "Contrato de arquitetura"). A tela de admissão enxerga só `search` — não
 * `getByUri`/`ancestorsOf` (ISP: "a tela de admissão não enxerga ancestorsOf").
 *
 * 🔴 A resposta é `{ uri, title }` — NUNCA `code` nem `chapter` (REQ-21: o código para no
 * servidor). 503 quando a porta está indisponível (US-4: falha VISÍVEL, nunca `[]` silencioso).
 */
import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { MIN_SEARCH_QUERY_LENGTH, type TerminologyPort } from '../../domain/TerminologyPort';
import { createTerminologyPort } from '../../infrastructure/TerminologyPortFactory';
import { TerminologyUnavailableError } from '../../domain/UnavailableTerminology';
import { terminologySearchQuerySchema } from '../validators/terminologySearchSchema';

export class AdminTerminologySearchController {
  constructor(private readonly terminology: TerminologyPort = createTerminologyPort(process.env)) {}

  /** GET /api/admin/terminology/search */
  async search(req: Request, res: Response): Promise<void> {
    const query = terminologySearchQuerySchema.safeParse(req.query);
    if (!query.success) {
      // T10 — o 400 DIZ o piso. Antes, `?q=a` passava (zod `min(1)`), o adaptador devolvia []
      // pelo piso próprio dele (2) e a API respondia 200 com lista vazia: "não perguntei" ficava
      // indistinguível de "não há". Agora recusa, e a recusa carrega o número — o cliente não
      // precisa adivinhar nem manter uma 3ª cópia da constante.
      res.status(400).json({
        success: false,
        error: 'Invalid query',
        details: { fields: Object.keys(query.error.flatten().fieldErrors), minQueryLength: MIN_SEARCH_QUERY_LENGTH },
      });
      return;
    }
    try {
      const candidates = await this.terminology.search(query.data.q, {
        lang: query.data.lang,
        chapters: query.data.chapters,
      });
      res.status(200).json({
        success: true,
        data: { candidates: candidates.map((c) => ({ uri: c.uri, title: c.title })) },
      });
    } catch (err: unknown) {
      if (err instanceof TerminologyUnavailableError) {
        res.status(503).json({ success: false, error: err.message, code: 'TERMINOLOGY_UNAVAILABLE' });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTerminologySearchController:search' });
      res.status(500).json({ success: false, error: 'Failed to search terminology' });
    }
  }
}
