declare module 'next-auth' {
  /**
   * The session shape this app actually uses.
   *
   * Declared explicitly rather than as an intersection with
   * `DefaultSession['user']`, because that resolves through the adapter's
   * `AdapterUser`, which types `email` as a required non-null string. A GitHub
   * account with a private email genuinely has no email, so the honest type is
   * nullable — coercing it to `''` would push a fake value into roster matching,
   * where it could match the wrong student.
   */
  interface Session {
    user: {
      id: string
      name: string | null
      email: string | null
      image: string | null
      githubLogin: string | null
      isSiteAdmin: boolean
      isFaculty: boolean
    }
  }

  interface User {
    // String, not bigint: Auth.js JSON-serializes the session. See config.ts.
    githubId?: string | null
    githubLogin?: string | null
    isSiteAdmin?: boolean
    isFaculty?: boolean
  }
}

export {}
