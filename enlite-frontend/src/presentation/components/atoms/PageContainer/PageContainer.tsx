import type { ReactNode } from 'react';

interface PageContainerProps {
  children: ReactNode;
  className?: string;
}

export function PageContainer({ children, className }: PageContainerProps) {
  return (
    <div className="w-full min-h-screen bg-background">
      <div
        className={`max-w-[1600px] mx-auto px-4 sm:px-6 md:px-8 lg:px-12 py-8${
          className ? ` ${className}` : ''
        }`}
      >
        {children}
      </div>
    </div>
  );
}
