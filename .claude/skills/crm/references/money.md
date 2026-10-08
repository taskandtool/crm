# Forms, quotes and invoices in the CRM

Read when setting up quotes and invoices, connecting Stripe or an email sender for them, or working with forms here.

## Forms

Under Forms: every submission from the project's forms, filtered by form
("my orders" is the order form's), each with the booking and payment it led
to, the ones someone started and did not finish, and the form editor. The
Inbox filters by form too. People fill in the forms on the Website; this CRM
shows and edits them. `node scripts/forms.mjs` lists, shows and saves forms
(from JSON) and lists a form's submissions with their booking and payment.
The `forms` skill has the field types (steps, things to buy, a booking step,
a payment step); the `payments` skill's "Submissions, bookings and payments"
says how the three link.

## Quotes and invoices

Under Invoices: Quotes, Invoices and Tax rates. A quote is the CRM's own
document, made from a customer's page ("New quote") or a job ("Quote this
job"), sent as a PDF through the owner's email sender (as booking
messages are; with none, the team copies the text into their own email
and marks it sent). The customer says yes by reply or on the phone; a
person marks it accepted, which offers "Make the invoice" and, with no job
yet, "Make it a job". An invoice is made in the owner's Stripe account:
Stripe emails it and hosts the page the customer pays on. Paid, void and
uncollectible arrive from Stripe's webhook; "Mark paid" is for cash or a
check. A customer's page shows what was quoted, what they owe now and what
was paid; a job's page shows its quote and invoice.

Set it up once, in this order:

1. The name in `invoices` (lever 1), and the tax rates (`node
   scripts/quotes.mjs tax-rate "Sales tax" 8.25`), when they charge tax.
2. Quotes need the email sender bookings use (the Messages paragraph of
   `references/bookings.md`).
3. Invoices need the owner's Stripe, set up by the `payments` skill's
   `references/setup.md`: a restricted test key first, with every
   permission listed there (refunds on the Payments page need Refunds).
   Add its webhook, with the invoice events, at the URL that
   `python3 ~/tools/taskandtool.py inbound-url /hooks/stripe` prints, and
   set the webhook's signing secret as `STRIPE_WEBHOOK_SECRET`. This CRM
   is team only, so Stripe always reaches it at that URL, never at
   production's address. After the secret is set, `python3 ~/tools/taskandtool.py restart`.

The `invoices` skill has the rules, sending among them; `src/invoices/` is its code.
