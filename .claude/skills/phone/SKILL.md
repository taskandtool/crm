---
name: phone
description: "A business number on the owner's Twilio: calls that ring their phone, missed-call texts, voicemail, Messages, the US texting registration and six automatic texts. Use for a phone number, texting a customer, missed calls, voicemail, why a text did not go, or changing what a text says."
---

# Phone

One number, or a few with labels, on the **owner's own Twilio account**
(Twilio's "direct customer" path: they are the business of record and pay
Twilio). `twilio.ts` is the only file that knows Twilio; everything else
talks to its `Provider`. From chat: `node scripts/phone.mjs` (`--help`).

Version: 0.2.0 (taskandtool/skills)

## The rules

- **Twilio is a connection**:
  `python3 ~/tools/taskandtool.py request-connection twilio --why "A business number: calls ring your phone, missed calls get a text" --auth api_key`.
  The missed-call text goes from the call's own webhook, which production's
  Worker answers; it reaches Twilio through the app's connections there as
  in dev. The owner gives the Account SID and an API key made in that
  account (a Standard key is enough); for an agency's client, the client's
  own subaccount. The SID is the connection's account in
  `list-connections` (and `TWILIO_ACCOUNT_SID` where the owner put the key on this machine);
  `twilio.ts` reads it there.
- **Twilio's webhooks come through the inbound route**
  (`inbound-url /hooks/twilio`), never a public path; each number's hook
  addresses carry its own secret, which `hooks.ts` checks.
- **Press 1 to answer stays.** A cell's own voicemail answers an unanswered
  call and Twilio counts it as picked up; only a press of 1 is answered.
- **Texting waits for registration.** US carriers block business texts
  from an unregistered number (Twilio 30034, 30032), so nothing is texted
  until `texting = 'approved'`; calls work from day one. The owner
  registers in Twilio's Console, pasting the words the setup page gives
  (`phone.mjs registration`): never create a brand or campaign by API,
  which Twilio documents only for software vendors registering others. The
  registration's samples, and its answers on links and phone numbers, are
  taken from the texts as they are, so a link the owner wants goes into the
  words before registering. The texting box shows on forms from the day
  there is a number, because reviewers check it on a live form.
- **The business's name and its privacy and terms pages** are one row
  (`data/business.ts`; Settings, Business, or `node scripts/business.mjs set`)
  that texts, the texting box and the registration's words all read: set
  them before registering.
- **Automatic texts keep the rules in `send.ts`'s header**: a ticked box,
  or they called or texted first (the nudge to finish booking and the
  review request need the box); never after a STOP, in any words, or to a
  contact marked Don't text; never to a landline; no text from 8pm to 8am in the business's zone but an answer
  within ten minutes of what they just did (emails go at any hour); three a number a day, the booking's confirmation
  and reminder apart. Where a text can't go, flows 2, 3 and 6 go by email.
  A send that didn't go says why in `text_sends.why`. A person may text any
  number that hasn't opted out or been marked Don't text (`phone.mjs send`).
- **Only the CRM texts.** Another app's form or booking page (the
  Website's) writes its submission or booking and nothing else; the CRM's
  15-minute job finds what came in the hour before. Connecting Twilio, or
  turning a flow on, texts nobody about the past.
- **The missed-call text goes once the call ends**, at any hour, to every
  caller but one gone within six seconds.
- **Our words are defaults** (`flows.ts`): one text per situation, none
  with a link. A link the owner wants (booking, reviews) goes into the
  words as they type it. Change the words with
  `phone.mjs set <key> --words "…" --variant <v>` (`flow <key>` lists the
  variants and fill-ins; a missing fill-in drops its sentence): it refuses
  emoji and fill-ins the flow can't fill and says when the words run past
  one 160-character text. `--reset` brings ours back. The owner can do the
  same on each flow's page in Settings, Phone and texts.
- **Never write a text that sells:** every automatic text is
  informational, which is what the consent covers.
- **A review request goes to everyone.** No "how did we do?" filter in
  front of the owner's review link: Google and the FTC forbid it.

## Files

| File | What |
|---|---|
| `schema.sql` | `phone_numbers`, `communications` (texts and calls, one table), `text_flows`, `text_sends`, `messages_seen`, `phone_lines`; `customers.texts_off` |
| `twilio.ts` | `twilioFrom` (through the app's connections), the `Provider`, `twilioConnected`, TwiML |
| `store.ts` | Numbers, texts and calls, whose number, threads, read state, opt-outs |
| `flows.ts` | The six flows' definitions, our words, `fill`, `checkWords`, `segments`, quiet hours, the owner's changes |
| `send.ts` | `sendText`, the claims (`schedule`, `deliver`), `mayText`, an email's link back to its form |
| `follow.ts` | What starts each flow (`onMissedCall`, `onSubmitted`, `onBooked`, `scan`) and what each says (`render`) |
| `hooks.ts` | `phoneHooks`: Twilio's webhooks for calls, voicemail, texts, status; booking by a reply of 1, 2 or 3 |
| `setup.ts` | `inboundUrl`, `buy`, `adopt`, `point`, `unhook`, `callOut` |
| `registration.ts` | `check`: reads the 10DLC or toll-free registration back from Twilio; `steps` for the page, with the words to paste; `optInPage`, the form reviewers open |
| `admin.tsx` | `phoneSettings` (the setup page, each flow's picture), `messagesRoutes` (Messages), `ContactTexts` |
| `job.ts` | `phoneJob`: the scan and the hourly registration check, for the app's route job every 15 minutes |
| `cli.ts` | `phoneCli`: what the app's `scripts/phone.mjs` runs |
| `test/` | The words' lengths, quiet hours, the call path with press 1, STOP, each flow, booking by reply |
