import { forwardRef, InputHTMLAttributes, ReactNode } from 'react';
import {
  inputBaseClasses,
  inputWrapperClasses,
  INPUT_INNER_CLASSES,
  type InputSize,
} from './inputClasses';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  error?: string;
  inputSize?: InputSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input(
    {
      error,
      inputSize = 'default',
      leftIcon,
      rightIcon,
      disabled,
      className = '',
      ...props
    },
    ref
  ) {
    const hasIcons = Boolean(leftIcon ?? rightIcon);

    if (hasIcons) {
      return (
        <div
          className={`${inputWrapperClasses({ size: inputSize, error: !!error, disabled })} ${className}`}
        >
          {leftIcon && (
            <span className="flex items-center shrink-0 mr-2">{leftIcon}</span>
          )}
          <input
            ref={ref}
            disabled={disabled}
            aria-invalid={!!error}
            className={INPUT_INNER_CLASSES}
            {...props}
          />
          {rightIcon && (
            <span className="flex items-center shrink-0 ml-2">{rightIcon}</span>
          )}
        </div>
      );
    }

    return (
      <input
        ref={ref}
        disabled={disabled}
        aria-invalid={!!error}
        className={`${inputBaseClasses({ size: inputSize, error: !!error, disabled })} ${className}`}
        {...props}
      />
    );
  }
);
