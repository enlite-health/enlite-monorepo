import { ButtonHTMLAttributes, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type ButtonVariant = 'primary' | 'outline' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
  fullWidth?: boolean;
  borderColor?: string;
  textColor?: string;
  isLoading?: boolean;
}

// Tokens canônicos (Figma source of truth):
// - md (default): 40px height, 16px Poppins SemiBold (1.35 lh) — botão padrão "Editar"
// - sm:           32px height, 14px Poppins SemiBold — pills/ações secundárias
// - lg:           48px height, 16px Poppins SemiBold — CTAs principais
const sizeStyles: Record<ButtonSize, string> = {
  sm: 'h-8 px-4 text-sm',
  md: 'h-10 px-6 text-base',
  lg: 'h-12 px-8 text-base',
};

const variantStyles: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white border border-primary hover:bg-primary/90',
  outline: 'bg-transparent text-primary border-2 border-primary hover:bg-primary/5',
  ghost: 'bg-transparent text-primary border-0 hover:bg-primary/5',
};

const baseStyles =
  'inline-flex items-center justify-center gap-2 rounded-full overflow-hidden ' +
  'font-poppins font-semibold leading-[1.35] tracking-normal text-center ' +
  'transition-colors duration-200 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50';

export const Button = ({
  variant = 'primary',
  size = 'md',
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

  const widthStyle = fullWidth ? 'w-full' : '';
  const customBorderColor = borderColor ? `border-[${borderColor}]` : '';
  const customTextColor = textColor ? `text-[${textColor}]` : '';

  const classes = [
    baseStyles,
    sizeStyles[size],
    variantStyles[variant],
    widthStyle,
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
