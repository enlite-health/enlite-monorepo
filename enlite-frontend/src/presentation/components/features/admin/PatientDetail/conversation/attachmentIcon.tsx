/**
 * attachmentIcon — ícone lucide-react por `contentType` (D-14: os 4 tipos aceitos), compartilhado
 * entre `AttachmentPicker` (chip do rascunho) e `MessageAttachments` (chip da mensagem enviada,
 * `ThreadView.tsx`) — extraído para não duplicar o mesmo `if/if/if` nos dois lugares.
 */
import { FileText, Image as ImageIcon, FileType2, Paperclip, type LucideIcon } from 'lucide-react';

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg']);

/** Fallback (`Paperclip`) nunca é alcançado por um `contentType` que passou pela allowlist do
 * servidor (D-14) — defesa em profundidade, mesma decisão de honestidade de cobertura do backend
 * (`ConversationAttachmentValidator.ts`, `evidencias/b3-backend-anexo.md`): reportado como está. */
export function iconComponentForContentType(contentType: string): LucideIcon {
  if (contentType === 'application/pdf') return FileText;
  if (IMAGE_CONTENT_TYPES.has(contentType)) return ImageIcon;
  if (contentType.includes('wordprocessingml')) return FileType2;
  return Paperclip;
}

/** Extensão legível a partir do `contentType` — a listagem (`GET .../conversation`) nunca devolve
 * o nome original (D-02: só decifra no download), então o rótulo do chip enviado usa isto. */
export function extensionForContentType(contentType: string): string {
  if (contentType === 'application/pdf') return '.pdf';
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/jpeg') return '.jpg';
  if (contentType.includes('wordprocessingml')) return '.docx';
  return '';
}
