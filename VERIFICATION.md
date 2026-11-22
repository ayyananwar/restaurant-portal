# Development verification

## Version 0.2.0 service modes

Table service, pay-first Counter service, and Both are implemented. The owner approved counter approval or blocked changes after preparation starts, partial and full paid counter corrections/refunds, and owner resolution for unpaid table service.

The database migration preserves existing table orders and receipts, introduces counter orders without artificial stored tables or waiter assignments, and keeps payment confirmation, coupon redemption, feedback-code issuance, and token assignment in one transaction. Paid cancellations and owner resolutions retain their audit history. Kitchen staff acknowledge full cancellation notices. Pending orders and unresolved financial work remain available after restart or a mode change.

Owners can provision accounts and tables through the overview. New staff passwords are generated and returned for private handoff, omitted from account listings and audit records, and session access is revoked on disable or password reset. A fresh counter-only sample requires no waiter or table records. Empty real-outlet setup is available through the bundled runtime.

### Local acceptance coverage

The 0.2.0 build passed type checking, production bundling, 34 service/storage tests, three provisioning/startup/HTTPS tests, the Edge walkthrough, two hosted PostgreSQL/HTTPS tests, and the Windows installer regression. The exact final ZIP passed its SHA-256 comparison and installer check. The dependency audit reported zero advisories, the targeted source credential-pattern scan found no matches, and the design scan returned no findings in the reviewed UI files. These local checks do not replace the physical and staged release checks below.

The Windows check covered installation, order persistence through process restarts, modified-payload rejection, update validation, compatible rollback, and refusal to roll back onto an unsupported newer database. Automatic startup after an actual Windows reboot remains pending.

The existing preview database was first validated on a copy with the bundled Node 22.23.4 runtime, then migrated from schema 13 to 17. The preview runs in Both mode, returned HTTP 200, and its existing sample admin account authenticated successfully. The sample credential file is unchanged. Screenshots for the new flow are in `data/counter-service-check`, including counter views at 390 and 1280 px.

| Area | Checks |
| --- | --- |
| Migration and persistence | Legacy table references, price snapshots, reopening the database, pending orders, and stable payment retry results. |
| Pay-first enforcement | Unpaid orders stay out of the kitchen and reject direct dish-state writes. Roles restrict confirmation, configuration, and financial corrections. |
| Transaction failures | Simulated SQLite storage limit and an interrupted token write leave no partial payment, receipt, feedback code, token, or kitchen order. Recovery can retry the original request. |
| Concurrency and numbering | Competing confirmations yield one receipt and token. India-midnight numbering and a backwards date change preserve token uniqueness. |
| Corrections | Partial and full cancellations, refunds bounded by the original paid amount, original receipt retention, stale kitchen revisions, post-collection corrections, and manual refund references. |
| Table service | Preparing-dish policy, audited ready-dish correction before receipt or split, locked paid edits, owner balance review, stale balance rejection, and a distinct next-service identity. |
| Browser | Mixed-service ordering, resizing a draft, an interrupted payment response, token printing, partial refund recording, kitchen readiness, collection, owner setup, and owner resolution with kitchen acknowledgment. |
| Layout | Counter view at 320, 390, 768, and 1280 px, keyboard and control labels, automated accessibility assertions, and shared admin navigation. |

The counter history view shows seven days of closed orders plus unresolved work. Period reports use retained database history. Payment and refund outcomes are manually recorded from the external billing/payment system. Physical phones, actual receipt/printer integration, staff-network isolation, real SMS, Windows boot registration, and production staging remain pending. A supported backup-and-restore workflow remains a production recovery decision.

### Counter and mixed-service handoff

On the development Windows computer, open `http://127.0.0.1:3100/` with separate browser profiles for `admin`, `billing`, and `kitchen`. The existing sample passwords are in `data/preview-accounts.txt`. For a fresh isolated counter sample, follow README.md and use a new database path. Save its generated account credentials privately. A phone handoff must supply the actual trusted staff-network HTTPS address before testing.

1. As admin, choose **Change service mode → Table and counter service → Confirm service mode**.
2. As billing, choose **Counter orders → New counter order → Takeaway → Choose dishes**. Add two Paneer tikka at ₹240 each. Review the ₹480 draft and choose **Save for payment**. Expect an unpaid order with no kitchen token.
3. Confirm the kitchen has received no counter dishes. In the outlet's test billing/payment system, record the payment. At the portal counter, enter reference `PILOT-COUNTER-001`, amount `480`, and Cash. Choose **Record payment and issue token**. Expect one token and one kitchen ticket. Use a fresh reference for each repeat of this walkthrough.
4. Mark the counter dish ready in the kitchen. At billing, choose **Confirm collected** and inspect History. Print the token and verify that reprinting keeps the same token and omits customer identifiers.
5. From the paid order, choose **Cancel some items**. Cancel one portion with refund amount `240` and reason `Pilot correction`. Process the actual refund in the external test system, then choose **Record external refund** and enter `PILOT-REFUND-001`. Expect one remaining portion, the original ₹480 receipt, and a recorded ₹240 correction.
6. Start a paper order using a distinct original paper reference. Choose **Already served**, select a dish, and record its payment. Expect it to be ready at the counter and absent from kitchen preparation. Repeat with a Live paper order and verify preparation starts after payment confirmation.
7. As admin, open **Manage staff and tables**. Create a test waiter with username `pilot-waiter`, save the generated credentials privately, and add `Pilot table`. Verify the new waiter can sign in. Disable that account and verify its session loses access.
8. On an unpaid table order, have the owner choose **Review unpaid resolution**, check the displayed balance against the billing product, enter `Pilot owner resolution`, and confirm. Expect the table to become available, the resolution to remain in owner history, and the kitchen to receive a stop-preparation notice requiring acknowledgment.
9. Repeat local ordering with the internet uplink disconnected while staff Wi-Fi stays powered. Restore it and verify menu publication catches up. Test the physical printer and Windows reboot on the designated pilot device. Record the build, device/browser, result, and first differing step.

## Counter workflow UI review

- Table moves, waiter transfers, and joins show the source and require an eligible destination before confirmation. The form keeps its selection after an interrupted request and explains when a refreshed destination or source is no longer eligible.
- Split setup shows the original check total alongside the allocations. Paper entry explains when a selected table or credited waiter becomes unavailable. The browser checks cover focus on entry, cancel recovery for table moves, the interrupted-move retry, split totals, and both paper order modes.
- `npm.cmd run test:all` passed the production build, 22 service and storage tests, two Windows startup and HTTPS checks, and the Edge browser suite. Reviewed the interrupted move capture and the 320 px split and paper-entry captures in `data/ui-consistency-check`. The design source scan returned no findings for the three changed screens.

### Physical counter walkthrough

Use a sample outlet and the `waiter`, `billing`, and `kitchen` accounts supplied with that installation. On the Windows development computer, open the [local preview](http://127.0.0.1:3100/) and use the matching passwords in `data/preview-accounts.txt`. Use separate browser profiles for the three roles. For staff phones, use the trusted HTTPS address of the sample installation.

1. As waiter, open a vacant table and send two **Masala chai** to the kitchen. As billing, open the check and verify the displayed total matches two portions.
2. Choose **Move table**, select another vacant table, and confirm. Expect the check to appear under the destination with the same total and kitchen status. Choose **Transfer waiter**, select another enabled waiter, and confirm. Expect the table owner to update.
3. Choose **Split check** and assign one chai to Check 2. Expect the original total and the sum of the two check totals to agree. Save and verify both checks show one chai each.
4. On another vacant table, choose **Enter paper order**, select a waiter, and choose **Already served**. Add one chai and save. Expect the counter check to include it and the kitchen to receive no new work for that entry. Repeat on another table with **Live** and expect one new kitchen item.
5. Record the Windows and phone browser versions, the first step that differed, and the visible result. Physical devices and the outlet’s billing product remain pending.

## Guest UI review and accessibility

- Extended the existing Edge suite to compare the full live menu across Classic and Photo-led, verify the hero asset, and check horizontal overflow and navigation touch targets at 320, 390, 768, and 1280 px. Automated accessibility checks run for both themes at 320 and 1280 px. The suite saves both themes at 390 and 1280 px when screenshots are enabled.
- Visual review caught an uneven three-plus-one category layout on a phone. Four categories now fit in a single row where space permits and a two-by-two grid at the smallest tested width. The design source scan reported no findings in the reviewed guest menu and feedback files.
- The final local run passed the production build, 22 service tests, two startup and HTTPS checks, and the Edge browser suite. Updated screenshots are in `data/ui-consistency-check`.
- The hosted browser suite passed with simulated SMS. It checked the incorrect-code message, offer claim refresh, feedback labels, and owner-only feedback retrieval. The feedback form now focuses its code field on open, restores focus on cancel, and focuses the private confirmation after submission. These transitions have browser regression checks.
- Physical phone, screen reader, real SMS, and production checks remain pending.

## Guest menu reference update

- Compared Edge captures of Classic at 320 px and Photo-led at 1280 px with the supplied restaurant menu references. Both layouts use the live catalog and a newly generated decorative biryani hero. The sample preview reuses bundled sample dish photos when there is no uploaded photo.
- The local build, service tests, startup checks, and Edge workflow passed. Guest checks covered search, zero results, keyboard focus, category links, uploaded photos, live availability, and no horizontal overflow. The hosted PostgreSQL and HTTPS workflow also passed, including the hero asset, phone sign-in, offers, and private feedback.
- The local preview links are [Classic](http://127.0.0.1:3100/guest-menu) and [Photo-led](http://127.0.0.1:3100/guest-menu?theme=photo-led). Open either link and search for a dish or select a category. Check that the price and availability match the admin catalog. Physical phone and production deployment checks are pending.

## Admin navigation and mobile review

Edge verified all six admin destinations at 320, 768, and 1280 px. Each kept the outlet banner, had one current navigation item, fit without horizontal scrolling, and provided navigation targets at least 44 px tall. Keyboard activation moved focus to the page heading. The browser suite ran automated accessibility checks at 320 px and checked that printed QR sheets hide the admin controls.

| Area | Edge verification |
| --- | --- |
| Overview and navigation | Switch directly between all admin destinations. Check the shared banner, current item, keyboard focus, and return focus. Confirm staff without admin permissions cannot reach admin controls. |
| Catalog and export | Recover from an empty search. Protect an open edit, add and update a dish, upload its photo, and check availability. Preview and download the full catalog in PNG and ZIP formats. |
| Coupons | Verify the empty state, open and cancel the editor, save shared and public coupons, clear a search with no matches, and verify the mobile rows and receipt application. |
| QR cards and feedback | Exercise failed QR images and retry, print all or one table, and check that the print layout contains the intended cards. Exercise feedback request failure, retry, and the unconfigured state. |
| Waiter activity | Check day, week, and month periods, long report rows at phone width, and retry after a failed request. |
| Staff and guest workflows | Exercise the waiter draft, kitchen statuses, counter changes and table selection, split checks, receipts, paper orders, and both local guest themes. |

The production build, 22 service and storage tests, two startup and HTTPS tests, and Edge browser suite passed. Rendered captures are in `data/ui-consistency-check`. Physical phone, screen reader, and printer checks are pending. The hosted sign-in, offer claim, and feedback submission integration suite was outside this local verification run.

### Physical admin walkthrough

On the Windows computer, open the [local preview](http://127.0.0.1:3100/) and sign in as `admin` with the matching password in `data/preview-accounts.txt`. For a physical phone, use the staff-network HTTPS address provisioned as described in the [network setup](README.md#staff-network-setup-for-a-lab-test). Use the sample account for that installation and verify the certificate is trusted on the phone.

1. Open Menu catalog, Table QR cards, Dine-in coupons, Private feedback, and Waiter activity. Expect the same banner and top navigation, with the current section highlighted. Tap Outlet overview to return.
2. In Menu catalog, tap **Add dish**. Enter `Mobile test dish`, category `Test`, and price `99.50`. Try to switch sections. Expect a save-or-cancel message. Tap **Cancel**, then try again. Expect navigation to work and the sample catalog to be intact.
3. In Dine-in coupons, search for `NO-MATCH-123`. Clear the filters and verify that the search clears. If coupons exist, check that the code, discount, validity, redemptions, status, and action fit without a horizontal swipe.
4. On Windows, use Tab and Enter to select another admin destination. Expect visible focus and the new heading to receive focus. Where the outlet has published its menu, print one QR card and scan it with the phone. Expect the guest menu to open.

## Staff reference redesign

- Reviewed all ten files in `resimg`. Nine are distinct. The Dish Availability and Counter Checks files have the same SHA-256, so Dish Availability uses the catalog layout with the kitchen actions.
- Compared Edge captures for sign-in, outlet overview, table service, order entry, kitchen queue, counter, activity, catalog, coupons, and dish availability. Checked phone-sized workflows and the automated accessibility assertions. The captures are in `data/ui-reference-check`.
- The service, startup, and Edge suites passed. The running Windows preview served the updated script, stylesheet, and reference artwork. The reference build uses live table, menu, check, and coupon data, with role-specific navigation. Guest count, sample tax lines, and percentage coupons in the references have no equivalent in the current workflow. The older Windows installer archive predates this redesign.

## Release status

The development build includes local dine-in service and billing handoff, guest menu publication, QR cards, menu export, offers, private feedback, and a Windows installer kit. The feature checks below record local results. The [build plan](BUILD_PLAN.md) tracks remaining production provisioning, hardware checks, and public staging.

For each new feature, record the build, workflow, tests run, and results. Track physical checks separately as pending, passed, or failed. When a physical check is requested, use the handoff checklist in [BUILD_PLAN.md](BUILD_PLAN.md#feature-testing-and-physical-handoff) and link to the test instructions from the result entry.

## Checks for the local slice

| Check | Coverage |
| --- | --- |
| Type checking and production build | Client and server type checks and the bundled browser build. |
| API and storage | Order creation, kitchen status, counter totals, saved prices, competing waiter claims, repeated requests, transactional rollback, and data reopened from disk. |
| Windows process and HTTPS | Sample provisioning rejects duplicate setup. A real process restart preserves the order. Startup rejects a cleartext network listener. A loopback HTTPS handshake with a trusted test certificate verifies secure session cookies. |
| Security behavior | Unauthenticated requests, wrong staff roles, expired and revoked sessions, disabled accounts, password attempt limits, invalid data, client-supplied prices, forged hosts, cross-origin writes, and restricted asset access. |
| Browser walkthrough | Microsoft Edge with three separate phone-sized sessions. The waiter submits two dishes, the first successful response is deliberately dropped, and the waiter retries. The kitchen marks dishes ready and the counter sees the correct two lines and total. The browser test rejects external page requests. |
| Dependency advisories | The npm registry audit reported zero known advisories for the installed dependency set at the time of testing. |

The browser test runs on one machine. Hardware sign-off still requires two real phones, trusted HTTPS, staff and guest Wi-Fi separation, an internet disconnect, and a Windows reboot. The targeted security checks cover the local slice. The hosted review, installer review, release security gate, and full dinner simulation are tracked in the build plan.

## Local preview

The running sample returned HTTP 200 at `http://127.0.0.1:3100/`. A sample waiter signed in and loaded the table list. The preview is restricted to this computer. See [README.md](README.md) for the separate sample database and restart instructions.

## Staff UI update

- Applied shared color, spacing, focus, and touch-size tokens to the sign-in and staff views. Used shadcn/ui buttons, inputs, fields, and badges with local assets. Kept the native dish selector. The generated component dependencies were narrowed to the primitives in use.
- `npm.cmd run test:all` passed with the HTTPS fixture enabled. Edge covered all four roles, keyboard sign-in, empty kitchen and counter screens, a 320 px order form, a desktop counter, a lost-response retry, the shared ₹540 check, and sign-out. The walkthrough made zero external requests.
- Automated axe checks reported zero violations in the states tested for sign-in and all four roles. Reviewed the rendered sign-in, order form, and counter screenshots. The design detector returned no findings on the changed screen and stylesheet. The npm dependency audit returned zero known vulnerabilities at test time.
- Verified that the running preview serves the updated stylesheet. Real-device HTTPS, staff and guest Wi-Fi separation, WAN disconnect, and Windows reboot are still pending.

## Dish picker and table placement

- `npm.cmd run test:all` passed with eight API and storage checks, two startup and HTTPS checks, and the Edge walkthrough. The menu migration preserved legacy IDs, prices, and availability. The API rejects unauthorized table changes, occupied destinations, stale order writes, and sold-out items.
- The browser used a 250-item menu, all four staff roles, and both 320 px and desktop widths. It exercised search and categories, keyboard adds, draft notes, remove and undo, resizing, browser Back from mobile review, connection loss, and a lost submission response. The counter saw a single ₹540 check, which stayed intact when the table moved and the waiter changed. Automated accessibility checks and the design detector reported no findings in the tested states.
- Restarted the local preview against its existing sample database. Verified the existing waiter sign-in and that the preview returns menu categories and available waiters.
- The staff Wi-Fi HTTPS address, two physical phones, on-screen keyboard behavior, physical search timing, WAN interruption, and Windows reboot still require a lab run. The [offline lab walkthrough](README.md#offline-lab-walkthrough) is ready to use once the address and sample credentials are provided.

## Sent order changes

- `npm.cmd run test:all` passed with nine API and storage tests, two startup and HTTPS checks, and the Edge workflow. The database migration preserved existing line quantities, notes, and kitchen status.
- API checks covered adding a dish to the same check, immediate edits by the assigned waiter, blocked access for other roles, duplicate requests, stale kitchen instructions, approval and decline, and expiry when the dish became ready.
- In Edge, the waiter changed the paneer quantity and note. The kitchen saw the updated instructions, and the counter total changed from ₹540 to ₹780. The waiter requested cancellation of the chai after preparation started. The total stayed ₹780 while pending, dropped to ₹720 on approval, and remained ₹720 through the table move and waiter transfer. The pending counter view passed the automated accessibility checks, and the design detector returned no findings on the changed files.

## Table joins and split checks

- `npm.cmd run test:all` passed with eleven API and storage tests, two startup and HTTPS checks, and the Edge walkthrough.
- API checks rejected unauthorized joins and splits, stale destination checks, stale dish revisions, cancelled-line allocations, and quantities above the order. Replaying a split save after reopening did not recreate it.
- Edge joined Table 7 into Table 9 and kept the destination waiter and kitchen states. The counter split ₹780 into ₹480 and ₹300 at 320 px, reloaded to verify persistence, then reopened the check and verified the original ₹780 total. The split editor passed automated accessibility checks and was visually reviewed. The design detector returned no findings on the changed screens.

## Receipt handoff and table release

- `npm.cmd run test:all` passed with thirteen API and storage tests, two startup and HTTPS checks, and the Edge walkthrough. The database migrated to version 6 and the local preview opened with the existing billing login.
- API checks covered receipt recording for each split, duplicate references, stale checks, permissions, repeated submissions, payment updates, persistence after reopening the database, and clearing a table for a new party without reusing the prior receipt. A fully cancelled order could be released without a receipt.
- Edge recorded an unpaid external receipt for ₹790.50 against a ₹780 item total, marked it paid via UPI, and confirmed that the waiter could free the table only after the kitchen finished the last dish. The receipt editor passed the automated accessibility checks, and the design detector returned no findings.
- Real billing software, official receipt issuance and printing, correction rules, and releasing a table with unpaid checks remain on the build plan.

## Paper-order entry

- `npm.cmd run test:all` passed with fourteen API and storage tests, two startup and HTTPS checks, and the Edge walkthrough. Existing sample credentials and data remained usable after the version 7 preview migration.
- API checks covered counter-only access, enabled waiter credit, existing table ownership, stale check rejection, duplicate retries, and the distinction between live and already-served lines. The version upgrade retained historical waiter attribution.
- Edge recorded an already-served, currently sold-out biryani on the ₹220 counter check without a kitchen ticket. It then sent a live paper order to the kitchen. The setup form passed automated accessibility checks, and the design detector returned no findings on changed files.

## Waiter activity

- `npm.cmd run test:all` passed with sixteen API and storage tests, two startup and HTTPS checks, and the Edge walkthrough. Verified the report in the running preview with the existing admin account.
- Server checks covered India midnight boundaries, Monday-to-Sunday weeks, calendar months, invalid dates, admin-only access, distinct-order counts, entry counts, inactive waiters with historical activity, and paper attribution independent of the current table owner.
- Edge switched among day, week, and month, confirmed the credited waiter received one live and one served paper entry, and verified that a failed refresh left the prior report visible until retry. The report fit a 320 px screen, passed automated accessibility checks, and was visually reviewed. The design detector reported no findings.

## Menu catalog and availability

- `npm.cmd run test:all` passed with seventeen API and storage tests, two startup and HTTPS checks, and the Edge walkthrough. The existing preview database migrated to version 8 and the admin login and menu remained usable.
- API checks covered role boundaries, duplicate dish creation, stale edits, sold-out estimates, and manual confirmation after an estimate passes. A catalog price update preserved the original price of a submitted order and rejected a stale price on a new submission.
- Edge added and edited a dish in the admin catalog, marked it sold out from the kitchen, and verified that the waiter could add it again after kitchen confirmation. The admin form fit 320 px, passed automated accessibility checks, and was visually reviewed. The design detector reported no findings.

## Dish photos and guest menu previews

- `npm.cmd run test:all` passed with 18 API and storage tests, two startup and HTTPS checks, and the Edge walkthrough. Photo tests covered admin-only writes, rejection of unsupported formats and excessive pixel dimensions, resizing to WebP, metadata stripping, safe retries, stale edits, replacement, removal, and the guest response’s public field list.
- Edge uploaded a dish photo as admin and verified the guest menu without signing in. Both themes fit at 320 px and displayed the dish photo. The walkthrough covered category links, matching catalog data, a sold-out update after refresh, and automated accessibility checks on Classic at 320 px and Photo-led at desktop width.
- Verified that the existing sample outlet serves its catalog and the current guest preview on port 3100. The design detector reported no findings in the changed menu files.
- Hosted publication, sync, table QR cards, and menu image export remain on the build plan.

## Local menu publication

- `npm.cmd run test:all` passed with 21 API and storage tests, two startup and HTTPS checks, and the Edge walkthrough. The version 10 migration preserved the older menu fixture. Existing staff workflows and both guest previews passed regression checks.
- A simulated receiver verified the public-only payload, photo hash and upload order, recovery after an outage and local database restart, retry after a lost acknowledgment, reuse of an uploaded photo, and preservation of a newer edit made during upload. The status endpoint rejected guest and kitchen sessions. Configuration checks rejected insecure URLs and invalid outlet slugs and credentials.
- The hosted receiver, cross-outlet authorization, out-of-order rejection by the receiver, and real network recovery through the hosted site still require staging verification. There is no new screen or physical check for this backend step.

## Hosted guest menu and receiver

- `npm.cmd run test:all` passed with 21 API and storage tests, two startup and HTTPS checks, and the Edge walkthrough for local operations and both preview themes. The admin catalog displayed its publishing state.
- `npm.cmd run test:hosted` passed against PostgreSQL 17 and a locally trusted HTTPS fixture. The real publisher and receiver handled a 248-dish menu, a simulated connection interruption, an acknowledgment lost after commit, competing updates, stale versions, and photo removal. An identical retry retained the original public timestamp.
- Security checks covered wrong-outlet credentials, duplicate installation secrets, unexpected private fields, duplicate dish IDs, invalid photo bytes and hashes, missing and staged photos, cross-outlet photo references, and blocked staff routes and assets. Dependency installation reported zero known vulnerabilities.
- Edge verified the published outlet name, configured theme, India-time update stamp, dish photo, and sold-out state without sign-in. Automated accessibility checks passed at 320 px and 1280 px, screenshots were reviewed, and the design detector returned no findings. The [local preview](http://127.0.0.1:3200/r/ranchi-cafe) served three sample dishes from the running hosted service.
- Internet deployment, a real restaurant-network outage, and access from a guest network remain staging checks. QR cards and menu image export remain on the build plan.

## Printable table QR cards

- `npm.cmd run test:all` passed with 22 API and storage tests, two startup and HTTPS checks, and the staff Edge walkthrough. `npm.cmd run test:hosted` also passed with the table fragment on the guest URL.
- The server tests decoded two QR images and verified their exact HTTPS destination and distinct table fragments. Guests and waiters could not retrieve cards, unknown tables failed, first publication was required, and caller-supplied URL parameters could not change the destination.
- Edge verified single-table selection, all-table selection, image-load recovery, keyboard focus return, print-only content, and PDF output. The 320 px screen passed automated accessibility checks, the desktop layout was visually reviewed, and the design detector reported no findings. The restarted Windows preview returned all four sample cards using the existing admin account.
- The sample cards are marked for this computer. Physical printer and phone scans remain pending until a stable public HTTPS address is available.

## Menu image export

- `npm.cmd run test:all` and `npm.cmd run test:hosted` passed. Edge opened export as admin, confirmed the kitchen view lacked the export action, and verified that a filtered 250-dish catalog still exported all 250 dishes across 20 pages.
- The browser walkthrough confirmed the sold-out text, page navigation, 1080 × 1350 PNG dimensions, ZIP page count, and that the first archived PNG matched the standalone download byte for byte. The title accepted literal angle brackets as text. The preview passed automated accessibility and 320 px overflow checks and was visually reviewed.
- The export and ZIP code load on demand and generate files locally. The design detector returned no findings. Dependency installation reported zero known vulnerabilities. The running staff and guest preview assets were verified after the build.

## Internet staging readiness

- `npm.cmd run test:all` passed with 22 API and storage tests, two startup checks, and the staff Edge walkthrough. `npm.cmd run test:hosted` passed against a disposable PostgreSQL 17 database using verified TLS. The fixture confirmed encryption through PostgreSQL session metadata. Connection policy tests rejected options that could weaken TLS or change the configured host.
- The hosted test stopped the HTTPS listener, attempted a real publish request, and confirmed the local change stayed pending while PostgreSQL retained the last published menu. Restarting the receiver on the same address allowed the queued sold-out change to publish.
- The staging checker passed against the local HTTPS fixture, including the guest page, assets, catalog, dish photo, anonymous publish rejection, and absent staff API. Internet deployment, the physical outage walkthrough, and phone scans remain pending a public hosting target.

## Dine-in coupons

- `npm.cmd run test:all` passed with 22 API and storage tests, two startup and HTTPS checks, and the staff Edge walkthrough. The database migration preserved the older menu fixture and the existing preview started with its sample credentials.
- The server tests covered admin and counter boundaries, normalized codes, duplicate creation, invalid and expired codes, minimum spend, subtotal caps, stale checks, changed discounts, pause and resume, and simultaneous receipt retries. The saved discount and official receipt amount survived a restart. Existing payment and table release checks passed.
- Edge created `RANCHI50` as admin, quoted ₹50 off a ₹780 check at the counter, recorded an official total of ₹740.50, and marked the receipt paid via UPI. The admin view passed automated accessibility and overflow checks at 320 px and was visually reviewed. The design detector reported no findings.
- Customer claims, phone verification, public offer publication, and verification with the restaurant's actual billing software remain separate milestones.

## Guest phone sign-in

- `npm.cmd run test:all` passed with 22 API and storage tests, two startup and HTTPS checks, and the staff Edge walkthrough. `npm.cmd run test:hosted` passed against local PostgreSQL and HTTPS using simulated Twilio Verify responses. The existing preview database was upgraded and the guest menu reopened in browse mode.
- The hosted test covered invalid numbers, cross-origin writes, repeat-send cooldown, a wrong code followed by a correct code, expired and exhausted challenges, replay rejection, masked account data, secure cookie attributes, session persistence on refresh, and revocation on sign-out. No real SMS was sent.
- The guest form passed automated accessibility checks at 320 px and was visually reviewed. The design detector reported no findings. Live delivery with provider credentials remains a release check, along with customer claims and private feedback.

## Private receipt feedback

- `npm.cmd run test:all` passed with 22 API and storage tests, two startup and HTTPS checks, and the staff Edge walkthrough. A paid check kept the same code across retries and restart, each split receipt received its own code, and an unpaid receipt had no code. Edge checked the selected slip's print content and verified that receipt details were hidden.
- The final hosted tests passed with PostgreSQL, HTTPS, and simulated SMS. A code issued offline became usable after sync. The payload contained only a digest and expiry. The tests covered unsigned guests, expired and reused codes, simultaneous submissions, attempt limits, republishing a used code, a host with sign-in disabled, and cross-outlet access.
- Edge submitted the guest form at 320 px and verified its confirmation and automated accessibility checks. The design detector returned no findings. The owner API retrieved only rating, comment, timestamp, and feedback ID. The local previews were refreshed and the owner inbox endpoint was verified. A real printed slip and live SMS redemption remain staging checks.

## Public offers and phone-linked claims

- `npm.cmd test`, `npm.cmd run test:startup`, `npm.cmd run test:browser`, and the final `npm.cmd run test:hosted` passed. The staff browser created a public offer and separately used a shared coupon. The migrated staff and guest previews were restarted.
- The hosted flow covered anonymous browsing, verified-only claims, a repeated claim returning the same entry, cross-account claim privacy, waiting status after a lost response, durable local receipt of the code, and the acknowledgment required before exposing it. Public snapshots excluded shared counter codes. A second installation and older offer snapshots were rejected.
- The counter redeemed a saved code during a simulated connection failure. The same receipt retry was safe and a second receipt could not use the code. Reconnection marked it redeemed in the guest account. The owner could pause the offer locally and remove it from the public list after sync. Edge verified the waiting, ready, and redeemed states, and the ready view passed the automated accessibility and visual checks at 320 px. The design detector reported no findings.

## Windows installer kit

- Built and checksum-verified the Windows x64 `0.1.0` ZIP with official Node.js `22.23.4`. Verified the archive scripts against their workspace sources. `npm.cmd run check` and the production build passed.
- `npm.cmd run test:windows` passed from the extracted ZIP. It installed to a fresh temporary path with spaces, created sample accounts, started the bundled service, placed a two-chai order, and verified the order after a process restart. An attempted update while running and a damaged candidate were rejected. A valid compatible candidate activated, and rollback preserved the order. A simulated newer database schema was rejected before rollback, preserving the active release.
- Windows accepted the limited Local Service principal, boot trigger, and restart settings in a task definition. Actual task registration, ACL verification on a clean counter, reboot, disk exhaustion, and release signing remain release checks. The isolated test used the manual launcher and a temporary database.
