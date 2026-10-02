import { describe, it, expect } from 'vitest';
import { formatFileSize, isImageContentType } from '../attachmentIcon';

describe('formatFileSize', () => {
  it('abaixo de 1024 bytes: mostra em B', () => {
    expect(formatFileSize(500)).toBe('500 B');
  });

  it('KB: arredonda, sem casa decimal (ex.: "120 KB")', () => {
    expect(formatFileSize(123 * 1024)).toBe('123 KB');
  });

  it('MB: 1 casa decimal', () => {
    expect(formatFileSize(2.3 * 1024 * 1024)).toBe('2.3 MB');
  });

  it('exatamente 1024 bytes vira 1 KB, não 1024 B', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
  });
});

describe('isImageContentType', () => {
  it('png e jpeg são imagem', () => {
    expect(isImageContentType('image/png')).toBe(true);
    expect(isImageContentType('image/jpeg')).toBe(true);
  });

  it('pdf e docx não são imagem', () => {
    expect(isImageContentType('application/pdf')).toBe(false);
    expect(isImageContentType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
  });
});
