/**
 * Geração do PDF no NAVEGADOR (D299.4) — e em Node, para o teste extrair o texto.
 *
 * Fontes (lex C11): Poppins e Lexend servidas da PRÓPRIA origem (`public/fonts`, OFL), registradas uma
 * vez. `registerPdfFonts(base)` recebe a base para o teste em Node apontar para caminhos de arquivo.
 * Nenhuma outra requisição sai durante a geração — o teste espia `fetch` e afirma zero chamadas.
 */
import { createElement, type ReactElement } from 'react';
import { Font, pdf, renderToBuffer, type DocumentProps } from '@react-pdf/renderer';
import { TherapeuticProjectPdfDocument } from './TherapeuticProjectPdfDocument';
import type { TherapeuticProjectPdfInput } from './therapeuticProjectPdfInput';

let fontsRegistered = false;

export function registerPdfFonts(base = '/fonts'): void {
  if (fontsRegistered) return;
  Font.register({
    family: 'Lexend',
    fonts: [
      { src: `${base}/Lexend-Regular.woff`, fontWeight: 400 },
      { src: `${base}/Lexend-Medium.woff`, fontWeight: 500 },
    ],
  });
  Font.register({
    family: 'Poppins',
    fonts: [
      { src: `${base}/Poppins-Regular.woff`, fontWeight: 400 },
      { src: `${base}/Poppins-SemiBold.woff`, fontWeight: 600 },
    ],
  });
  // Sem hifenização automática: o documento é em espanhol e o algoritmo padrão é o inglês.
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

/** O elemento raiz é um `<Document>`; a API do react-pdf tipa a raiz assim, o componente devolve JSX.Element. */
const documento = (input: TherapeuticProjectPdfInput): ReactElement<DocumentProps> =>
  createElement(TherapeuticProjectPdfDocument, { input }) as unknown as ReactElement<DocumentProps>;

/** Nome do arquivo baixado: sem nome de paciente (o arquivo circula; lex C14/C15). */
export function pdfFileName(input: TherapeuticProjectPdfInput): string {
  return `proyecto-terapeutico-caso-${input.caseRef}-${input.version.version.replace(/\./g, '_')}.pdf`;
}

/** Navegador: o Blob para download. */
export async function renderTherapeuticProjectPdfBlob(input: TherapeuticProjectPdfInput): Promise<Blob> {
  registerPdfFonts();
  return pdf(documento(input)).toBlob();
}

/** Node (teste): o Buffer para o `pdf-parse` ler o texto de volta. */
export async function renderTherapeuticProjectPdfBuffer(input: TherapeuticProjectPdfInput, fontsBase: string): Promise<Buffer> {
  registerPdfFonts(fontsBase);
  return renderToBuffer(documento(input));
}
