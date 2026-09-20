// A lib direta do pdf-parse (o `index.js` roda um autoteste ao ser importado em ESM). Só o que o teste usa.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    numpages: number;
    text: string;
  }
  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdfParse;
}
