import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'

import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'UCF Code Classroom',
  description: 'Course assignment management backed by GitHub.',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // React would otherwise warn about the attribute the script below adds before
      // hydration: the server rendered no data-theme and the client has one.
      suppressHydrationWarning
    >
      <head>
        {/*
         * Applies the saved theme before the first paint.
         *
         * Has to be inline and synchronous in <head>. Anything deferred — a client
         * component effect, a module import — runs after the browser has already
         * painted, so a reader who forces light on a dark machine sees a dark flash
         * on every navigation. That flash is worst for exactly the people a theme
         * control is for.
         *
         * Wrapped in try/catch because localStorage throws in Safari private
         * browsing, and an exception here would abort the rest of the document.
         */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('uccc-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  )
}
