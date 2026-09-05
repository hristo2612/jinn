import { createElement, Suspense } from 'react'
import { act, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RouteFailure } from '../route-failure'
import { lazyRoute } from '@/lib/lazy-route'

afterEach(() => vi.restoreAllMocks())

describe('route failure recovery', () => {
  it('explains offline import failure without spending the stale-deploy reload retry', async () => {
    const connectivity = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    sessionStorage.clear()
    const Route = lazyRoute(async () => {
      throw new TypeError('Failed to fetch dynamically imported module')
    }, 'offline-test')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const router = createMemoryRouter([{
      path: '/',
      element: createElement(Suspense, { fallback: 'Loading' }, createElement(Route)),
      errorElement: <RouteFailure />,
    }])
    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { name: "You're offline" })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(true)
    expect(sessionStorage.getItem('jinn:chunk-retry:offline-test:/')).toBeNull()
    connectivity.mockReturnValue(true)
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(screen.getByRole('heading', { name: 'This page could not load' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false)
    router.dispose()
  })

  it('gives online route failures a recovery action without exposing the exception', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const router = createMemoryRouter([{
      path: '/',
      loader: () => { throw new Error('internal diagnostic details') },
      element: <div>Page</div>,
      errorElement: <RouteFailure />,
    }])
    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { name: 'This page could not load' })).toBeTruthy()
    expect(screen.queryByText(/internal diagnostic details/)).toBeNull()
    router.dispose()
  })
})
