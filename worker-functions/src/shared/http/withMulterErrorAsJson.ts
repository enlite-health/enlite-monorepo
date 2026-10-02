/**
 * withMulterErrorAsJson — normaliza o erro do `multer` em JSON (spec 018, PR-4;
 * `adminPatientPhotoRoutes.ts`). `multer` devolve 413 PURO (corpo vazio, sem JSON) quando o
 * arquivo estoura `limits.fileSize` — sem isto, toda rota de upload de arquivo teria que
 * reimplementar a mesma tradução.
 *
 * Extraído para `@shared/http` na spec 022, Bloco 3 (T312): a rota de anexo de conversa precisava
 * do MESMO comportamento, e copiar as ~15 linhas de novo violaria "zero código repetido"
 * (`revisao-pr`) — `adminPatientPhotoRoutes.ts` foi atualizada para importar daqui em vez de manter
 * a cópia local.
 */
import type { Request, Response } from 'express';
import type multer from 'multer';

export function withMulterErrorAsJson(mw: ReturnType<typeof multer>) {
  return (fieldName: string) => (req: Request, res: Response, next: (err?: unknown) => void) => {
    mw.single(fieldName)(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ success: false, error: 'Arquivo excede o limite', code: 'FILE_TOO_LARGE' });
          return;
        }
        res.status(400).json({ success: false, error: 'Falha no upload multipart' });
        return;
      }
      next();
    });
  };
}
