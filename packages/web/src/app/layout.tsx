import type { Metadata, Viewport } from "next"
import { ClientProviders } from "./client-providers"
import "./globals.css"

export const metadata: Metadata = {
  description: "AI Gateway Dashboard",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Polyfill crypto.randomUUID for non-secure contexts (plain HTTP over LAN/Tailscale) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if(typeof crypto!=='undefined'&&!crypto.randomUUID){crypto.randomUUID=function(){return'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,function(c){var r=crypto.getRandomValues(new Uint8Array(1))[0];return(c^(r&(15>>(c/4)))).toString(16)})}}`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('jinn-theme')||'dark';if(t==='system'){t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`,
          }}
        />
      </head>
      <body>
        <ClientProviders>
          {children}
        </ClientProviders>
      </body>
    </html>
  )
}
