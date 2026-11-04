# MiFILE payment and submission rollout

## Current release: v102

Payment and court submission remain disabled by the compiled
`FINAL_MIFILE_ACTIONS_ENABLED = false` guard. Neither a Render environment
variable nor a successful fee review enables them. The authorization endpoint
returns 403, the UI button is disabled, and the concrete browser transport
refuses to launch for execution. Normal Unsubmitted preparation is unchanged.

The real Playwright transport is implemented and connected to the serialized
worker behind this guard. It is not a verified live payment pilot.

## Execution contract

1. Use a verified, complete Unsubmitted bundle in the confirmed primary account.
   QA bundles and court notifications are not eligible for authorization.
2. Recheck the source PDF hashes, remote manifest, filer and court. Read the
   exact checkout total and the selected existing payment-account fingerprint.
3. Record exact-amount review and recent Unsubmitted evidence. Authorization
   is separate: the case, court, bundle, account, payment method and total must
   be explicitly approved. Quotes and approval expire after 15 minutes.
4. A durable intent is unique per canonical account and remote bundle, not
   per quote, password revision or local job. The worker revalidates the live
   checkout, including individual fee components, before dispatch.
   An identical primary Complaint hash in the same court/account also blocks
   a second attempted submission through a different bundle or resent email.
   This is an exact-source safeguard, not a claim that all historical cases
   or revised documents can be matched automatically.
5. Persist the committing checkpoint and consume the one attempt before the
   single Submit click. Recheck the account, bundle URL, amount and method at
   dispatch. Never add cards, request a waiver, accept terms, force a button,
   accept an unfamiliar confirmation or retry the irreversible click.
6. Wait for checkout processing to finish before opening History. Collect
   existing status and receipts. A timeout or process interruption creates a
   reconciliation hold, never another submission attempt.

## Result states

Submitted, In Progress and Accepted are submission/processing evidence, not a
verified charge or an official Filed result. Settlement may occur later.
The intent can therefore be submitted with payment pending. A Paid observation
without an exact transaction receipt remains receipt-pending.

A verified payment requires its exact USD total and transaction reference.
Wrong totals, different transaction references suggesting multiple charges,
rejections, refunds and malformed evidence require review. They never authorize
another charge. Per-document Filed evidence is tracked separately.

Read-only follow-up is durable, account-scoped, capped at five queued checks
and bounded to seven days after intent creation. It reuses the existing
inspection backoff (five minutes for successful reads, up to an hour after
failures), gives queued preparation priority, and does not replay submission.
Later verified evidence can reconcile an uncertain dispatch. Original activity
holds and the consumed attempt are retained.

## Controlled pilot still required

- Identify one specific genuine case that has not already been filed or paid.
  Do not infer this from an attached PDF or an archive. Existing Document Filed
  notifications are a reason to check the original case, not to recreate it.
- Verify the primary login and selected masked payment account in the same
  checkout session. An alternate account's payment accounts prove nothing
  about the primary account.
- Have the attorney approve the final documents and exact total. The first
  real financial action should be performed by the authorized person while
  the existing bundle is observed, not by an unattended development test.
- Retain and verify the actual transaction receipt and court outcome. Unknown
  receipt layouts must be supported from real evidence; do not invent them.
- Only then review a deliberate code release enabling execution. Do not
  enable the compiled guard merely to test fixtures or inspect checkout.

Official status definitions:
https://www.courts.michigan.gov/495d58/siteassets/mifile/mifile-quick-reference-guide-filer-experience.pdf

## Payment-account recognition (v100)

The current MiFILE template renders its card table with `role="presentation"`,
hidden column headers, and Angular object-valued radios. The heading-only
Available Payment Accounts group does not contain the table. Neither an empty
group nor a transient `object:...` radio value proves that no card is linked.

The reader validates the actual table structure directly. For object-valued
radios it observes the existing same-origin GET `/api/payment/getcourt` made
by checkout, then matches each enabled visible radio's exact accessible label
to one account record. The stable account ID is hashed; transient Angular IDs
are never stored as payment identities. Default-account metadata is not used
as a substitute for reading which radio is actually checked.

Evidence is bound to the current bundle, expires after two minutes and is
discarded when inspection ends. Unknown, duplicate, stale or unmatched records
block verification. Only masked suffixes and opaque fingerprints reach the
quote; full account metadata stays in memory. Structural diagnostics contain
no field values, account IDs, cardholder names or card numbers. No payment
account is added, changed or made default by this discovery.

## Final checkout readiness (v101)

An enabled Submit button alone does not prove the account can proceed without
another legal confirmation. MiFILE reads `CheckoutTCAccepted` when opening
checkout and can open a terms modal only after Submit is clicked. The runner
now passively observes that existing read-only property request. It never
accepts or saves terms. Missing, stale, malformed or conflicting observations
require human review; the account owner must handle any unaccepted terms in
MiFILE. Zero-total checkout does not require this payment-terms property.

Final-control readiness is now part of preflight, separate from exact fee
review. A fee quote can be retained and reviewed without implying the final
checkout is actionable. Version 3 preflight snapshots also pin the observed
checkout-control evidence; earlier readiness records require a fresh check.
The guarded executor repeats the same terms/control verification immediately
before its single dispatch. Live payment and court submission remain disabled.

## Read-only historical payment audit

`npm run mifile:payment-audit -- --targets '<JSON array of exact caseNumber/courtName pairs>' --from YYYY-MM-DD --through YYYY-MM-DD`
uses the configured, confirmed primary account. It reads only MiFILE's existing
GET `/api/payment/transactionsView`, used by the Payment Transactions screen.
It is limited to ten exact cases and sixty calendar days. The CLI emits only
matched authorization records with hashed references; raw account/card fields,
authorization codes and credentials are never printed. It does not click
financial controls, export receipts, or mutate payment accounts or filings.

An authorization entry is not proof of settlement. An absent entry in the
requested date range is not proof that a case is unpaid. Negative ledger
entries are retained separately, not silently netted into an assumed payment
balance. Court rejection/refund notifications and official transaction receipts
must be reconciled before deciding whether another payment is appropriate.
