# The front page

`/` is a public landing page for signed-out visitors and the classroom dashboard for
everyone else. It is written for faculty deciding whether to use this, because they are
the only people who reach it without a link — students arrive on `/join/<token>` and
never see it. The page it replaced was a bare "Sign in" button addressed to nobody,
which read as a wall.

There is no generic sign-in on it. The ways in are specific:

| Who | Where |
|---|---|
| Students | the invite link their instructor sends |
| Faculty | the invitation link an administrator sends |
| Administrators | `/admin/signin`, linked discreetly in the footer |

`/admin/signin` is **framing, not a permission check**. There is one authentication
mechanism — GitHub OAuth — so it is the same button pointed at a different destination.
Anyone may open it and sign in, and will land on an empty dashboard unless
`SITE_ADMIN_LOGINS` names them. It has to be in the proxy's public list, because the
only people it serves are signed out; leaving it behind the cookie wall bounced them to
`/signin` and made it a link to nowhere.

**`/signin` must keep existing.** The proxy sends signed-out visitors there with `next`
set, which is how every classroom invite link works. Removing it would dead-end student
registration.

Motion on the landing page runs through two classes, `uccc-flow` and `uccc-rise`, so
its behaviour is one change rather than many.

**It plays for everyone, including readers whose system requests reduced motion.** That
is a deliberate decision, recorded here because it otherwise reads as an oversight. The
cost is real: `prefers-reduced-motion` is set by people for whom movement triggers
vestibular symptoms or migraine, and a landing page is reached without warning. To
honour the preference again, add this back to `globals.css`:

```css
@media (prefers-reduced-motion: reduce) {
  .uccc-flow { animation: none; }
  .uccc-rise { animation: none; opacity: 1; transform: none; }
}
```

The `opacity: 1` there is not optional. `uccc-rise` begins at `opacity: 0`, so disabling
the animation without restoring opacity leaves the content permanently invisible — worse
than either motion setting, and easy to ship without noticing. There is a test asserting
no element is left transparent under **either** preference, which stays true regardless
of which way the decision goes.
