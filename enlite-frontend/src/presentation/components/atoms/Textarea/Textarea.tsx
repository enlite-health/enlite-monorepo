import { forwardRef, TextareaHTMLAttributes } from 'react';
import { textareaBaseClasses, type InputSize } from '../Input/inputClasses';

export type TextareaResize = 'none' | 'vertical' | 'both';

const RESIZE_CLASSES: Record<TextareaResize, string> = {
  none: 'resize-none',
  vertical: 'resize-y',
  both: 'resize',
};

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string;
  inputSize?: InputSize;
  resize?: TextareaResize;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    {
      error,
      inputSize = 'default',
      resize = 'none',
      disabled,
      className = '',
      ...props
    },
    ref
  ) {
    const classes = [
      textareaBaseClasses({ size: inputSize, error: !!error, disabled }),
      RESIZE_CLASSES[resize],
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <textarea
        ref={ref}
        disabled={disabled}
        aria-invalid={!!error}
        className={classes}
        {...props}
      />
    );
  }
);
