import Image from 'next/image'
import Link from 'next/link'

import { PipelineDiagram } from '@/components/landing/pipeline-diagram'
import { ThemeToggle } from '@/components/theme-toggle'
import { ButtonLink } from '@/components/ui/button'

/**
 * The public front page.
 *
 * Written for faculty deciding whether to use this, because they are the only people
 * who arrive here without a link. Students never see it: they follow an invite URL
 * straight to /join/<token>, which is exactly why the old page — a bare "Sign in"
 * button — was worth replacing. It looked like a wall, and it was addressed to
 * nobody.
 *
 * There is deliberately no prominent generic sign-in. The two ways in are specific:
 * administrators have a door of their own, and faculty arrive holding an invitation.
 */

const FEATURES: { title: string; body: string }[] = [
  {
    title: 'Your organization, your repositories',
    body: 'Assignments are generated into a GitHub organization you own. Students work in real repositories, with real Actions and real pull requests — not a simulation of them.',
  },
  {
    title: 'Canvas roster in, grades back out',
    body: 'Import a Gradebook CSV and get a diff preview before anything changes. Export a file Canvas matches on the identity columns it gave you, so nobody is imported twice.',
  },
  {
    title: 'Individual and group work',
    body: 'One repository per student, or one per team with a GitHub team behind it. Late joiners are added to the existing team rather than getting a second repository.',
  },
  {
    title: 'Autograding on every push',
    body: 'A workflow runs your tests and reports a score per student. It pulls results rather than having repositories push to you, so grading survives the app being offline.',
  },
  {
    title: 'Feedback pull requests',
    body: 'An open pull request per student, pinned to the starting state, so its diff always shows the whole submission and you can comment line by line.',
  },
  {
    title: 'Deadlines and extensions',
    body: 'Per-student and per-team extensions, an optional lock at the deadline, and the commit SHA at the deadline recorded so late pushes stay visible either way.',
  },
]

const STEPS = [
  'Import your Canvas roster and share one invite link.',
  'Students sign in with GitHub and claim their own name from the roster.',
  'Create an assignment from a template; every student gets a repository.',
  'Autograded scores collect, and a CSV goes back to Canvas.',
]

export function LandingPage() {
  return (
    <>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto max-w-6xl px-6 h-14 flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 font-semibold">
            <Image
              src="/ucf-pegasus.png"
              alt=""
              aria-hidden
              width={192}
              height={192}
              priority
              className="size-6 shrink-0 dark:invert"
            />
            <span>UCF-Code-Connect</span>
          </span>
          {/* Available before signing in, because a reader who cannot comfortably
              read this page needs to fix that here, not after authenticating. */}
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-6xl px-6 pt-16 pb-12 text-center uccc-rise">
          <p className="text-sm font-medium text-accent uppercase tracking-wide">
            Course tooling for computer science
          </p>
          <h1 className="mt-3 text-4xl sm:text-5xl font-semibold tracking-tight text-balance">
            Coursework on real GitHub, managed from one place
          </h1>
          <p className="mt-5 mx-auto max-w-2xl text-lg text-muted text-pretty">
            UCF-Code-Connect turns a Canvas roster into per-student GitHub repositories,
            grades them with Actions, and sends the marks back — all inside an organization
            you control.
          </p>

          <div className="mt-8 flex flex-wrap gap-3 justify-center">
            <ButtonLink href="#how-it-works" variant="accent">
              See how it works
            </ButtonLink>
            <ButtonLink href="#access" variant="outline">
              Get access
            </ButtonLink>
          </div>
        </section>

        <section
          id="how-it-works"
          className="mx-auto max-w-6xl px-6 py-12 scroll-mt-8"
          aria-labelledby="how-heading"
        >
          <h2 id="how-heading" className="sr-only">
            How it works
          </h2>
          <div className="flex justify-center uccc-rise" style={{ animationDelay: '0.1s' }}>
            <PipelineDiagram />
          </div>

          <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 max-w-4xl mx-auto">
            {STEPS.map((step, i) => (
              <li
                key={step}
                className="rounded-lg border border-border bg-surface p-4 uccc-rise"
                style={{ animationDelay: `${0.15 + i * 0.08}s` }}
              >
                <span className="inline-flex items-center justify-center size-6 rounded-full bg-accent-bright text-accent-contrast text-xs font-semibold">
                  {i + 1}
                </span>
                <p className="mt-3 text-sm text-muted">{step}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-12" aria-labelledby="features-heading">
          <h2 id="features-heading" className="text-2xl font-semibold text-center">
            What it does
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <div
                key={f.title}
                className="rounded-lg border border-border bg-surface p-5 uccc-rise"
                style={{ animationDelay: `${i * 0.06}s` }}
              >
                <h3 className="font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-muted text-pretty">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section
          id="access"
          className="mx-auto max-w-3xl px-6 py-16 scroll-mt-8"
          aria-labelledby="access-heading"
        >
          <h2 id="access-heading" className="text-2xl font-semibold text-center">
            Getting access
          </h2>
          <p className="mt-3 text-center text-muted text-pretty">
            Accounts are not self-serve. Which door you use depends on who you are.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface p-5">
              <h3 className="font-semibold">Students</h3>
              <p className="mt-2 text-sm text-muted">
                Use the invite link your instructor gave you. It signs you in and lets you
                claim your name from the course roster. There is nothing to set up here
                first.
              </p>
            </div>

            <div className="rounded-lg border border-border bg-surface p-5">
              <h3 className="font-semibold">Faculty</h3>
              <p className="mt-2 text-sm text-muted">
                Teaching staff join by invitation from an administrator. If you have an
                invitation link, open it and accept — that is the whole process.
              </p>
            </div>
          </div>

          <p className="mt-8 text-center text-sm text-muted">
            Interested in using this for your course?{' '}
            <a href="mailto:kpmoran@ucf.edu?subject=UCF-Code-Connect%20access" className="underline">
              Ask for an invitation
            </a>
            .
          </p>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-6 flex flex-wrap items-center justify-between gap-4 text-sm text-muted">
          <span>UCF-Code-Connect</span>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/kpmoran/UCF-Code-Connect"
              className="hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              Source
            </a>
            {/*
             * Present but unadvertised. It is not a security boundary — anyone can
             * reach it and sign in with GitHub — but it keeps the front page from
             * reading as a login wall, and sends administrators somewhere that says
             * what it is for.
             */}
            <Link href="/admin/signin" className="hover:underline">
              Administrator sign-in
            </Link>
          </div>
        </div>
      </footer>
    </>
  )
}
