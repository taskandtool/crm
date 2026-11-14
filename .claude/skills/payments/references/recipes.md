# Recipes

Read for the request each heading names.

## A deposit on a booking page

The booking skill makes the booking, and this skill takes the money in
`bookingPages`' `afterBook`. `afterBook` returns a Checkout URL, and the
booker goes there instead of the manage page (`test/deposit.test.ts`). A
paid booking type in a form is simpler: use the form's `booking` and
`payment` steps (the forms skill).

```ts
app.route("/book", bookingPages(getDb, {
  base: "/book", domain, css, source: "website",
  afterBook: async (c, e) => {
    const { url } = await startCheckout(getDb(c), stripeFrom(envOf(c)), {
      kind: "deposit", refType: "booking", refId: e.booking.id,
      amountCents: DEPOSIT_CENTS, currency: "usd", description: `Deposit: ${e.type.name} with ${e.host.name}`,
      email: e.booking.email, name: e.booking.name, source: "website",
      successUrl: `${e.manageUrl}?new=1`, cancelUrl: `${e.manageUrl}?new=1`,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    return url;
  },
}));
```

If Checkout cannot start, the booking stands and the booker sees the
manage page. It shows the deposit's status from `payments`.

## Payment status in SQL

Read status from `payments` rather than keeping a copy of it; sum per
currency.

```sql
-- the deposit for one booking: paid, refunded, or nothing yet
select status, amount_cents, refunded_cents, currency, paid_at
from payments where ref_type = 'booking' and ref_id = $1 and kind = 'deposit'
order by created_at desc limit 1;

-- what a person has paid, net of refunds, live money only
select currency, sum(coalesce(total_cents, amount_cents) - refunded_cents) as net_cents
from payments
where email = $1 and status in ('paid', 'partially_refunded') and livemode is not false
group by currency;
```

`total_cents` is what was paid with tax and fees; `amount_cents` is the
subtotal the webhook checks. To list one booking's payments on the
private page, add `?ref_type=booking&ref_id=42` to its base.

## A refund asked for in chat

A team member refunds on the private payments page and confirms the amount on a separate page. The call carries an idempotency key, and a
double submit makes one refund. The row turns refunded when
`charge.refunded` arrives. When the owner asks
you and names the payment and amount, that is the yes; otherwise say
exactly what will happen ("refund $50.00 of payment 42 to ann@example.com")
and wait for it. Then `POST /v1/refunds` with
`payment_intent`, `amount` and an Idempotency-Key built as `admin.tsx`
builds it (`refund-<intent>-<refunded so far>-<amount>`).

## Adding an event

Not handled: `charge.refund.updated`, disputes, subscriptions. Another
skill's events (the invoices skill's) go in `more` as an `EventHandler`.
Each event is recorded once in `stripe_events` and applied in one
transaction. Whichever way you add an event, its update names the statuses
the row may move from (the `from` list in `webhook.ts`). A late event then
never moves a status backwards. Add a test that sends the event out of
order.
