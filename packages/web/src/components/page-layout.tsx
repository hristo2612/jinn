"use client"

import { ThemeProvider } from "@/app/providers"
import { SettingsProvider } from "@/app/settings-provider"
import { Sidebar } from "./sidebar"
import { GlobalSearch } from "./global-search"
import { LiveStreamWidget } from "./live-stream-widget"
import { OnboardingWizard } from "./onboarding-wizard"

export function PageLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <div className="flex h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
          <Sidebar />
          <GlobalSearch />
          <main className="flex-1 overflow-hidden">
            <div className="md:hidden" style={{ height: 48 }} />
            {children}
          </main>
          <LiveStreamWidget />
          <OnboardingWizard />
        </div>
      </SettingsProvider>
    </ThemeProvider>
  )
}
