# Light and dark

The theme control, the redefined `dark:` variant, and why the favicon has a gold plate.

## The theme control

The theme follows the reader's system setting by default, and the control in the header
offers **Auto / Light / Dark**.

Three options rather than a switch, because "follow my system" is a real preference and
not the same as either fixed choice — a binary toggle discards it the first time you
touch the control, with no way back. It is a radio group, so it announces as one control
with three options and arrow keys move between them; a single cycling button would
announce only its current state and give no hint what pressing it does.

Three things that are easy to get wrong here and are each covered by a test:

- **Forcing light on a machine set to dark.** The dark rules are guarded with
  `:root:not([data-theme='light'])`, or the media query keeps winning and the control
  appears broken in exactly one direction — which you will not notice if you test on a
  light machine.
- **`color-scheme` has to track the explicit choice too**, not just the system one, or
  a forced-light page gets dark checkboxes, date pickers and scrollbars.
- **No flash of the wrong theme.** An inline, synchronous script in `<head>` applies
  the saved choice before the first paint. Anything deferred — a client effect, a module
  import — runs after the browser has painted, and the flash is worst for exactly the
  readers a theme control exists to serve.

The control is on the sign-in page as well as in the header: someone who cannot
comfortably read the page needs to fix that before signing in, not after.

## The `dark:` variant is redefined

`globals.css` overrides Tailwind's `dark:` variant so it matches the design tokens: the
system asks for dark *and* the reader has not overridden to light, or the reader chose
dark explicitly.

Without that override the variant keys off `prefers-color-scheme` alone while the theme
follows `data-theme`, and the two disagree in exactly the cases the toggle exists for. It
showed up as the UCF mark going invisible — white on a forced-light page, black on a
forced-dark one — and only for readers whose system setting opposed their choice, which
is why it survived review on machines that agreed with their owner. Any `dark:` utility
added later would have inherited the same fault.

## The favicon brings its own background

The Pegasus artwork is solid black on transparency. The site header can show it as-is on
a light surface and invert it to white on a dark one, because the page knows which theme
it is in — a favicon does not. A bare mark would be a black shape on the near-black tab
strip of any browser in dark mode, so the icon sits on a UCF-gold plate instead and reads
the same either way.

The mark is inset only 6% of the icon's width, which looks tight at 512px and is the
point: at 16px the Pegasus is at the edge of legibility, and ordinary padding thins its
strokes past one pixel and turns it into a smudge. `scripts/build-icons.mjs` renders each
size from the 192px original rather than downscaling one large composite, so the artwork
is resampled once. Look at a 16px render before changing either number.
