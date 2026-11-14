---
name: phone
description: "Runs a business number on the owner's Twilio: calls that ring their phone, missed-call texts, voicemail, Messages, the US texting registration and seven automatic texts. Use for a phone number, texting a customer, missed calls, voicemail, why a text did not go, or changing what a text says."
---

# Phone

One number, or a few with labels, on the **owner's own Twilio account**
(Twilio's "direct customer" path: they are the business of record and pay
Twilio). Only `twilio.ts` calls Twilio; other code uses its `Provider`. From
chat: `node scripts/phone.mjs` (`--help`).

## The rules

- **Twilio is a connection**:
  `python3 ~/tools/taskandtool.py request-connection twilio --why "A
  business number: calls ring your phone, missed calls get a text" --auth
  api_key`. The missed-call text goes from the call's own webhook. In
  production the Worker answers that webhook and reaches Twilio through the
  app's connections, as in dev. The owner gives the Account SID and an API
  key made in that account (a Standard key is enough). For an agency's
  client, use the client's own subaccount. The SID is the connection's
  account in `list-connections` (and `TWILIO_ACCOUNT_SID` where the owner
  put the key on this machine); `twilio.ts` reads it there.
- **Twilio's webhooks come through the inbound route**
  (`inbound-url /hooks/twilio`), never a public path. Each number's hook
  addresses carry its own secret, and `hooks.ts` checks it.
- **Keep Press 1 to answer.** When nobody picks up, the cell phone's own
  voicemail answers, and Twilio counts that as picked up. A call counts as
  answered only when someone presses 1.
- **Texting waits for registration.** US carriers block business texts
  from an unregistered number (Twilio 30034, 30032). Nothing is texted until
  `texting = 'approved'`; calls work from day one. The owner registers in
  Twilio's Console and pastes the words from the setup page (`phone.mjs
  registration`). Never create a brand or campaign by API: Twilio documents
  that only for software vendors registering others. The registration's
  samples, and its answers on links and phone numbers, are taken from the
  texts as they are. Once the form page is known, the words say yes on links
  and give a sample link on the business's own address, because an approved
  campaign's answer can't be changed afterwards. The texting box shows on
  forms from the day there is a number, because reviewers check it on a live
  form.
- **The business's name and its privacy and terms pages** are one row
  (`data/business.ts`; Settings, Business, or `node scripts/business.mjs set`).
  Texts, the texting box and the registration's words all use it. Set them
  before registering.
- **Automatic texts follow the rules in `send.ts`'s header:**
  - They need a ticked box, or the person called or texted first. The
    nudge to finish booking and the review request need the box.
  - None after a STOP in any words, to a contact marked Don't text, or to
    a landline.
  - None from 8pm to 8am in the business's zone, except an answer within
    ten minutes of what the person just did. Emails go at any hour.
  - At most three to a number a day, not counting the booking's
    confirmation and reminder.

  Where a text can't go, a flow with an email in `flows.ts` sends the email
  instead. A send that didn't go records why in `text_sends.why`. A team
  member may text any number that hasn't opted out or been marked Don't
  text (`phone.mjs send`).
- **Only the CRM texts.** Another app's form or booking page (the
  Website's) writes only its submission or booking. The CRM's 15-minute job
  finds what came in during the hour before. Connecting Twilio or turning a
  flow on sends no texts about earlier events.
- **The missed-call text goes once the call ends**, at any hour, to every
  caller except one who hung up within six seconds or got a missed-call
  text in the last 24 hours.
- **When someone stops partway through a form, the follow-up depends on
  what the form was waiting for.** For a time, Stopped before booking
  offers three, and a reply books one. For money, Stopped before paying
  emails the link back, because a reply can't pay. Someone with no email
  gets the link by text. Where the campaign told carriers there would be no
  links, they get a text asking them to reply instead.
- **Our words are defaults** (`flows.ts`): one text per situation. Only
  Stopped before paying has a link. A link the owner wants (booking,
  reviews) goes into the words exactly as they type it. The words are
  theirs: saving warns about a public shortener or a campaign that said no
  links, and never refuses. Change the words with
  `phone.mjs set <key> --words "…" --variant <v>`. `flow <key>` lists the
  variants and fill-ins, and a sentence whose fill-in is missing is
  dropped. `set` refuses emoji and fill-ins the flow can't fill, and says
  when the words run past one 160-character text. `--reset` brings ours
  back. The owner can do the
  same on each flow's page in Settings, Phone and texts.
- **Never write a text that sells.** Every automatic text is
  informational, because that is all the consent covers.
- **A review request goes to everyone.** No "how did we do?" filter in
  front of the owner's review link: Google and the FTC forbid it.

## Files

| File | What |
|---|---|
| `schema.sql` | `phone_numbers`, `communications` (texts and calls, one table), `text_flows`, `text_sends`, `messages_seen`, `phone_lines`; `customers.texts_off` |
| `twilio.ts` | `twilioFrom` (through the app's connections), the `Provider`, `twilioConnected`, TwiML |
| `store.ts` | Numbers, texts and calls, whose number, threads, read state, opt-outs |
| `flows.ts` | The seven flows' definitions, our words, `fill`, `checkWords`, `segments`, quiet hours, the owner's changes |
| `send.ts` | `sendText`, the claims (`schedule`, `deliver`), `mayText`, an email's link back to its form |
| `follow.ts` | What starts each flow (`onMissedCall`, `onSubmitted`, `onBooked`, `scan`) and what each says (`render`) |
| `hooks.ts` | `phoneHooks`: Twilio's webhooks for calls, voicemail, texts, status; booking by a reply of 1, 2 or 3 |
| `setup.ts` | `inboundUrl`, `buy`, `adopt`, `point`, `unhook`, `callOut` |
| `registration.ts` | `check`: reads the 10DLC or toll-free registration back from Twilio; `steps` for the page, with the words to paste; `optInPage`, the form reviewers open |
| `admin.tsx` | `phoneSettings` (the setup page, each flow's picture), `messagesRoutes` (Messages), `ContactTexts` |
| `job.ts` | `phoneJob`: the scan and the hourly registration check, for the app's route job every 15 minutes |
| `cli.ts` | `phoneCli`: what the app's `scripts/phone.mjs` runs |
| `test/` | The words' lengths, quiet hours, the call path with press 1, STOP, each flow, booking by reply |
