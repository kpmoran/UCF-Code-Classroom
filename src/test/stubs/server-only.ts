// The real `server-only` package throws on import outside a React Server
// Component build. Vitest runs plain Node, so it is aliased to this no-op in
// vitest.config.ts. The guard still holds where it matters: `next build` uses
// the real package and will fail if server-only code reaches a client bundle.
export {}
