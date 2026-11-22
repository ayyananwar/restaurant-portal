# Restaurant portal

Restaurant Portal is a single-outlet restaurant service system in active development. The Windows staff app handles table service, pay-first counter orders, kitchen updates, receipts, menu management, and owner reporting. A separate guest website serves the published menu, offers, phone sign-in, and private feedback. Staff can record receipts from existing billing software; the current development build also provides built-in bills and printing.

## Project status

| Area | Available in the development build |
| --- | --- |
| Waiter, kitchen, and counter | Table ownership and transfers, preparation, order corrections, joins and splits, pay-first counter orders, tokens, refunds, and paper-order entry |
| Admin | Service modes, staff accounts and tables, owner resolutions, menu catalog, photos and availability, activity reports, QR cards, menu images, coupons, and feedback |
| Guest website | Classic and Photo-led menus, availability, phone sign-in, offer claims, and receipt-linked feedback |
| Distribution | Windows installer packaging and a separate hosted guest service |
| Built-in billing · development | Non-GST receipts, GST invoices, bills of supply, saved-bill search, counter credit notes and native receipt/A4 printing |

The code has been tested with local browser and service fixtures. One iQOO phone/Windows table-order, kitchen, billing and table-release walkthrough passed with the user. The outlet pilot still needs a second physical phone, outage and reboot checks, a physical printer, the selected billing product, production staging, and real SMS delivery.

Version 0.2.0 adds Table service, pay-first Counter service, and Both as outlet modes. The [service-mode plan](BUILD_PLAN.md#service-modes-included-in-the-first-release) tracks their acceptance checks and remaining outlet verification.

Version 0.3.0 adds built-in billing, invoice history, counter credit notes and native receipt/A4 printing. Its Windows kit passed isolated installation, invoice persistence, update and rollback checks. See [the verification log](VERIFICATION.md#windows-billing-package-030--23-november-2026) for exact scope and remaining pilot gates. This is an ongoing development project, not a production deployment.

### Built-in bills in the current development build

The frozen 0.2.0 Windows package uses external billing handoff. The 0.3.0 kit and current development previews add built-in billing. As owner, open **Outlet overview → Billing setup → Configure billing**. Enter the business identity, state, invoice series and applicable tax details. Start with **Test · not for customer use**. This version uses one tax rate/classification per profile. Mixed item tax rates and electronic tax reporting are not included; verify the outlet's requirements before customer use.

As of 23 November 2026, the active PC preview (`http://127.0.0.1:3100`) and phone preview (`https://10.155.0.148:3443`) use the same sample restaurant in `data/phone-pilot/sample.sqlite`, the current development build, and the accounts in `data/phone-pilot/accounts.txt`. Sign in as `admin` for billing setup. The former separate PC sample database and `data/preview-accounts.txt` are preserved but are not the active preview's accounts. The phone IP depends on the current Wi-Fi lease. Restart its development lab with `node scripts/phone-lab.js --address=<current-private-Wi-Fi-IPv4> --development=true` after building. Do not start two phone labs on the same ports. The PC loopback listener is configured separately; production remains one managed installation.

Billing staff can select **Create built-in bill** on a table check or unpaid counter order, enter any buyer/coupon details, and **Preview bill**. Table bills can be issued unpaid and later marked paid. Counter bills require recorded payment before the kitchen token is issued. **Record receipt** retains the existing external-billing workflow. Open **Saved bills and credit notes** to search and reprint after a table has been released. Partial/full paid counter cancellations create linked credit notes; actual refunds remain external and need a recorded reference.

Saved bills offer 58 mm, 80 mm and A4 layouts. The native print dialog supplies installed printer choices, copies and paper settings. On the development PC only Microsoft Print to PDF and OneNote were installed; physical printer compatibility has not been verified.

## Set up service modes

For a separate counter-only sample, set a new database path before setup.

```powershell
$env:RESTAURANT_DB = 'data/counter-demo.sqlite'
npm.cmd run setup -- --demo --mode=counter
npm.cmd start
```

The counter sample creates owner, billing, and kitchen accounts with generated passwords. Use `--mode=both` for a mixed-service sample with tables and waiters. Existing installations migrate to Table service.

To provision an empty real outlet, use a new database path and `npm.cmd run setup -- --outlet --mode=counter`, `--mode=table`, or `--mode=both`. Save the generated credentials privately. The owner can add staff, reset another account's password, enable or disable access, and add or rename tables under **Outlet overview → Manage staff and tables**. Add dishes in **Menu catalog**. Table-service outlets need tables and enabled waiter accounts before service.

Owners change the service mode under **Outlet overview → Change service mode**. Existing open orders remain available for completion. Owners can require counter approval for changes after preparation starts or block those changes.

## Counter orders

1. Sign in as billing and open **Counter orders → New counter order**. Choose Dine-in or Takeaway, enter optional handover details, and select dishes.
2. Review the draft and choose **Save for payment**. The unpaid order remains at the counter and survives a server restart.
3. Collect payment through the restaurant's payment and billing arrangements. Enter the external receipt reference, official amount, and payment method, then choose **Record payment and issue token**. The portal records the outcome supplied by staff.
4. The kitchen receives the paid order with its token and dish notes. Staff mark dishes ready. Billing confirms collection when all remaining dishes are ready. Reprinting a token keeps the same order and token.
5. For a paid correction, choose **Cancel some items**, enter the quantity, refund amount from the official receipt, and reason. Full cancellation records the remaining refundable amount. Record the refund through the external payment system, then save its reference with **Record external refund**.

The original receipt remains in the history. Corrections cannot exceed its refundable amount. Full kitchen cancellations remain visible until kitchen staff acknowledge them. **History** displays the last seven days of closed counter orders, while unresolved work remains visible. The owner activity report includes counter counts and amounts by cashier and service type for the selected period.

For paper recovery, choose the paper source and original reference when starting the counter order. Live paper entries reach the kitchen after payment is recorded. Already-served entries are recorded as ready and stay out of the preparation queue.

## Unpaid table resolutions

Table orders stay locked until paid and ready or until an owner records a resolution. The owner opens **Review unpaid resolution** on the table, reviews the balance against the billing software, enters a reason, and confirms **Record resolution and free table**. A changed balance requires a new review. The resolution remains in owner history and the kitchen receives an instruction to stop remaining preparation. This records the owner's resolution separately from payment.

## Operating and incident checklist

- Before opening, confirm the Windows service, staff Wi-Fi, sign-in, menu availability, printer, and external billing/payment system work. Assign an owner contact for financial resolutions and a support contact for the Windows service and hosted menu. Record those contacts privately in the outlet handover.
- During an internet outage, keep staff on the local Wi-Fi. Local service continues and public menu changes wait to synchronize. Inspect the publication status after reconnection.
- During a staff-network outage, use paper and the main counter. Record original paper references when reconciling. Review saved orders before entering a payment again.
- If a payment save times out, check the pending or paid order and the external receipt before retrying. Use the original pending order. Resolve stale changes from the refreshed state.
- If the local service fails, inspect its service logs, available disk space, and Windows task status. Stop service before attempting database repair. Preserve the original database and its associated SQLite files for authorized investigation.
- Before an update, follow the Windows installer procedure below and retain the previous compatible installer. Verify sign-in, an order, and a public menu update after the update.
- The application currently has no supported automated backup-and-restore workflow. The local database contains operational history. Loss of its drive can lose that history. A production retention and recovery decision remains a release requirement.

Deploy the hosted service and provision production credentials after local verification and the required outlet checks. The build plan tracks trusted HTTPS, guest-network isolation, physical printing, real SMS delivery, and staging verification.

## Repository guide

| Path | Contents |
| --- | --- |
| [`src/client`](src/client) | Staff screens and guest menu interface |
| [`src/server`](src/server) | Outlet service, SQLite storage, and menu publishing |
| [`src/hosted`](src/hosted) | Hosted guest service and PostgreSQL storage |
| [`src/shared`](src/shared) | Data contracts shared by the services and browser |
| [`test`](test) and [`scripts`](scripts) | Automated checks and Windows packaging |

Use the [build plan](BUILD_PLAN.md) to track outstanding work, the [design system](DESIGN.md) to guide UI changes, and the [verification record](VERIFICATION.md) to log tests and physical walkthroughs. For each change, update the relevant test and record checks that still need a real device. Demo setup generates local data and sign-in details. This repository tracks the packaging scripts and source so each build can generate its own installer and runtime files.

## Run the sample outlet on Windows

Use Node.js 22.14 or a compatible newer release and run these commands in PowerShell from this directory.

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run setup -- --demo
npm.cmd start
```

Open [the local portal](http://127.0.0.1:3100). Setup prints separate randomly generated passwords for admin, waiter, kitchen, billing, and a second waiter. Use separate browser profiles or private sessions to operate multiple roles at once. Setup refuses to replace an existing outlet. The default data file is `data/outlet.sqlite`. Use a separate `RESTAURANT_DB` path to create a fresh sample while retaining the original.

The local link works on the Windows computer while the server is running. If it stops opening, run `npm.cmd start` again from the project folder. The separate preview created during development uses `data/preview.sqlite` and saves its sample sign-in details in `data/preview-accounts.txt`. To resume that preview, set `$env:RESTAURANT_DB = 'data/preview.sqlite'` before starting the server.

Set `$env:RESTAURANT_SAMPLE_ARTWORK = '1'` when running the sample to show reference thumbnails for the four demo dishes. Photos uploaded through **Menu catalog** take precedence.

Open the [Classic guest menu](http://127.0.0.1:3100/guest-menu) or [Photo-led guest menu](http://127.0.0.1:3100/guest-menu?theme=photo-led) without signing in. Both read the local catalog. Sign in as admin and open **Menu catalog** to add, replace, or remove a dish photo.

## Windows installer kit

Build on Windows x64 with the project dependencies installed. Extract an official Windows x64 Node 22 distribution, verify its SHA-256 against the release checksums, and keep its `node.exe` and `LICENSE` together. Supply that directory to the packaging script. [Official Node 22 downloads and checksums](https://nodejs.org/dist/latest-v22.x/)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/package.ps1 -NodeDirectory 'C:\path\to\node-win-x64'
```

The ZIP and its SHA-256 file appear in `dist/windows`. Verify the ZIP against the checksum from your trusted release channel before extracting. The kit includes the runtime, so the restaurant computer can install and run it offline. The checksum and inventory detect corruption. Release signing remains a release gate.

For an isolated sample install, extract the ZIP, open PowerShell in the extracted folder, and use a new folder. If port 3100 is already in use, edit the installed `settings.json` to set `RESTAURANT_PORT` to `3101` before launching.

```powershell
$sampleRoot = Join-Path $env:LOCALAPPDATA 'RestaurantPortalSample'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -Root $sampleRoot -Demo
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $sampleRoot 'Launch.ps1')
```

Open [the sample staff portal](http://127.0.0.1:3100) or [port 3101](http://127.0.0.1:3101) if changed. Sign in as `admin`, `waiter`, `kitchen`, or `billing` using the matching entry in `data/demo-accounts.txt` under the sample installation. The launcher stays running while the app is open. Its startup logs are `data/service.log` and `data/service-errors.log`.

For automatic startup at the outlet, run `Install.ps1 -RegisterStartup` from administrator PowerShell. The default directory is `%ProgramData%\RestaurantPortal`. The task starts the app at boot as Windows Local Service. The database is in `data/outlet.sqlite`, separate from the versioned program files. Before the pilot, provision the outlet database and actual staff accounts. `-Demo` is for sample data. Set the staff network and publication values in `settings.json` as strings. Use absolute certificate paths readable by Local Service and configure staff-only firewall access separately. [Windows startup triggers](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasktrigger)

For a newly installed real outlet, stop the service and provision its accounts with the bundled runtime. Use the actual installation root if it differs.

```powershell
$outletRoot = Join-Path $env:ProgramData 'RestaurantPortal'
$activeRelease = Get-Content (Join-Path $outletRoot 'active.json') -Raw | ConvertFrom-Json
$outletApp = Join-Path $outletRoot "versions/$($activeRelease.active)/app"
$env:RESTAURANT_DB = Join-Path $outletRoot 'data/outlet.sqlite'
& (Join-Path $outletApp 'runtime/node.exe') (Join-Path $outletApp 'dist/server/setup.js') --outlet --mode=both
```

Save the generated accounts privately, configure the network and hosted settings, and restart the service. Setup refuses an outlet that already has staff. Use owner setup in the portal for subsequent staff or table changes.

Before updating, finish service, disable and stop the `RestaurantPortal` task, and verify the outlet process has stopped. Run `Install.ps1 -RegisterStartup` from the new verified kit. It checks the release against a temporary SQLite copy before switching versions, then starts the task. For a compatible rollback, stop the task the same way and run `Install.ps1 -RegisterStartup -Rollback`. Rollback refuses a release that cannot read the current database. Keep the live database intact while investigating an incompatible rollback.

To verify the kit with the manual launcher, set `RESTAURANT_WINDOWS_PACKAGE` to the ZIP's absolute path and run `npm.cmd run test:windows`. It uses a disposable directory to check installation, restart, damaged payload rejection, compatible rollback, and preservation of the database when an older release cannot read it.

For the release boot check, use a clean Windows x64 test PC or VM. Extract the verified ZIP, open administrator PowerShell there, and run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -Demo -RegisterStartup`. Open [the sample staff portal](http://127.0.0.1:3100) and sign in as `waiter` using `%ProgramData%\RestaurantPortal\data\demo-accounts.txt`. At **Table 1**, enter two **Masala chai** and send the order. Reboot Windows, open the same address, and verify that Table 1 still shows two chai and that the task is running under Local Service. Record the Windows version, the result, and the first step that differed.

## Menu publication

The local service records a pending version whenever guest-visible dish details, availability, or a photo change. The publisher sends the latest complete menu after reconnection. Service orders, staff records, and bills stay in the outlet database. Publication is disabled until the matching hosted receiver is provisioned.

Set `RESTAURANT_PUBLISH_ORIGIN` to the receiver's HTTPS origin, `RESTAURANT_PUBLISH_OUTLET` to the assigned outlet slug, and `RESTAURANT_PUBLISH_TOKEN` to the receiver-issued 32-byte installation secret in lowercase hex. Supply the secret through the service environment. An authenticated admin can read `GET /api/menu/publication` for `configured`, `pending`, and `publishedAt` (Unix milliseconds or `null`).

The receiver contract uses the installation bearer token on every request under `/api/publish/<outlet>`. Bind it to that outlet and allow one active publishing installation per outlet in the first release.

| Request | Receiver behavior |
| --- | --- |
| `HEAD /photos/<sha256>` | Return `204` for a staged photo owned by the outlet or `404` when absent. |
| `PUT /photos/<sha256>` | Validate the WebP body and its SHA-256, stage it within the outlet, and return `204`. Identical retries return `204`. Keep staged photos private until a published menu references them. |
| `PUT /menu` | Accept a JSON snapshot containing `version` and guest `items`. Validate fields and photo references, atomically replace the outlet menu for a newer version, and return `204` after committing. Return `204` for an identical current version and `409` for an older version or a conflicting repeat. Retain the original publication time on an identical retry. |

The local queue coalesces changes during an outage and keeps a newer edit pending if an older version is acknowledged during upload. The publisher checks for existing photo hashes before sending bytes and retries failed cycles with a delay that increases up to two minutes. Provisioning a replacement installation or restoring an older database requires reconciling the hosted version before resuming publication.

### Run the hosted menu service

The hosted process serves the shared guest menu build and stores outlet menus and WebP photos in PostgreSQL. Use a dedicated PostgreSQL database. The service requires certificate and hostname verification for remote connections. Use a PostgreSQL URL with the host, user, and database in the URL itself. The only accepted query setting is `sslmode`. Use `verify-full` to require TLS explicitly, including in local TLS tests. Literal loopback addresses may use plaintext for local development. For a private CA, set `NODE_EXTRA_CA_CERTS` to the trusted PEM bundle before starting Node. Keep database and installation credentials in the service environment.

1. Run `npm.cmd ci` and `npm.cmd run build`.
2. Set `HOSTED_DATABASE_URL` and `HOSTED_INSTALLATION_TOKEN` in the provisioning environment. Generate a separate random 32-byte installation secret for each outlet and encode it as lowercase hex.
3. Run `npm.cmd run setup:hosted -- ranchi-cafe "Ranchi Café" photo-led`. Use `classic` for the text-led layout. Setup creates the hosted tables and provisions the outlet. Reusing a slug fails without replacing its data or credential.
4. Run `npm.cmd run start:hosted` with `HOSTED_DATABASE_URL`. It listens on loopback port 3200 by default. Use `HOSTED_BIND`, `HOSTED_PORT`, `HOSTED_TLS_KEY`, and `HOSTED_TLS_CERT` for a direct TLS listener, or terminate HTTPS at a trusted proxy on the same machine. Use the externally reachable HTTPS origin in the restaurant publisher configuration.
5. Configure the local publisher with the assigned slug and matching installation secret. Open `/r/ranchi-cafe` on the hosted service after the first acknowledgment. For a loopback preview with a published fixture, use [the local hosted menu](http://127.0.0.1:3200/r/ranchi-cafe).

The hosted menu accepts up to 2,000 dishes per snapshot and 256 MiB of staged and published photo bytes per outlet. It serves only photos currently referenced by a published menu. On a new upload, it prunes unused staged photos older than 24 hours. The guest pages carry a `noindex` directive during staging.

### Guest phone sign-in

Run `npm.cmd run setup:hosted -- --schema-only` with the hosted database URL to apply the account tables to an existing database. To enable sign-in, set `HOSTED_ORIGIN` to the guest site's exact HTTPS origin and `HOSTED_PHONE_KEY` to a random 32-byte secret encoded as lowercase hex. Keep that key stable with the database so returning numbers map to their existing accounts. Configure `TWILIO_VERIFY_SERVICE_SID`, `TWILIO_API_KEY_SID`, and `TWILIO_API_KEY_SECRET` for a Verify service configured for six-digit SMS codes, a ten-minute validity window, and India delivery. Keep fraud protection enabled on the Verify service. [Twilio Verify](https://www.twilio.com/docs/verify/api/verification)

For direct HTTPS leave `HOSTED_TRUST_LOOPBACK_PROXY` unset. If a trusted reverse proxy on the same host terminates HTTPS, set it to `true`. Configure the proxy to preserve the public `Host` header and replace incoming `X-Forwarded-For` with its verified client address. This lets the app apply per-IP send limits. Use the localhost hosted integration test for simulated delivery. The sample guest preview stays in browse mode when provider settings are absent.

The guest site accepts Indian mobile numbers and stores a keyed phone identifier and the last four digits. The provider verifies the SMS code. The application keeps a short-lived challenge and a hashed session, with same-origin writes and a secure cookie. Sign-out revokes that session. Phone sign-in is optional while browsing the guest menu.

### Verify internet staging

Use an internet-reachable HTTPS origin with a publicly trusted certificate and a sample outlet. Publish a small test menu that includes a dish photo. Run the following check with the actual staging origin and outlet slug. It checks the guest page, assets, catalog, and a published photo, plus the staff API and anonymous-write boundaries.

```powershell
npm.cmd run check:staging -- https://menus.example.com ranchi-cafe
```

1. From the counter on staff Wi-Fi, sign in as the sample `admin` and open **Menu catalog**. Confirm **Public menu is up to date**. Open the staging menu from a second phone on mobile data and note the price and update time of the test dish.
2. Disconnect only the restaurant router’s internet uplink. Keep the staff Wi-Fi and counter powered. Mark the test dish sold out, then confirm it changes locally and the admin catalog shows changes waiting to publish. On the phone, refresh the staging menu and confirm it still shows the last published state.
3. Restore the uplink. Allow up to two minutes for the next retry plus transfer time. Confirm **Public menu is up to date** and that the phone now shows **Sold out** and a newer publication time.
4. Print **Table 7** from **Table QR cards** and scan it from the phone on mobile data. Confirm it opens the staging outlet menu with no sign-in prompt. Repeat with one other table.
5. Record pass or fail, the first differing step, the device and browser, and the visible error or a screenshot with private data removed. Keep the host, staging addresses, and sample account handoff with the test record. Share passwords privately.

### Print table QR cards

Sign in as admin in the [local portal](http://127.0.0.1:3100), then open **Table QR cards** from **Outlet overview**. Choose **All tables** or one table. Use **Open guest menu** to check the destination and **Print cards** to open the browser print dialog. Use A4 and turn off browser headers and footers for the cut sheets.

Guest-ready cards become available after the outlet's first acknowledged publication. Keep the published outlet address stable after printing. Each table has a distinct fragment in its URL, and every card opens the same guest menu. For a loopback test only, set `RESTAURANT_QR_PREVIEW_URL` to `http://127.0.0.1:3200/r/ranchi-cafe` before starting the local service. Each preview card is marked for this computer only.

### Export menu images

Open **Menu catalog → Export menu images** as admin. Enter a title and choose **Create preview**. The full catalog appears as numbered 1080 × 1350 portrait images. Each image shows category headings, dish names, prices, and sold-out labels as of its snapshot time. Use **Download this PNG** to save the selected page. When there are multiple pages, **Download all as ZIP** saves the complete set of PNGs.

## Dine-in coupons

In **Outlet overview → Dine-in coupons**, an admin can create, pause, or resume shared codes. A code has a fixed rupee discount, an optional minimum item subtotal, and an optional expiry in India time. Each whole or split check accepts one code. The discount is capped at the subtotal.

At the counter, open **Record receipt**, enter the code, and choose **Check coupon**. Apply the displayed discount in the restaurant's billing software. Enter its official receipt reference and final amount. Saving checks the coupon again and records the code and discount with the receipt. If the coupon changes before saving, resolve the discrepancy in the billing software before completing the handoff.

### Public offers and claims

Add a **Public offer title** when creating a dine-in coupon to publish it to the guest menu. Keep the title blank for a shared counter code. Guests sign in by phone to save one claim per offer. The private `CL-` code appears in **Your claims** after the restaurant computer has saved it and acknowledged the save. The guest can return to the same phone account to view the code.

The counter checks a `CL-` code through the same receipt workflow. The local receipt uses it once, including during an internet outage after sync. A pause or expiry applies at the counter immediately. After reconnecting, the guest menu updates availability and marks used claims redeemed. Only the offer details, claim code, and sync status cross this connection. The counter sees the code and discount.

Apply `npm.cmd run setup:hosted -- --schema-only` before enabling offers on an existing host. Offers need guest phone sign-in and one authoritative counter database per outlet. The receiver binds offer sync to that database's installation identifier. Reconcile pending and redeemed claims before replacing or restoring the authoritative database. The first release supports 1,000 public offers per outlet.

## Private receipt feedback

When the counter records payment on a new whole or split check, the staff app creates one feedback code for that paid receipt. Choose **Print feedback slip** before releasing the table if the receipt software cannot print the code. The slip has the code, expiry, and the guest-menu address when configured. It leaves out the receipt reference and amount.

The code expires 14 days after payment. While offline, the counter can still issue it and the slip explains that it will work after sync. Only the code digest and expiry are published. After signing in by phone, the guest can choose **Leave private feedback**, enter the code, and send one rating and optional comment. The app accepts one response per code.

The admin can open **Outlet overview → Private feedback** for the latest 100 responses. The inbox requires the hosted connection. It displays the rating, comment, and time. Apply the hosted database update with `npm.cmd run setup:hosted -- --schema-only` before enabling the feedback flow.

## Checks

```powershell
npm.cmd test
npm.cmd run test:startup
npm.cmd run test:browser
npm.cmd run test:billing-browser
```

Run `npm.cmd run test:all` to execute these checks in order. Set `RESTAURANT_TEST_OPENSSL` to the OpenSSL executable path to include the HTTPS handshake and secure-cookie check. It creates and discards a temporary test certificate without changing the Windows trust store.

Run `npm.cmd run test:hosted` after building to exercise real PostgreSQL storage, HTTPS publication, and the hosted Edge view. Set `HOSTED_TEST_DATABASE_URL` to a disposable test database with schema creation rights, `HOSTED_TEST_TLS_KEY` to a test key, and `NODE_EXTRA_CA_CERTS` to its matching self-signed `127.0.0.1` certificate in PEM format. The check creates and drops its own randomly named schema and uses a random port.

The browser test uses an installed Microsoft Edge by default. Set `RESTAURANT_TEST_BROWSER=chrome` in your environment to use installed Google Chrome. It exercises a phone-sized browser workflow and blocks requests to external sites. A real two-phone Wi-Fi test is a separate milestone check.

## Staff network setup for a lab test

The default endpoint is for the counter computer only. For a test with phones, provision an HTTPS certificate and private key for a stable hostname that resolves over the outlet network and is trusted by the phones. Keep the private key and SQLite files readable only by the Windows service account and authorized administrators. Permit the service port only from the staff subnet, then verify guest Wi-Fi cannot reach it.

Set `RESTAURANT_BIND` to the counter's staff-network address, `RESTAURANT_PORT` to the listener port, and `RESTAURANT_ORIGIN` to its exact HTTPS origin. Set `RESTAURANT_TLS_KEY` and `RESTAURANT_TLS_CERT` to PEM file paths. The service requires TLS for a network listener and checks the request host against the configured origin. Use the provisioning procedure above for real accounts. Actual Windows boot registration and real-device sign-off remain in the build plan.

### Offline lab walkthrough

Run this with a fresh sample database and a verified staff-network HTTPS address. Before handing it to a tester, provide the actual address, confirm both phones trust the certificate, and privately provide the generated `waiter`, `kitchen`, and `billing` logins from sample setup.

1. Connect both phones and the Windows counter to staff Wi-Fi. Confirm the HTTPS address opens on both phones. Verify the guest network cannot reach it.
2. Disconnect the router's internet uplink while leaving the router and staff Wi-Fi powered. Keep both phones on staff Wi-Fi and disable mobile data for this check. Sign in as `waiter` on the first phone, `kitchen` on the second, and `billing` on Windows.
3. On the waiter phone, select **Table 7** and **Take order**. Search for **Paneer tikka**, tap **Add** twice, then search for **Masala chai** and tap **Add** once. Tap **Review order**, enter **Less spicy** on Paneer tikka, and tap **Send to kitchen**. The draft total should be **₹540.00**.
4. On the kitchen phone, verify Table 7 has both dishes with their correct quantities and the note. Start preparing the paneer, then mark both dishes ready. The counter should show Table 7, both dishes as ready, and **₹540.00**.
5. In the counter view, choose **Move table**, select **Table 9**, and confirm. Choose **Transfer waiter**, select **Second waiter**, and confirm. The kitchen should show the original dishes and ready states under Table 9. The counter should still show **₹540.00**.
6. Restart Windows. Start the lab service again with the same configuration and database until automatic startup is implemented. Sign in at the counter and verify Table 9 still has the transferred order, both ready statuses, and the same total. Reconnect the internet uplink and re-enable phone mobile data.

Record pass or fail, the first step that differed, the device and browser, and the exact message or a screenshot with private data removed.
