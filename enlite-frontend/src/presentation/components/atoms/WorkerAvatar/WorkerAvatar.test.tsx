import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkerAvatar } from './WorkerAvatar';

describe('WorkerAvatar', () => {
  it('renders img when avatarUrl is provided', () => {
    render(<WorkerAvatar name="Juan Pérez" avatarUrl="https://example.com/avatar.jpg" />);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.jpg');
    expect(img).toHaveAttribute('alt', 'Juan Pérez');
  });

  it('renders initials when avatarUrl is null', () => {
    render(<WorkerAvatar name="Juan Pérez" avatarUrl={null} />);
    expect(screen.getByText('JP')).toBeInTheDocument();
  });

  it('renders initials for single name', () => {
    render(<WorkerAvatar name="Maria" avatarUrl={null} />);
    expect(screen.getByText('M')).toBeInTheDocument();
  });

  it('renders ? when name is null and no avatar', () => {
    render(<WorkerAvatar name={null} avatarUrl={null} />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('applies custom size', () => {
    render(<WorkerAvatar name="Ana" avatarUrl={null} size={48} />);
    const el = screen.getByText('A');
    expect(el).toHaveStyle({ width: '48px', height: '48px' });
  });

  it('applies custom className', () => {
    render(<WorkerAvatar name="Ana" avatarUrl={null} className="custom-class" />);
    expect(screen.getByText('A')).toHaveClass('custom-class');
  });
});
