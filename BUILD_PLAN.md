# Restaurant portal build and verification plan

Use this file as the scope and release checklist. A phase stays open until its acceptance checks pass. Record each release candidate's version, device matrix, test run, findings, and retests in the verification log. Add a regression check when fixing behavior that could break again.

## Service modes included in the first release

The first single-outlet package includes **Table service**, **Counter service**, and **Both** as outlet settings. Counter service uses the owner's confirmed **pay first** flow. Version 0.2.0 implements these modes. Local verification and outstanding physical checks are recorded in VERIFICATION.md.

| Mode | Staff workflow | Required setup |
| --- | --- | --- |
| Table service | Waiter opens a table, sends dishes to the kitchen, and the counter records the final receipt and payment. The waiter releases the table after service. | Tables and enabled waiter accounts, plus kitchen and billing access. |
| Counter service | Cashier selects dishes, reviews the order, records successful payment, issues a token, and sends paid dishes to the kitchen. Staff hand over the ready order. | Billing and kitchen access. Tables and waiter accounts are optional. |
| Both | Cashier can create counter orders while waiters continue table service. The kitchen sees clearly labelled table and token orders together. | Configuration for both workflows, with permissions appropriate to each staff account. |

### Scope and working defaults

- Pay-first counter service is approved for this release. The cashier records payment using the restaurant's existing payment and billing arrangements. The kitchen receives the counter order after its payment record is committed.
- The owner approved counter approval or blocked changes after preparation starts, partial and full paid-counter cancellations/refunds, and keeping unpaid table checks locked until payment or an owner resolution.
- Working defaults for implementation are optional customer name, **Dine-in** or **Takeaway**, one payment record per counter order, a unique token within each outlet business date, and **Collected** as the handover action. These choices need review with the first outlet before pilot sign-off.
- A counter dine-in order may carry an optional seating label. Its lifecycle is driven by the token and collection state. Table service continues to use ownership and table release.
- The same catalog, prices, availability, notes, coupons, dish picker, and kitchen preparation meanings apply to all three modes. Reuse the existing components and services where their behavior fits.
- The offline package uses manual payment confirmation. The separate online pickup/delivery package is now active development, with restaurant acceptance before payment. Multi-outlet operations and the farmer marketplace remain later scope.

### Outlet setup and mode changes

1. The owner or authorized installation administrator selects the service mode during setup. Save it locally and expose it through the authenticated service configuration.
2. Counter-only setup can finish with zero tables and zero waiter accounts. Table and mixed setup validate the tables and waiter access needed to operate.
3. Initialize existing installations to Table service through a compatible migration. Preserve staff, table IDs, orders, receipts, reports, and publication state.
4. A mode change controls which new orders staff may start. Retain access to active orders from the previous mode until they are completed or resolved. Show the count of affected open orders before confirming the change.
5. Record mode changes with the actor, previous value, next value, and timestamp. Apply permissions and mode checks on the server.

### Counter order lifecycle

1. **New order.** Billing staff choose Counter order, select Dine-in or Takeaway, and optionally enter a customer name and seating label. Open the existing search and category dish picker directly.
2. **Review.** Show quantities, notes, current availability, item subtotal, coupon reduction, and the amount to record. Validate the catalog again on submission and keep accepted prices as order snapshots.
3. **Awaiting payment.** Persist an order identity and revision before payment confirmation. Keep unpaid orders in the counter's pending list so staff can reopen them after refresh or a service restart. Customers receive their kitchen token after payment is confirmed.
4. **Record payment.** The cashier collects payment through the outlet's existing arrangements and records the method, external receipt reference, and official receipt amount. Keep the portal subtotal and official receipt amount labelled separately, following the existing billing handoff.
5. **Commit and issue token.** In one transaction, validate the current order, save its payment record, consume any eligible coupon, allocate the token, and make its dishes eligible for the kitchen queue. Return the same result for a duplicate confirmation request.
6. **Prepare.** The kitchen sees the token, Dine-in or Takeaway, dishes, and notes. Staff update each dish to In preparation and Ready using existing controls.
7. **Ready.** The counter marks the order ready for collection when every remaining dish is ready. Show unpaid, paid, preparing, ready, collected, cancelled, and refund-needed states with text.
8. **Collect.** Authorized staff confirm Collected. Keep the token and receipt in history and remove the order from the active pickup list. Repeated collection requests return the already-saved result.

### Payment, corrections, and exception handling

- An unpaid, failed, or uncertain payment cannot make a counter order eligible for preparation. Preserve its draft and reference so the cashier can review the actual payment outcome before confirming.
- Disable repeated confirmation while a request is pending. Persist idempotency keys with their original payloads and results, so a timeout, retry, concurrent cashier, or restart cannot generate a second token, payment record, coupon redemption, or kitchen submission.
- Recheck prices, availability, coupons, receipt rules, and order revision before payment confirmation. Explain conflicts and preserve the order for correction. Payment confirmation must identify an immutable reviewed order version.
- If money was received externally but the local save failed, show a reconciliation action using the same order and receipt reference. The cashier verifies the external payment before recording it. Treat a partial record as an error requiring resolution.
- Permit unpaid cancellation with a confirmation naming the order. Record a reason for paid cancellations or corrections and the actor making them. Paid corrections preserve the original order and receipt history.
- Additional paid items use a new counter order and token in the first version. A post-payment reduction or cancellation uses a linked correction record, explicit refund-needed state, and a manually recorded external refund outcome. Record the cancelled dish and quantity, reason, refund amount from the official receipt, actor, time, and external refund reference. Bound cumulative adjustments by the original paid receipt.
- Keep preparation cancellation and payment adjustment states separately visible. A cancelled paid order remains unresolved until its financial adjustment is recorded or an authorized reviewer records the resolution.
- Concurrent staff updates use revisions. Reject stale changes, refresh the affected order, and give the cashier a clear retry or review path.
- During an internet outage, local ordering, payment recording, token assignment, preparation, and collection continue over staff Wi-Fi. If staff Wi-Fi fails, use paper and reconcile from the main counter.
- Extend paper entry for counter orders with an external receipt reference, payment outcome, original paper token if present, and whether the food still needs preparation. An already-served entry records history without adding kitchen work. Clearly distinguish the original paper reference from the portal token.

### Permissions and customer privacy

| Account | Service-mode capabilities |
| --- | --- |
| Owner/admin | Configure service mode, inspect activity, and review corrections and reconciliations. Explicit financial permissions are required for adjustments. |
| Billing | Create counter orders, record payment, issue or reprint tokens, reconcile payment records, and confirm collection. |
| Kitchen | View paid counter dishes and table-service dishes, update preparation, and view cancellation instructions. |
| Waiter | Continue table ordering, ownership, and handover responsibilities for table service. |
| Guest | Browse the published menu and use the existing account, offer, and feedback features. |

Collect only the customer details needed for handover. A phone number is optional when a guest asks to apply an account-linked offer. Verify the existing claim entitlement rather than treating a typed phone number as proof. Keep customer identifiers and payment details off public token displays and guest menu snapshots.

### Interface and reporting

- Keep the admin overview shell and add the outlet service setting within it. Use shared tokens and existing controls across all modes.
- In Counter service, the billing landing screen presents New order, Awaiting payment, Preparing, Ready, and History. In Both, provide clearly named Table checks and Counter orders destinations.
- Show the token prominently on counter orders, alongside service type, time, preparation state, and payment state. Kitchen tickets identify Table or Counter and retain per-dish notes.
- On phones, use the existing dish-picker review flow. On PCs, display the catalog and draft together. Preserve the same draft when resizing and protect it when navigating away.
- A token print action is available after successful confirmation and can be retried without submitting the order again. Print the token, service type, relevant order summary, and restaurant identity. Retain the existing external billing product as the issuer of the official receipt.
- Use an order ID and outlet date alongside the human-readable token in history so reused daily numbers remain distinguishable. Allocate sequence numbers in the database and test the date boundary in India time.
- Show counter-order counts and amounts by cashier and service type. Label portal item amounts, official receipt amounts, cancellations, and recorded refunds distinctly. Credit waiter reports only for actual waiter entries.
- The initial counter history view shows seven days of closed orders and retains unresolved work. The period activity report reads the retained database history. Review longer item-level history access with the pilot outlet.
- Determine feedback-code eligibility and coupon redemption from the paid counter order identity. Check that the existing publication and claim reconciliation paths work without a table ID.

### Data and synchronization

- Model service mode, order origin, fulfillment type, order revision, cashier attribution, optional seating/customer details, token date and number, payment records, corrections, and collection timestamps explicitly.
- Review table and waiter assumptions in storage, API contracts, receipt handoff, coupon verification, kitchen queries, feedback codes, reporting, and browser state before changing the order representation.
- Make the order identity usable for table and counter orders. Retain backwards compatibility for old stored table orders and the clients' existing entry points through a migration and shared validation.
- Synchronize only the guest data required by the website, offers, and private feedback. Keep operational orders, token queues, staff accounts, and financial history in local storage under the current architecture.

### Service-mode acceptance matrix

| Scenario | Required result |
| --- | --- |
| Existing outlet upgrade | Existing data opens intact in Table service and the existing waiter-to-kitchen-to-counter workflow passes. |
| Counter-only installation | Can operate without tables or waiter accounts. Unavailable table actions have clear mode-appropriate navigation. |
| Mixed outlet | Table and counter orders coexist. Their receipts, tokens, attribution, and kitchen instructions stay distinct. |
| Pending or failed payment | Order is recoverable at the counter and absent from the preparation queue. |
| Successful payment | One payment record, one token, one coupon redemption where applicable, and one eligible kitchen submission. |
| Lost confirmation response | Retrying returns the original confirmed token and payment result. |
| Restart during confirmation | The saved order is either pending or fully confirmed. Staff can resolve external payment uncertainty from the original reference. |
| Two cashiers confirm together | One accepted result with the other client shown the saved state or a clear conflict. |
| Price, stock, or coupon changes | The cashier reviews the conflict before confirming the final order version. |
| Kitchen prepares part of an order | Remaining dishes stay pending. Collection requires all remaining dishes ready. |
| Paid cancellation or correction | Kitchen and counter see the correction, original records remain, and refund-needed work is visible until resolved. |
| Duplicate collection or reprint | Collection stays singular and reprinting creates no new order or token. |
| Mode changes with open orders | Existing orders remain accessible and new-order options follow the new mode. |
| Date boundary and restart | Tokens remain unique for each outlet date and continue correctly after restart. |
| Paper recovery | Live entries reach the kitchen once. Already-served entries enter history with payment and paper references. |
| Public data boundary | Public menus and token slips expose only their intended data. Unauthorized financial and configuration requests fail. |
| Device and layout coverage | Keyboard and touch work at 320, 390, 768, and 1280 px. Long names, empty queues, errors, and reduced motion are checked. |

## Codebase hygiene for every change

Use this checklist before starting a change and again before marking it complete.

- [ ] **Find the existing owner.** Search for the feature, related files, and their callers. Extend the existing component, service, test, or document when it fits. Add a file only when it has a distinct responsibility, and put it with related files.
- [ ] **Keep one source of truth.** Reuse shared types, validation, UI components, and business rules where the behavior is the same. When replacing a file or implementation, update its callers and remove the superseded copy once references are checked. Keep test fixtures and generated output in their designated locations.
- [ ] **Keep the change focused.** Preserve existing behavior and stored data unless the feature explicitly changes them. Check callers, migrations, and compatibility before moving, renaming, or deleting code. Keep unrelated edits out of the change.
- [ ] **Review the final file list and changes.** Remove unused imports, helpers, dependencies, debug output, commented-out experiments, and temporary files introduced by the work. Update the existing documentation and tests alongside the feature.
- [ ] **Verify through the normal workflow.** Follow the feature testing and physical handoff requirements below.

## Feature testing and physical handoff

- **Before implementation**, define what success looks like through the normal entry point. Identify the affected roles, screens, stored data, and other workflows that rely on the change.
- **After implementing each feature or fix**, run the applicable type checks and automated tests and exercise the affected workflow locally. Check the normal path and the relevant failure, permission, retry, or synchronization paths. Reuse existing tests and add coverage where a new behavior or regression would otherwise go untested.
- **Before reporting a feature as complete**, fix failures and rerun the affected checks. Record the build tested, commands or steps, outcomes, and any pending checks in [VERIFICATION.md](VERIFICATION.md). Run `npm.cmd run test:all` before release.
- **When a check needs physical access**, complete the checks available locally first. Leave the physical check pending until the result is recorded. Send the tester a self-contained handoff with the following details.

| Handoff item | What to include |
| --- | --- |
| Setup and access | Exact build or installer, devices and network needed, startup instructions, and the exact address to open on each device. For phone tests, verify the staff-network HTTPS address before sending it. |
| Sample accounts and data | The username and role for each screen, where to find or generate the matching test password, and the exact sample records or values to enter. Use a separate test database and share sample credentials through a local file or another private channel. Keep production credentials and test passwords out of tracked docs and logs. |
| Steps and pass criteria | Numbered instructions from sign-in through the final check, with exact buttons or fields and the expected result on each affected screen. Include how to disconnect and restore the network or reset test data when relevant. |
| What to report | Ask for pass or fail, the first step that differed, device and browser details, and the visible error or a screenshot with private information removed. Record the result and retest any fix. |

## UI resources and design reviews

Use [DESIGN.md](DESIGN.md) for all staff screens and the guest menu. Read the relevant component and breakpoint rules before implementation. Update the specification and runtime tokens together when a design decision changes. Review phone and PC states against the specification before closing a UI change.

Use [shadcn/ui](https://ui.shadcn.com/) as the first place to look for reusable interface components. Bring in the individual components each workflow needs, such as dialogs, sheets, form fields, and tables, and adapt them to shared project tokens. Use native controls where they already fit. Check license, maintenance, keyboard support, bundle impact, and offline operation before adding a library. Bundle staff UI dependencies, icons, and any fonts locally. Prefer a single licensed icon set, with text labels on important actions. Use outlet-supplied photos or licensed assets for the public site and record attribution where required.

Staff screens should feel like service tools. Show table number, waiter, preparation state, or total where it drives the next action. Make the primary action easy to hit with one hand, put status in text as well as color, and retain drafts on recoverable errors. Favor clear type, compact lists, and obvious focus. The guest menu can express the restaurant's identity through type, photography, and color. Avoid decorative gradients, repeated card shells, generic promotional copy, and animation that slows service.

| When | Skills to apply | Evidence to record |
| --- | --- | --- |
| Before the first UI redesign or a new theme | Owl Listener's `design-token` for shared type, spacing, and semantic colors. `shadcn` to check the official registry before creating a primitive. | Write down the proposed tokens, component choices, and which screens share them. |
| Before implementing waiter, kitchen, or billing changes | `error-handling-ux` for lost connections, unavailable dishes, repeated actions, and recovery. Use `better-icons` when selecting icons, then bundle the approved set. | Define normal, loading, empty, failed, and retry states. Include the visible action and how an interrupted order is recovered. |
| After each React UI or data-fetching change | `vercel-react-best-practices` to review rendering, requests, and bundle cost. Run the matching workflow tests after fixes. | Record tests for the roles affected and verify that displayed data agrees across those screens. |
| Before and after guest menu changes | `design-taste-frontend` to define an outlet-specific visual direction, then review the rendered page for readable hierarchy, authentic imagery, and clear menu navigation. Use its art direction on the guest site. | Save screenshots at phone and desktop widths. Verify the same menu, pricing, and availability in local and hosted views. |
| After each user-facing milestone | `impeccable` for hierarchy, density, typography, and polish. `web-design-guidelines` for keyboard use, labels, contrast, and responsive behavior. Owl Listener's `design-qa-checklist` for the browser walkthrough. | Test at phone and counter widths with realistic data. Check focus order, touch targets, text wrapping, reduced motion, connection loss, and recovery. Log findings and rerun the affected tests. |
| Before release | Repeat the design and accessibility reviews on the release candidate, run `npm.cmd run test:all`, and complete the real-device checks below. | Add the build version, role and device matrix, findings, and retest outcomes to the verification record. |

These skills guide development and review. The installed restaurant software runs independently of the skills, design tools, and their network services.

### UI review checklist

- Compare rendered screens with the supplied reference and [design system](DESIGN.md). Check hierarchy, spacing, type, photo crops, and control states. Remove filler copy, unsupported badges, repeated wrappers, and controls without a working action.
- Check phone and desktop widths with the same sample data. Look for clipped labels, unexpected horizontal scrolling, missing images, and inconsistent prices, status, or counts. Include a long label, an empty state, and a failed request where applicable.
- Walk the changed flow with keyboard and pointer. Check visible focus, touch targets, readable labels, and recovery after errors. Run the relevant browser tests and review their accessibility results.
- Record the screens, widths, screenshots, findings, and retests in [VERIFICATION.md](VERIFICATION.md). Treat a clean source scan as one input to the review and verify the rendered workflow separately.

The selected skills were installed from reviewed revisions of [Better Icons](https://github.com/better-auth/better-icons/tree/033316ecb8f4982235af4111a2257e80231f5ab1), [Taste Skill](https://github.com/Leonxlnx/taste-skill/tree/f6b76575f949707b4e3c37cd86cb44b0b98643e8), [Vercel Agent Skills](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62), [Designer Skills](https://github.com/Owl-Listener/designer-skills/tree/9a6930cf84a822eb458624bd11c61aac5bbdf224), [Impeccable](https://github.com/pbakaus/impeccable/tree/ec229b48547f24685ffb22aa51c462c5ae27908c), and [shadcn/ui](https://github.com/shadcn-ui/ui/tree/8ab27715521cbd4f87ae6886cd989cbb678f6de7). The linked [SuperDesign project](https://github.com/superdesigndev/superdesign) is a separate IDE extension. Browser review of the running app covers the preview workflow for this project.

## Phase 1 · Offline ordering

- [x] Create a local Windows-hosted app with separate admin, waiter, kitchen, and counter access using a sample outlet.
- [x] Build table ownership, dishes and notes, per-dish preparation status, and a counter check.
- [x] Store order submissions and ownership together. Test retries, simultaneous claims, and price snapshots.
- [x] Apply shared tokens and selected shadcn/ui controls to the existing staff screens. Review all four roles and rerun the local workflow tests. See [staff UI verification](VERIFICATION.md#staff-ui-update).
- [x] Apply the target staff palette and adaptive waiter layout from [DESIGN.md](DESIGN.md). Keep staff status semantics consistent across all four roles.
- [x] Replace the native dish selector with the [waiter dish picker](DESIGN.md#waiter-dish-picker). Add local search, menu categories, one-action adds, and a shared draft that displays as a review pane on phones and alongside the catalog on PCs. Preserve existing sample and outlet menu data when introducing categories.
- [ ] Complete the [dish-picker acceptance checks](DESIGN.md#acceptance-checks-for-the-first-dish-picker-implementation). See the [verification log](VERIFICATION.md#dish-picker-and-table-placement) for local results. Physical phones, on-screen keyboard behavior, and the real-device search timing target still need verification.
- [ ] Provision a stable outlet hostname and trusted HTTPS. Restrict Windows Firewall to the staff network and verify the guest network cannot reach the service.
- [x] Verify one physical phone can submit a table order to the Windows kitchen and kitchen readiness reaches billing with matching quantities, notes, and total. User confirmed the iQOO/Windows sample check on 22 November 2026; see [physical phone results](VERIFICATION.md#physical-phone-check--22-november-2026).
- [ ] On a Windows counter and two real phones, sign in with WAN disconnected, take an order, mark dishes ready, and check the total. Restart Windows and verify the data.

## Phase 2 · Service and billing

- [x] Add moves to an available table and transfers to an enabled waiter. Keep the existing order and dish status, record who changed the assignment, and reject stale or unauthorized changes.
- [x] Implement and verify sent-order changes locally. The assigned waiter can add dishes to the same check and change quantities, notes, or cancel dishes that are queued. The default policy requires counter approval once preparation starts. Changes and decisions are recorded, and the check total reflects approved changes. See [order change verification](VERIFICATION.md#sent-order-changes).
- [x] Add owner configuration for counter approval or blocked preparing-dish changes. Let billing audit corrections to ready table dishes before receipts or splits lock the check. Preserve paid receipt history and use the external billing product for official adjustments.
- [x] Add counter-led table joins and item-quantity splits for two to eight checks. Preserve kitchen states, reconcile the original total, and audit saves and reopens. Verify that stale orders and duplicate retries cannot change the result. See [verification](VERIFICATION.md#table-joins-and-split-checks).
- [x] Implement and verify local counter handoff with external receipt references and payment outcomes for whole and split checks. The assigned waiter can release a paid table once the kitchen finishes, or release an order with all dishes cancelled. See [receipt handoff verification](VERIFICATION.md#receipt-handoff-and-table-release).
- [x] Add counter paper-order entry for live and already-served orders. Credit the selected waiter without reassigning an occupied table. Queue only live entries for the kitchen and keep submission retries duplicate-safe. See [paper-order verification](VERIFICATION.md#paper-order-entry).
- [x] Report waiter activity by day, week, and month in the admin view. Count distinct orders per waiter and show entry counts separately. Preserve attribution through moves, transfers, and joins, and count paper entries for the credited waiter on the recording date. See [waiter activity verification](VERIFICATION.md#waiter-activity).
- [x] Keep unpaid tables locked until payment or owner resolution. Record the reviewed balance and reason, reject stale resolutions, preserve the next party’s order identity, and retain a kitchen acknowledgment notice. Existing receipt checks cover amount validation and duplicate references.
- [ ] Verify printing, manual sharing, and offline receipt capability with the selected outlet's actual billing product. The external product issues the official bill.
- [x] Review move, transfer, split, and paper-entry screens for safe confirmation, clear totals, and recoverable errors. See [counter workflow UI review](VERIFICATION.md#counter-workflow-ui-review).

## Phase 2A · Counter service and mixed service implementation

Complete these items before the release-candidate gate. This phase extends the table-service implementation in Phase 2.

- [x] Trace existing table and waiter dependencies and approve the migration and shared order contracts. Define payment reconciliation and correction records before implementing paid mutations.
- [x] Add service-mode storage, migration, owner configuration, and server permission checks. Verify existing outlets and mode changes with active orders.
- [x] Provision counter-only outlets without required tables or waiter accounts. Verify setup for all three modes with sample data.
- [x] Adapt the existing dish picker and draft for counter orders. Persist pending payment orders and preserve review state across recoverable failures.
- [x] Implement transactional pay-first confirmation, official receipt handoff, cashier attribution, coupon redemption, and restart-safe idempotency.
- [x] Add token allocation, paid kitchen routing, readiness, collection, history, and duplicate-safe reprinting.
- [x] Add mixed-service counter and kitchen navigation. Verify both workflows operate concurrently with existing role restrictions.
- [x] Implement unpaid cancellations, paid corrections, manual refund recording, and reconciliation with audit history and explicit unresolved states.
- [x] Extend paper recovery, reporting, coupons, and feedback for counter orders. Verify each path uses the shared order identity.
- [x] Extend existing service, storage, startup, and browser suites to cover every service-mode acceptance scenario. Reuse fixtures and keep new tests tied to behavior.
- [x] Review the rendered UI against DESIGN.md and the supplied references. Record screenshots, accessibility checks, mobile behavior, and failure recovery in VERIFICATION.md.
- [ ] Complete a physical counter-service and mixed-service walkthrough with the outlet's actual payment, receipt, printer, and staff-network setup.

## Phase 2B · Built-in billing and printing

The owner added built-in GST and non-GST customer billing alongside external billing handoff. This extends the tested 0.2.0 baseline. Complete and verify this phase before the pilot is signed off.

Progress on 22 November 2026: the owner/cashier screens, saved-bill search, native print controls, server calculations, immutable invoice records and counter credits passed local checks. See [billing verification](VERIFICATION.md#built-in-billing-groundwork--22-november-2026). On 23 November, both active previews were aligned to the current build and the same phone-sample accounts/database, and the exact Windows 0.3.0 ZIP passed invoice persistence/update/rollback checks. The original 0.2.0 archive remains frozen. Physical printing and tax/reporting review remain pending.

- [x] Add an owner billing profile with business identity, address, invoice series, GST registration details where applicable, tax treatment, prices inclusive or exclusive of tax, and owner-entered tax rates and classification.
- [x] Support itemized non-GST receipts, GST tax invoices, and bill-of-supply treatment where selected. Validate the required seller and buyer details before issuing a bill.
- [x] Generate bills for whole table checks, split checks, and pay-first counter orders from the authoritative stored items. Preserve external billing reference and amount entry as a separate selectable workflow.
- [x] Allocate unique invoice numbers in an outlet financial-year series. Store immutable seller, buyer, item, discount, tax, rounding, and total snapshots. Preserve numbering and exact bill contents across retries and restarts.
- [x] Compute currency amounts on the server in integer paise. Test discounts, inclusive and exclusive prices, CGST/SGST and IGST treatment, rounding, and stale profile or order reviews.
- [x] Link paid counter corrections to the original built-in bill and retain corresponding credit-note records and external refund outcomes. Bound cumulative credits by the original bill.
- [x] Reprint saved bills and credit notes independently of order/payment submission. Support thermal receipt widths and A4 through the native print dialog, with responsive content and no customer-data leakage on kitchen tokens.
- [x] Verify 58 mm, 80 mm and A4 print layouts as PDFs and record the installed printer inventory. See the billing verification log.
- [ ] Test a physical printer once one is available. Printer support depends on the operating system's installed driver and the browser's print options.
- [x] Package the billing build as Windows version 0.3.0 and verify installation, invoice persistence through restarts/updates, reprint snapshots, numbering and safe rollback against the exact ZIP. See [Windows billing package verification](VERIFICATION.md#windows-billing-package-030--23-november-2026).
- [x] Add regression coverage for invoice duplication, financial-year boundaries, permissions, split allocation, tax calculation, credit limits, and print-only views.
- [ ] Validate configured tax details and any applicable electronic reporting obligations with the pilot outlet before production invoice use. Record production-specific requirements and verification in the release handoff.

## Phase 2C · Backup and controlled recovery

Recovery is part of the product, not a raw database-file upload. An older snapshot can lose recent sales and access changes; hosted claims may also have been redeemed since that snapshot. The implementation must preserve evidence and stop unsafe reuse before staff resume service.

- [x] Add owner-only encrypted export from a consistent SQLite snapshot. Run snapshot processing and encryption in a worker; cap database size at 512 MB, bound job duration, and allow one export at a time with a cooldown. Keep operational requests responsive.
- [x] Require a separate passphrase and confirmation. Use native AES-256-GCM with a fixed scrypt policy, random salt/nonce and authenticated technical metadata. Validate authentication, hash, schema and database integrity before opening restored contents. Keep passphrases out of settings, process arguments and audit logs. Clear browser sessions in the copy without signing out live staff.
- [x] Provide an offline Windows recovery wrapper using the installed runtime. Require the service/launcher to be stopped and hold its lock; reject an open database. Review the backup hash before restore. Prepare and validate the candidate, flush a separate pre-restore copy, and atomically replace the database without first removing the current pathname.
- [x] Preserve exact original invoice snapshots. Require fresh invoice and credit-note series; reserve old known series. Preserve newer staff access/password changes when the current database is readable. For a missing database, disable backup accounts and generate a fresh owner handoff in the protected data directory. Clear all sessions.
- [x] Pause service mutations and hosted publishers after restore. Require an authenticated owner to reconcile orders, payments and refunds and acknowledge the specific restoration. Reject stale acknowledgments and retain an audit record.
- [x] Verify wrong secrets, tampering, truncation, unsupported headers, cross-outlet attempts, hosted-state refusal, injected final-write failure, session handling, staff access, fresh-owner login, Unicode Windows stdin, and publisher pause/resume with disposable fixtures. Verify owner download, responsiveness and recovery review in the browser.
- [x] Verify the final 0.4.0 Windows kit end to end, including installed export/restore, stale-session rejection, owner review and existing invoice/update/rollback checks. See [recovery verification](VERIFICATION.md#backup-and-controlled-recovery--23-november-2026).
- [ ] Implement coordinated recovery for hosted publication/claims. Until that is verified, refuse automatic restore of any outlet with hosted configuration/history or claims. Do not bypass this gate to get a restore to finish.
  - [x] Identify the same installation in menu/photo, offer, receipt-feedback and owner-inbox requests. Bind hosted writes to that installation; recheck identity and credentials under the outlet lock to reject requests already in progress when ownership changes. Preserve existing hosted data through a repeatable schema update.
  - [x] Add and verify the hosted storage transaction: permanent retirement of previous public claim/offer codes, preservation of redeemed history and the last menu, safe version advancement, authenticated retries and rejection of superseded requests or reused installation identities. Never infer that a claim is unused from an older backup: a later offline redemption may be missing from both backup and host. This operation is not yet exposed through an HTTP route or the Windows restore tool.
  - [ ] Connect the hosted transaction through a bounded, authenticated recovery endpoint only with the local journal/startup protections below. Bind the request to the inspected backup hash, outlet, prior/new installation identities and version floors. Keep old campaign codes reserved locally too; require new codes for future public campaigns.
  - [ ] Add a durable local recovery journal with retry identity, lost-response handling and a startup gate. Require fresh hosted confirmation before activating restored data; keep owner review and fresh financial series mandatory. Verify interrupted recovery cannot restart the former publishing installation.
  - [ ] Package the matched local and hosted changes together and document upgrade/rollback compatibility. A host with recovery records must not run an older build lacking retirement and installation checks. Until then, the tested 0.4.0 Windows archive remains the previous unlinked-recovery milestone.
- [ ] Agree the pilot's backup destination, export schedule and retention; implement automated scheduling/retention if required. The current workflow is manual, owner-controlled export and versioned downloads.
- [ ] Perform physical off-device recovery on an isolated Windows installation, plus real interruption/reboot and storage-exhaustion checks. Fault injection is recorded separately from a real disk-full event. Keep all production recovery gates open until these pass.

## Phase 3 · Public website and synchronization

- [x] Add local admin editing for dish name, category, price, and description. Add kitchen availability controls with an optional return estimate and manual confirmation. Keep waiter ordering in sync and preserve prices on existing checks. See [catalog verification](VERIFICATION.md#menu-catalog-and-availability).
- [x] Add local dish photo upload, replacement, and removal. Verify the single responsive guest menu. See [verification](VERIFICATION.md#dish-photos-and-guest-menu-previews).
- [x] Persist a local menu publication queue and send versioned guest-only snapshots and photos over HTTPS with an installation credential. Retry failures and preserve pending edits across restart. Record the last acknowledged publication for admins. See [verification](VERIFICATION.md#local-menu-publication).
- [x] Add a separate hosted Fastify service with PostgreSQL for menus and photos. Reuse the guest Vite build for one local and hosted menu renderer. Scope credentials, menu versions, and photo access to an outlet. Show the last successful update to guests and publication status in the local admin catalog.
- [x] Verify the receiver against local PostgreSQL and HTTPS. Cover stale versions, conflicting repeats, lost acknowledgments, concurrent writes, photo references, long menus, and outlet isolation. See [verification](VERIFICATION.md#hosted-guest-menu-and-receiver).
- [x] Require verified TLS for remote PostgreSQL and verify the staging checker and receiver outage recovery locally. See [verification](VERIFICATION.md#internet-staging-readiness).
- [x] Verify admin printing for individual and all-table QR cards, with a distinct code for each table and a shared public outlet menu destination. See [verification](VERIFICATION.md#printable-table-qr-cards).
- [x] Add full-catalog menu image export for sharing, with a paginated preview, individual PNGs, and a complete ZIP download. See [verification](VERIFICATION.md#menu-image-export).
- [x] Apply the [guest menu rules](DESIGN.md#guest-themes). Keep one responsive design with compact photos; remove the Classic/Photo-led switch and unused variant styles. Verify old theme links and hosted metadata open the same menu, with search, category navigation, accessibility and phone/desktop checks.

## Phase 4 · Offers and private feedback

- [x] Verify local admin and counter workflows for shared dine-in coupon codes with fixed rupee discounts, optional minimum spend, optional expiry, and one coupon per check. Store the discount alongside the receipt and use the restaurant billing software for the official total. See [verification](VERIFICATION.md#dine-in-coupons).
- [x] Add public dine-in offers, one claim per verified phone account per offer, and one-use counter redemption after sync. Verify local and hosted reconciliation. See [verification](VERIFICATION.md#public-offers-and-phone-linked-claims).
- [x] Verify guest phone sign-in, local rate limits, and secure guest sessions with simulated SMS delivery. See [verification](VERIFICATION.md#guest-phone-sign-in).
- [x] Add single-use review codes for paid receipts, a printable slip, private guest submission, and an owner inbox. Verify expiry, replay, abuse limits, offline sync, and outlet isolation locally. See [verification](VERIFICATION.md#private-receipt-feedback).
- [x] Verify private claim access, duplicate claim requests, and offline counter redemption. Keep real network and SMS checks in the release phase.
- [x] Review rendered guest sign-in, offer claims, and private feedback. Verify labels, invalid verification codes, recovery, confirmation, and feedback privacy with the hosted test fixture. See [guest UI review](VERIFICATION.md#guest-ui-review-and-accessibility).

## Online ordering package · active development

The owner approved moving online ordering into active development on 23 November 2026. Build pickup first, then restaurant-managed delivery. The offline restaurant package must continue operating independently. Do not expose a working checkout or enable online orders until the outlet can receive requests, accept them and reconcile verified payment. Deploy at the end, after local verification.

### Ordering contract and availability

- [ ] Add package entitlement and owner-controlled online settings: accepting orders, opening hours, preparation estimates, pickup scheduling and temporary pause. Keep channels disabled by default. Separate a paid package entitlement from an outlet's operational pause.
- [x] Connect the Windows service with authenticated outbound requests, current installation identity and a 45-second hosted heartbeat lease. Public menu browsing continues when ordering is unavailable. Pause the connector during recovery; only the owner can request activation, and the hosted platform must separately grant the package entitlement. Network loss stops new hosted requests after the lease expires; it never confirms payment or kitchen work.
- [x] Implement the backend pickup channel/heartbeat primitive, server-priced reviews and protected request APIs with authenticated account binding, bounded quantities/notes, expiry and menu/settings versions. Reject stale reviews, sold-out items, altered amounts and unsupported fields. Responses expose an item subtotal; final pricing belongs to restaurant acceptance. The owner setting, Windows connector and test-only guest cart are connected; channels remain disabled by default.
- [x] Persist pending restaurant requests with retry identities and original item/price snapshots. Bound pending requests to one per customer/outlet. Report unanswered requests as expired at their deadline and persist expiry on subsequent checkout. Isolate reads/writes by account and outlet; verify concurrent retries and rollback after an injected final-write failure.
- [ ] Finish retention and cleanup for expired reviews, abandoned requests and customer contact data; document support access and recovery handling. Collect an operational contact number only through a verified, consented workflow, not by treating arbitrary typed numbers as identity.

### Customer and counter workflows

- [x] Add the signed-in guest cart to the single guest menu: add/remove dishes, quantities, item notes, order notes, name, review, validation recovery and safe refresh/retry. Keep local dine-in browsing waiter-led; only entitled hosted outlets expose online actions. Until verified payments are implemented, expose this only through the explicit `HOSTED_PICKUP_PREVIEW=1` test flag, with an enabled test-mode billing profile and a fresh connected counter. No payment or kitchen work is started.
  - Preserve unsent name/notes in memory while the page is open; do not persist them in browser storage. Store only original submission identifiers, scoped by outlet and the signed-in account, before sending. Refresh recovers outstanding requests from the server; an unsent draft intentionally does not survive a full reload. Retrying an unknown result uses the same identifiers. Sign-out hides private order data and clears the visible draft. Show accepted totals/time and expiry without presenting payment as available.
- [x] Add an authenticated outbound counter connector, durable SQLite inbox/outbox and acknowledgment protocol. Preserve requests and original decision identities through restart and lost responses. Display online orders separately from table checks/counter orders. Queued decisions are labelled as awaiting hosted confirmation; no kitchen entries are created.
- [x] Let authorized restaurant staff accept or reject a fresh request. Record actor, revision, reason and promised pickup time. Acceptance produces an immutable final price review, including applicable taxes, discounts and fees; customers confirm changed totals before payment. Discounts/extra fees remain zero pending the separate online-coupon/fee work below.
  - [x] Implement the hosted connector APIs for paginated inbox polling, individual request reconciliation, billing-profile publication, current-price review and atomic accept/reject decisions. Reuse existing billing validation/calculations; preserve accepted totals and audited retry identities through restart.
  - [x] Connect the local Windows outbox/inbox and owner/billing authentication to the hosted APIs; add the counter decision screens and owner activation/pause controls without changing the six-section admin navigation. Derive the actor from the local session, reject supplied actors and freeze unsent decisions when that operator loses access. The hosted API trusts the authenticated connector's staff attribution; it is not an independent staff login.
  - [x] Add customer review/confirmation of the accepted total and payment expiry. Persist the accepted review hash, accepted order revision and server confirmation time atomically; serialize against restaurant decisions/recovery, check account/outlet ownership, expiry, current installation and fresh channel/entitlement. Identical retries return the saved confirmation/current status without extending the deadline or charging. Later menu edits cannot replace the immutable accepted price. Sync confirmation to the Windows counter and distinguish it from payment. Current acceptance supports pickup with the configured single billing classification/rate; coupon discounts and extra fees are zero until their own reservation/validation flow is implemented.
  - [ ] When adding payment creation, require a matching stored confirmation and recheck the payable order status, deadline, current installation, entitlement/availability and payment-account configuration inside the authoritative payment workflow. A historical confirmation returned after expiry/recovery must never authorize a charge or revive an order.
- [ ] Add account-linked online coupons with reservation, expiry and single redemption across online/offline flows. Reconcile claims centrally before approval; an old backup or disconnected counter cannot revive a used claim.

### Payment, preparation and collection

- [x] Select Razorpay as the payment provider (owner confirmed). Follow its [Standard Checkout integration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps) and [webhook validation guidance](https://razorpay.com/docs/webhooks/validate-test). Do not treat an authorized payment as captured or a browser callback as sufficient proof of payment.
- [x] Use platform-managed Razorpay Route with linked restaurant accounts and automatic commission splitting from launch (owner confirmed). Do not substitute direct restaurant checkout with separately invoiced commission.
- [ ] Confirm platform Route eligibility/activation and test-mode access, onboard the restaurant's linked account, and verify settlement, fees and transfer/reversal permissions using [Razorpay's Route documentation](https://razorpay.com/docs/payments/route/). Use test credentials first; keep secrets private. No live charge or rollout is authorized by a development fixture.
- [ ] Configure and snapshot the platform commission policy per order/outlet before checkout. Calculate platform/restaurant shares in integer paise, reconcile them to the captured customer total, record provider fees separately, and handle partial/full refunds plus transfer reversals. Confirm the actual commission rate and applicable invoicing/tax treatment before launch.
- [ ] Create payment orders only for accepted, unexpired restaurant orders. Verify provider signatures/webhooks, amount, currency, account, order identity and replay protection on the server. A customer callback alone is not payment proof.
- [ ] Handle delayed, failed and duplicate payments, expired acceptance, a lost successful response and payment received after cancellation. Reconcile before preparation; never silently discard received funds or record payment twice.
- [ ] Route verified paid orders into the existing kitchen with explicit online origin and retained notes. Integrate built-in/external billing, per-dish progress, ready-for-pickup status and an audited collection action with private collection verification.
- [ ] Implement rejection/cancellation rules and partial/full refunds with provider-confirmed outcomes, original invoice/credit-note history and visible unresolved cases. Keep physical cash/POS refunds distinct from online provider refunds.
- [ ] Show customer history and status: waiting for restaurant, rejected/expired, awaiting payment, payment under verification, paid/preparing, ready and collected/cancelled/refund pending. Preserve access without exposing another customer's order.

### Restaurant-managed delivery

- [ ] Add restaurant-drawn delivery boundaries, coordinate validation, address/contact entry, delivery fees, minimum spend and pickup-versus-delivery choice. Recheck the zone and immutable total before acceptance/payment.
- [ ] Add delivery scheduling, employee assignment, ready/out-for-delivery/delivered statuses and audited failed-delivery handling. Keep customer addresses off public menus, kitchen tokens and unrelated staff screens.
- [ ] Add customer delivery updates and history. Delivery booking with the platform's own fleet remains a subsequent integration after restaurant-managed delivery works.

### Integration and release gates

- [ ] Complete the recovery journal/startup gates from Phase 2C. Recovery must pause ordering, invalidate older reviews, expire untouched pending requests and fence the old connector. Reconcile accepted/paid requests and financial outcomes before resuming; never reset paid online orders from an older local backup.
  - [x] Preserve the accepted price snapshot and mark accepted requests `recovery_required` during hosted recovery. Keep them visible to the replacement connector and block another checkout for that customer until reviewed. Require pricing to be republished; do not silently discard a possible payment outcome.
- [ ] Test API permissions, cross-outlet/account access, malformed inputs, price changes, stale settings, disabled/offline channels, request expiry, simultaneous checkout, duplicate/lost requests, payment/webhook replay, refunds, reconnect, restart and failure after external payment.
- [ ] Review guest/counter/kitchen flows at 320/390/768/1280 px with keyboard, touch and accessibility checks. Preserve the current design system and avoid a second cart/order implementation where existing components fit.
- [ ] Run end-to-end pickup and delivery tests with a simulated provider and disposable PostgreSQL/SQLite. Then perform test-mode provider checks, configured-deployment security review and the deferred physical walkthrough. Package matched local/hosted builds and deploy only after sign-off.

## Phase 5 · Release candidate

- [x] Apply the supplied staff UI references and verify the desktop and phone-sized browser workflows. Record adaptations for live data and staff permissions. See [staff redesign verification](VERIFICATION.md#staff-reference-redesign).
- [x] Keep every admin workspace in the outlet overview layout. Verify active navigation, focus, edit protection, and phone-width controls across all six sections. See [admin UI verification](VERIFICATION.md#admin-navigation-and-mobile-review).
- [ ] Repeat the admin walkthrough on a physical phone connected to the outlet's trusted staff network. Use the [admin test steps](VERIFICATION.md#physical-admin-walkthrough).
- [x] Build a versioned Windows x64 installer kit with a bundled runtime and boot-task configuration. Verify clean installation, process restart, update, damaged-update rejection, and compatible rollback with sample data. See [verification](VERIFICATION.md#windows-installer-kit).
- [ ] Run the [Windows boot check](README.md#windows-installer-kit) on a clean counter PC or VM. Verify actual task registration, permissions, and startup after reboot. Test disk exhaustion and interruptions during database writes.
- [ ] Run a full simulated dinner with real phones and the outlet's billing workflow. Test simultaneous requests, weak Wi-Fi, a WAN outage, and reconnection. Record the device and browser matrix and observed performance.
- [x] Run local service/storage, startup/HTTPS, Edge, hosted PostgreSQL, and Windows installer regressions for 0.2.0. Run the dependency audit and targeted source credential-pattern scan. Record scope and results in VERIFICATION.md.
- [ ] Complete staged security checks against the configured deployment. Fix confirmed findings and retest them. Require zero open known in-scope defects and zero unresolved confirmed security findings before release.
- [x] Document installation, account provisioning, manual receipt and refund handoff, paper fallback, incident responsibilities, and the absence of supported automated backup and restore in README.md. Confirm outlet-specific contacts and the production recovery decision at handover.
- [ ] Complete the remaining [backup/recovery gates](#phase-2c--backup-and-controlled-recovery), including hosted reconciliation, the outlet's retention policy and physical off-device recovery, before pilot release.
- [ ] After software development and local verification, provision internet staging with a publicly trusted certificate. Run the [staging checks](README.md#verify-internet-staging), including a real restaurant-network interruption and catch-up after reconnection.
- [ ] Verify SMS delivery and phone sign-in with the configured provider on Indian mobile numbers, including a delayed message and one failed or expired code.
- [ ] Scan printed QR cards from real phones on a guest network and verify each card opens the correct hosted outlet menu.
- [ ] Deploy the tested build and verify an order and a public menu update at the outlet.

## Security verification

| Boundary | Controls and checks |
| --- | --- |
| Staff app | Unique accounts, salted password hashing, expiring sessions, rate limits, secure cookies over TLS, same-origin writes, and server-enforced roles. Exercise direct endpoint access, logout, malformed requests, and unauthorized table changes. |
| Network and installer | Use trusted HTTPS for staff phones, restrict ingress to the staff network, and use outbound HTTPS for sync. Verify guest Wi-Fi separation, firewall rules, certificate renewal, bundled runtime, and least-privilege service access. |
| Hosted data | Test cross-outlet access to every protected resource. Scope and rotate installation credentials. Validate inputs and uploads, limit abuse, keep secrets and customer data out of logs, and minimize what syncs. |
| Release | Verify dependency and build integrity, review access control and failure cases, and run targeted staged security testing against applicable [OWASP ASVS requirements](https://owasp.org/www-project-application-security-verification-standard/). |

Online pickup and restaurant-managed delivery are active scope above. Later scope includes platform delivery booking, multi-outlet operations, and the farmer marketplace.
