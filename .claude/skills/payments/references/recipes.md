# Recipes

Read for the request each heading names.

## A deposit on a booking page

The booking skill makes the booking; this skill takes the money, in
`bookingPages`' `afterBook`. It returns a Checkout URL, and the booker is
sent there instead of the manage page (`test/deposit.test.ts`). A paid booking type through a form is
simpler: the form's `booking` and `payment` steps (the forms skill).

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

If Checkout cannot start, the booking stands and the booker sees the manage
page, which shows the deposit's status from `payments`.

## Payment status in SQL

Read, never copy; sum per currency.

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
subtotal the webhook checks. One booking's payments in the private list:
`/admin/payments?ref_type=booking&ref_id=42`.

## A refund asked for in chat

A team member refunds on the private payments page, which confirms the
amount on its own page and keys the call so a double submit is one refund;
the row turns refunded when `charge.refunded` arrives. When the owner asks
you instead, say exactly what will happen ("refund $50.00 of payment 42 to
ann@example.com") and wait for their yes; then `POST /v1/refunds` with
`payment_intent`, `amount` and an Idempotency-Key built as `admin.tsx`
builds it (`refund-<intent>-<refunded so far>-<amount>`).

## Adding an event

Not handled: `charge.refund.updated`, disputes, subscriptions. Another
skill's events (the invoices skill's) are an `EventHandler` in `more`,
recording each event once in `stripe_events` and applying it in one
transaction. Either way: name the statuses it may move from in the SQL,
and add a test that sends it out of order.
