import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AssistRequestCard } from '../assist-request-card';

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'pending' }) })) as any;
});

describe('AssistRequestCard', () => {
  it('renders reason + url and Take control / Resume buttons', async () => {
    render(<AssistRequestCard reqId="r1" reason="captcha" url="http://x" status="pending" />);
    expect(screen.getByText(/captcha/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /take control/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /resume/i })).toBeTruthy();
  });

  it('Resume posts resolve', async () => {
    const fetchMock = global.fetch as any;
    render(<AssistRequestCard reqId="r1" reason="x" status="pending" />);
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/assist/r1/resolve'), expect.objectContaining({ method: 'POST' })));
  });

  it('shows resolved state without action buttons', () => {
    render(<AssistRequestCard reqId="r1" reason="x" status="resolved" />);
    expect(screen.queryByRole('button', { name: /take control/i })).toBeNull();
    expect(screen.getByText(/resolved/i)).toBeTruthy();
  });
});
