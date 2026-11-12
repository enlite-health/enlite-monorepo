import { ButtonHTMLAttributes, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type { ButtonVariant, ButtonSize, ButtonShape } from './buttonClasses';
import { buttonClasses, type ButtonShape, type ButtonSize, type ButtonVariant } from './buttonClasses';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  children: ReactNode;
  fullWidth?: boolean;
  borderColor?: string;
  textColor?: string;
  isLoading?: boolean;
}

export const Button = ({
  variant = 'primary',
  size = 'md',
  shape = 'pill',
  children,
  fullWidth = false,
  borderColor,
  textColor,
  isLoading = false,
  className = '',
  disabled,
  ...props
}: ButtonProps) => {
  const { t } = useTranslation();

  const customBorderColor = borderColor ? `border-[${borderColor}]` : '';
  const customTextColor = textColor ? `text-[${textColor}]` : '';

  const classes = [
    buttonClasses({ variant, size, fullWidth, shape }),
    customBorderColor,
    customTextColor,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      className={classes}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading ? t('common.loading') : children}
    </button>
  );
};
