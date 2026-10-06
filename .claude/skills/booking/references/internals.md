# Booking internals

Read before changing `slots.ts`, `book.ts`, `ics.ts` or the manage pages.
Each is decided and tested (`test/`); a change that breaks a test changes a
decision.

- **Daylight saving, decided** (tests in `test/slots.test.ts`): days are
  walked as local dates, never by adding 24 hours. A start that the clock
  skips (02:30 on a spring-forward night) has no slot. A start that happens
  twice (01:30 on a fall-back night) is offered once, at the earlier instant.
  A window end inside a gap moves forward past it. A window never crosses
  midnight: store 22:00 to 24:00 on one day and 00:00 to 02:00 on the next.
- **Taking a booking is one non-interactive transaction** (`book.ts`): an
  advisory lock per candidate host as its own statement, then `insert … select …
  where not exists (overlapping booking, busy, time off) returning *`. Empty
  means taken. Do not merge the lock into the insert (the insert's snapshot
  would predate the lock and miss the booking that just committed), do not
  check in JavaScript between statements, and do not open an interactive
  transaction: the Neon HTTP driver cannot.
- **Invites** (`ics.ts`): UID `booking-<id>@<domain>` never changes; SEQUENCE
  is `bookings.sequence`, which rises on every reschedule and cancel (clients
  ignore an update that does not raise it); REQUEST to invite by email,
  CANCEL to cancel, PUBLISH for a download. Times in UTC.
- **The manage link is the booker's key.** 32 random bytes, shown once; only
  its SHA-256 is stored and looked up. Pages that carry it send
  `Referrer-Policy: no-referrer`. A lost link cannot be recovered; the team
  can still change the booking.
- **The confirm form is spam-checked** with the forms' honeypot and minimum
  fill time (`data/spam.tsx`); set `SPAM_SECRET` so the stamp is
  signed. A bot is sent back to the day's times and nothing is booked.
