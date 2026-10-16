---
name: phone
description: "A business number on the owner's Twilio: calls that ring their phone, missed-call texts, voicemail, Messages, the US texting registration, and six automatic texts in our words. Use for a phone number, texting a customer, missed calls, voicemail, or what a text says. Not for email."
---

# Phone

One number, or a few with labels, on the **owner's own Twilio account**
(Twilio's "direct customer" path: they are the business of record and pay
Twilio). `twilio.ts` is the only file that knows Twilio; everything else
talks to its `Provider`.

Version: 0.1.0 (taskandtool/skills)

## The rules

- **Twilio is a connection, asked for with `--delivery edge`**:
  `python3 ~/tools/taskandtool.py request-connection twilio --why "A business number: calls ring your phone, missed calls get a text" --auth api_key --delivery edge`.
  The missed-call text goes from the call's own webhook, which production's
  Worker answers, so the key must reach the edge. An API key (SK…:secret)
  is enough; the Auth Token is never needed.
- **Webhooks come through the inbound route** (`inbound-url /hooks/twilio`),
  never a public path. Calls and texts carry the number's own secret as
  basic-auth credentials (checked from `X-Forwarded-Authorization`); every
  later hook must name a call or text already kept on that number.
- **Press 1 is not optional.** A cell's own voicemail answers an unanswered
  call and Twilio counts it as picked up; only a press of 1 is answered.
- **Texting waits for registration.** US carriers block business texts
  from an unregistered number (Twilio 30034, 30032). The owner registers
  in Twilio's Console (the only path Twilio documents for a business
  registering itself), pasting our words from the setup page;
  `registration.ts` only reads it back. Never create a brand or campaign
  by API. Until `texting = 'approved'` nothing is texted and the flows say
  so; calls work from day one.
- **Automatic texts keep their rules** (`send.ts`): a ticked box, or they
  called or texted first (enough for the replies, confirmations and
  reminders; the nudge to finish booking and the review request need the
  box); never after STOP, Don't text, a STOP in their own words ("stop
  texting me", "wrong number") or Twilio's 21610; never to a landline (Twilio
  Lookup, once a number); nothing from 8pm to 8am in the business's zone,
  except the missed-call text and a confirmation or thank-you minutes after
  their own action; at most three a number a day, confirmations and
  reminders apart; the STOP line on the first text, and again after 30
  quiet days; each send claimed once in `text_sends`. Flows 2, 3 and 6 go
  by email where a text can't; 3's and 6's carry the address and an
  unsubscribe link. A person may text any number that hasn't opted out.
- **The missed-call text goes when the call ends**, never during the
  greeting: one text to every caller at any hour (no versions: edit the
  words to add a link or hours), nothing for a caller gone within six
  seconds.
- **Our words are defaults, in `flows.ts`: one text per situation.** A
  missing fill-in drops its sentence, so add `{booking_link}` or a name to
  the words rather than asking for a variant. Change one with
  `node scripts/phone.mjs set <key> --words "…" --variant <v>`: it checks the
  length (one text is 160 plain characters), refuses emoji and any fill-in
  the flow can't fill (`flow <key>` lists them). `--reset`
  brings ours back. Never write a text that sells: every automatic text is
  informational, which is what the consent covers.
- **The review request goes to everyone.** No "how did we do?" filter in
  front of the link: Google and the FTC forbid it.
- **Connecting Twilio texts nobody about the past.** The flows look only at
  what happens after texting starts.

## Files

| File | What |
|---|---|
| `schema.sql` | `phone_numbers`, `communications` (texts and calls, one table), `text_flows`, `text_sends`, `link_keys`, `short_links`; `customers.texts_off` |
| `twilio.ts` | The Twilio caller (bound key or gateway), the `Provider`, `twilioConnected`, TwiML |
| `store.ts` | Numbers, texts and calls, whose number, threads, read state, opt-outs |
| `flows.ts` | The six flows' definitions, our words, `fill`, `checkWords`, `segments`, quiet hours, the owner's changes |
| `send.ts` | `sendText`, the claims (`schedule`, `deliver`), the links a text carries |
| `follow.ts` | What starts each flow (`onMissedCall`, `onSubmitted`, `onBooked`, `scan`) and what each says (`render`) |
| `hooks.ts` | `phoneHooks`: Twilio's webhooks for calls, voicemail, texts, status; booking by a reply of 1, 2 or 3 |
| `setup.ts` | `inboundUrl`, `buy`, `adopt`, `point`, `callOut` |
| `registration.ts` | `check`: reads the 10DLC or toll-free registration back from Twilio; `steps` for the page, with the words to paste |
| `admin.tsx` | `phoneSettings` (the setup page, each flow's picture), `messagesRoutes` (Messages), `ContactTexts` |
| `job.ts` | `phoneJob`: the scan and the hourly registration check, for the app's job every 15 minutes |
| `unsubscribe.tsx` | `unsubscribeRoutes`: the page a follow-up email's unsubscribe link opens |
| `cli.ts` | `phoneCli`: the AI's command (status, flows, set, registration, threads, send) |
| `test/` | The words' lengths, quiet hours, the call path with press 1, STOP, each flow, booking by reply |

The flows, their words and why each says what it says:
`docs/plans/crm-calls-and-texts.md` and `crm-calls-and-texts-messages.md`
in the platform repo. The owner can change any text's words on its flow's
page in Settings, Phone and texts, as `phone.mjs set` does.
