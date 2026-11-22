# Restaurant Portal design system

Version 2.1 · Staff design specification. The supplied `resimg` references define the staff visual direction. The runtime source for shared tokens is [the staff stylesheet](src/client/styles.css). Follow the [build plan](BUILD_PLAN.md) for real-device checks.

## Overview

Use Telegram as the interaction reference for staff work. Give staff compact, readable lists, search where they expect it, a clear selected row, and a stable place to act. On a phone, show the current task in one pane. On a PC, keep context and the active task visible together. The roles keep the same words, status meanings, and actions at every width.

Use warm ivory surfaces, navy primary actions, gold section accents, and status colors paired with text. Every admin page uses the full-width outlet overview banner and navigation above its content. Show the current admin page in navy with a programmatic current-page state. Arrange the same six destinations in two columns on phones, three on tablets, and six when there is enough desktop width. Waiter, kitchen, and counter workspaces use a navy sidebar on desktop and a compact navigation strip on phones. The two guest themes retain their own restaurant-facing palettes.

The sign-in, outlet overview, table service, order picker, kitchen queue, counter checks, menu catalog, coupons, and waiter activity follow the corresponding reference layouts. The supplied Dish Availability file duplicates Counter Checks, so use the catalog layout with kitchen controls there. Carry the same visual system into QR cards, exports, paper entry, feedback, and other staff screens without separate references. Use live values for totals, statuses, and counts. Optional demo artwork comes from the supplied images. Show outlet-uploaded photos in production.

### Research and decisions

| Reference | What we’re adopting |
| --- | --- |
| Telegram’s search, folders, and compact desktop mode | Search near the top of the working list, a short row of filters, a clear active selection, and a single-pane layout when there is limited width. [Search and filters](https://core.telegram.org/api/search) · [Chat folders](https://www.telegram.org/blog/folders?setln=en) · [Compact mode](https://telegram.org/blog/desktop-compact?setln=en) |
| Square for Restaurants | Use menu groups as an alternative to search. A simple dish goes into the draft in one action. Reserve an extra details step for a required choice when structured modifiers enter scope. [POS item grid](https://js.squareup.com/help/us/en/article/8334-set-up-item-grid) · [Restaurant modifiers](https://squareup.com/help/us/en/article/5119-create-and-manage-item-modifiers) |
| Toast | Keep staff menu groups ordered by how the outlet serves food. Model group, item, and modifier as separate concepts so a complex menu can grow without changing the basic order flow. [Menu groups](https://doc.toasttab.com/doc/platformguide/platformMenuManagerWorkingWithMenuGroups.html) · [POS layout](https://doc.toasttab.com/doc/platformguide/platformAccessingPosLayoutView.html) |
| Material and IBM Carbon | Use an adaptive list and detail layout. Name color tokens by what they do so selection, focus, and status retain the same meaning across components and widths. [Material adaptive layouts](https://developer.android.com/develop/adaptive-apps/guides/canonical-layouts) · [Carbon color roles](https://www.carbondesignsystem.com/building-blocks/foundations/color/overview) |
| shadcn/ui and WCAG | Build on the existing local primitives and semantic CSS variables. Use WCAG 2.2 AA as the accessibility target. [shadcn theming](https://ui.shadcn.com/docs/theming) · [WCAG 2.2](https://www.w3.org/TR/WCAG22/) |

## Colors

Use the following light-theme values for staff screens. Guest themes may override brand and surface tokens after testing contrast. Keep status meanings identical across guest and staff surfaces. Theme changes belong in the token layer, with shared primitives consuming semantic names.

| Role | Value | Use |
| --- | --- | --- |
| `background` | `#FAF6F1` | Workspace canvas |
| `surface` | `#FFFDFA` | Lists, composer, forms, and counter details |
| `foreground` | `#0A2240` | Dish names, table names, totals, and main text |
| `muted-foreground` | `#4D6073` | Labels, metadata, notes, and empty-state copy |
| `border` | `#DAE3EC` | Decorative dividers and pane boundaries |
| `control-border` | `#77899A` | Identifiable control boundaries on canvas or white |
| `primary` / `primary-foreground` | `#073B69` / `#FFFFFF` | Main action and links |
| `primary-hover` | `#124D83` | Hover and pressed emphasis for primary controls |
| `selected-surface` / `selected-ink` | `#E5F1FC` / `#194F7E` | Current table, selected category, and information |
| `focus` | `#145BA2` | Visible keyboard focus on light surfaces |
| `warning-surface` / `warning-ink` | `#FFF0D5` / `#674100` | In preparation, reconnecting, or needs attention |
| `success-surface` / `success-ink` | `#E2F4EA` / `#1B5A3D` | Ready, saved, or connected |
| `danger-surface` / `danger-ink` | `#FDECEB` / `#8F2D2B` | Sold out, failed, or destructive actions |
| `disabled-surface` / `disabled-ink` | `#E8EDF2` / `#526477` | Disabled controls with readable context |

Recheck contrast in rendered states, including hover, focus, and any alpha blending. Decorative dividers are for separation and carry no state.

| State | Visible treatment |
| --- | --- |
| Available table | Neutral row with **Available** |
| Occupied table | Waiter name and **Occupied** where the context needs it. A separate selected state shows which table is open on this screen. |
| Queued dish | Neutral badge with **Queued** |
| Preparing dish | Amber badge with **In preparation** |
| Ready dish | Green badge with **Ready** |
| Sold-out dish | **Sold out** beside the dish name and a disabled Add action |
| Failed or unknown submission | Inline message with the next action. Preserve the draft and distinguish a rejected order from an order whose response was lost. |

## Typography

- Use Segoe UI for staff controls and body copy. Use Georgia for the main display titles and selected headings. Use a sans-serif title for kitchen screens. Keep staff assets local.
- Scale main titles between 32 px and 58 px. Keep body text, controls, and metadata compact enough for service and readable at phone widths.
- Use sentence case and short actions such as **Take order**, **Add**, **Review order**, **Send to kitchen**, and **Mark ready**. Use the same words on mobile and PC. Wrap long dish names and notes rather than hiding the distinguishing text.
- Right-align comparable prices and totals. Use tabular numerals, format money as INR with Indian grouping, and put quantity next to the dish. Format dates and times consistently using the outlet’s timezone.

## Layout

Use a spacing scale of 4, 8, 12, 16, 24, and 32 px. Start with 16 px phone gutters and 24–32 px on wider screens. Test width breakpoints with real menu names and enlarged text.

| Width | Staff layout |
| --- | --- |
| **320–767 px** | One pane at a time. Table list opens the selected table or composer. Keep the table name and dish search in view while picking. Use a bottom review bar that respects the safe area and on-screen keyboard. |
| **768–1023 px** | Use a compact list and detail layout when both remain readable. Collapse to one pane when window size, browser zoom, or a long translation makes either pane cramped. |
| **1024 px and up** | Use two panes with a stable selected row. In the waiter composer, use a flexible catalog and a 320–400 px order pane. Keep table context and the order total visible while scrolling the catalog. Allow the mouse and keyboard to reach every action. |

Use one component tree and one draft for both layouts. Resizing, zooming, opening the mobile review pane, or moving between search and categories preserves the active table and draft. Browser Back on mobile returns to the preceding pane with its scroll position. Closing an unsent draft or switching to another table must clearly preserve or confirm discarding the draft. A draft never silently moves to another table.

| Surface | Phone | PC |
| --- | --- | --- |
| Waiter | Table list → dish picker → review | Table list and selected table. When composing, show catalog and draft together. |
| Kitchen | Queue with table number, notes, and per-dish actions | Multi-column queue where space permits. Keep the table number and dish status visible. |
| Billing | Stacked check summary and actions | Checks list and selected check, with amounts aligned for comparison. |
| Admin | Overview navigation above stacked lists and focused forms. Coupon rows reflow into labelled cards. | Same navigation above the active workspace, with room for tables and wider lists. |
| Guest website | Restaurant identity, menu categories, and item list | Same sections with more room for menu and photography. |

## Elevation & Depth

Use surface changes and borders to establish hierarchy. Use a subtle shadow only for a floating overlay or a sticky bar when it overlaps content. Keep order rows flat and use separators for scanning. A modal is appropriate for a destructive decision or a focused edit that cannot fit inline. Trap focus inside it, provide a labelled title, and restore focus on close. Keep transitions brief and respect reduced motion.

## Shapes

Use 6 px radii on controls and 10 px on panels. Status badges may be rounded. Keep rows wide and compact, with a minimum 44 × 44 CSS px target for staff controls and an 8 px gap between neighboring touch actions where practical. Give keyboard focus a visible 2 px outline with offset. Keep focused content clear of sticky bars. Use 16–20 px icons from one licensed set when an icon adds meaning, pair critical actions with text, and give icon-only controls an accessible name.

## Components

Reuse the existing shadcn/ui Button, Input, Field, and Badge. Check the official registry before adding a new primitive. Prefer native controls where they serve the workflow. Compose shared patterns for list rows, search, feedback, and the order summary in one place so fixes apply to every role. Introduce each new component with its default, selected, focus, disabled, loading, empty, and error behavior where applicable.

Move keyboard focus to the new admin page heading when switching sections. Return focus to the originating control when closing a form or returning to the overview. During catalog and coupon edits, keep the navigation visible and explain that staff can save or cancel to switch sections. Verify that filters can recover from zero results, a failed request can be retried, and long labels can wrap inside their controls.

### Waiter dish picker

1. **Open a table.** Show its number and current order context in the header. Offer **Take order** or **Add to order** based on the table state. From here, the waiter can choose a visible dish directly.
2. **Find a dish.** Keep a labelled search field above the results. Filter the local menu by item name and category as the waiter types. Support case-insensitive matching and multiple words. Include **All** and the outlet’s categories in menu order. Search within the selected category, with a visible way to broaden to **All**. Show the query and a clear action when there are zero matches.
3. **Add in one action.** Each result has the name, price, and a clearly labelled **Add** control. A simple item adds one unit to the draft. The row and order count update immediately. Sold-out results remain findable with their status, but cannot be added. The server verifies price and availability again on submission. Required modifiers get a focused choice step when the product supports them.
4. **Review quantities and notes.** Show the draft count and total in a bottom **Review order** bar on phones and the visible order pane on PCs. Keep quantities editable with named plus and minus buttons. Merge repeated adds of the same plain item, and keep lines with different notes or options separate. Show notes beside the relevant dish and keep removing an item reversible until submission.
5. **Send deliberately.** Show the table number, quantities, notes, and current total before **Send to kitchen**. The phone uses the explicit review screen. The PC uses the already visible draft pane. Disable repeated sends while a request is pending. A retry of the same unresolved submission reuses its request ID. On success, show the confirmed order and clear only the sent draft.

**Keyboard and touch.** Place focus on search when a PC user opens the composer. On phones, avoid opening the keyboard until the waiter taps Search so the catalog remains visible. Tab reaches categories, results, quantity controls, and the send action. Enter or Space activates the focused Add button. Enter in search does not send the order. Keep focus predictable after Add and return it to the table action after closing the composer. Announce the draft count or an add confirmation without moving focus.

**Failure and recovery.** If Wi-Fi drops, keep the visible draft and show how to reconnect. A timeout after sending should offer **Retry submission** without creating a second order. If a dish becomes unavailable, identify the affected line when the server supplies that detail. Keep the other items and offer a clear way to remove or replace the unavailable dish. If the table changes ownership, show who owns it and return the waiter to the table list with a clear explanation.

### Sent dish changes

- Keep **Add to order** at table level. Put **Change dish** and **Cancel dish** next to the sent dish. Open quantity and note fields inline. A cancellation requires a confirmation that names the dish.
- A queued dish changes immediately. Under the default policy, an in-preparation dish shows **Counter approval pending** alongside the current instructions. Keep the current quantity and price in the check until the counter approves. The counter sees the proposed change with **Approve change** and **Decline change**.
- Keep cancelled dishes visible for kitchen and counter context and exclude them from the total. If the kitchen marks a dish ready before the decision, label the request as expired. If a request times out, offer **Retry change** with the same request ID.

### Table joins and split checks

- A move or transfer names the source before staff choose a destination. Enable confirmation after an eligible destination is selected. Keep the selection after a connection failure and ask staff to choose again if the destination changes. Focus the destination on open and return focus to the action on cancel.
- The counter starts a join from the source table. The confirmation names the source and lets the cashier choose the occupied destination. The destination keeps its waiter and receives the existing dish lines and kitchen states. Show the source as available after the join.
- Split by dish quantity. Show the original total above the editor and each resulting total beside its check. Unassigned portions stay on Check 1. Cancelled dishes stay out of the allocation. If the order changes while the editor is open, show a clear restart action.
- Saving locks price-affecting order edits while the counter uses the split. Keep kitchen progress visible and actionable. Explain the lock to the waiter and ask the cashier to confirm before reopening the check.

### Receipt handoff and table release

- Show the portal's item total and the official receipt amount separately. The counter enters the reference and amount from its existing billing software, plus the payment outcome. Each saved split has its own receipt and payment state.
- Show **Unpaid** or **Paid** with the payment method. When a receipt is recorded, lock the check’s dish quantities and any split allocation. Kitchen status updates can continue.
- The assigned waiter confirms **Mark table vacant** after guests leave. Enable release when every remaining dish is ready and every check is paid, or when all dishes were cancelled.

### Built-in billing

- Keep owner billing setup inside the existing overview. Use the shared Field, Input and Button primitives. Clearly distinguish test invoices, non-GST receipts, GST invoices and bills of supply. Expose the single-rate/classification limitation before enabling customer use.
- Offer **Create built-in bill** beside external receipt entry. Use one shared editor for table, split and counter bills. Preview the server-calculated items, discount, tax components and total before the deliberate issue action. Counter payment is required before kitchen submission.
- Preserve editable details on errors; block workspace changes and warn before leaving while a billing form is open. Concurrent profile/order changes require a new preview rather than silently changing a saved bill.
- Reuse one invoice document for previews, saved bills and native printing. Keep long names wrapping, quantities readable and amounts aligned at 320 px. Print black on white without staff navigation. Separate the paper layout choice from the printer/copies options supplied by the operating system.
- Keep saved-bill search accessible to billing staff and owners after a table closes. Reprint from the immutable snapshot. Show credit notes against the original invoice and explain that a credit note does not process a payment refund.

### Counter service and mixed service

These screens follow the [service-mode scope](BUILD_PLAN.md#service-modes-included-in-the-first-release) and its acceptance matrix.

- Configure Table service, Counter service, or Both within the shared admin overview layout. Show affected open orders before a mode change and retain a route to resolve them.
- Counter service opens the billing workspace with New order and clearly named pending-payment, preparation, ready, and history views. Mixed service gives cashiers a clear choice between Table checks and Counter orders.
- Reuse the dish picker and review pane. Ask for Dine-in or Takeaway and keep optional customer and seating details compact. Show payment confirmation as the action that issues a token and sends dishes to the kitchen.
- Keep item subtotal, coupon reduction, and official receipt amount labelled distinctly. Preserve the order and external receipt reference after a failed confirmation. Explain how to check a payment whose result is uncertain.
- Display token and service type prominently on the counter and kitchen tickets. Keep table orders identifiable by table number. Show preparation and payment states in text and show paid corrections and unresolved refunds explicitly.
- Enable Collected once remaining dishes are ready. Confirm the token before handover and keep reprinting available independently of order submission.
- Partial and full paid cancellations retain the original receipt and show their correction history. Collect the external refund amount and reference explicitly. Keep full kitchen cancellations visible until kitchen acknowledgment.
- Owner setup includes staff creation, access controls, generated credential handoff, and table labels. Keep passwords out of saved reports and show newly generated credentials only in the current action.
- Before a receipt or split is recorded, billing can reduce or cancel a ready table dish or correct its note, with a required audit reason. Owners can resolve an unpaid table after reviewing its current balance and recording a reason. Show the kitchen a separate stop-preparation notice.
- Use the same phone and PC interaction rules as the existing staff workspace. Verify empty queues, long names, missing optional data, keyboard focus, connection loss, retries, and simultaneous updates.

### Paper-order entry

- Focus the setup heading on open. If the selected table or waiter becomes unavailable, clear it from the visible selection and explain what to choose next.
- Put **Enter paper order** in the counter view. Ask for the table, the waiter to credit, and whether the food still needs preparation. For an occupied table, default to the assigned waiter and retain table ownership even if the cashier credits someone else.
- Use the existing dish picker and draft. **Send to kitchen** queues a live paper order. **Save served order** puts the items directly onto the check. Show the selected mode and credited waiter before the cashier submits.
- An already-served entry can include a currently sold-out dish. It stays out of the kitchen queue and uses the catalog item price in the portal. The official receipt amount is still recorded separately. Keep the draft intact when a table changes or the response is lost, and reuse the request ID on retry.

### Waiter activity

- Place the report in the admin overview. Offer day, week, and month views, with an optional date in the selected period. Use India time and show the actual date range. Weeks start on Monday, and months use calendar boundaries.
- Show each waiter’s distinct orders and total submissions side by side. Count each order once for each waiter who submitted an entry for it during the period. Keep earlier credit after moves, transfers, and joins. Show paper entries separately, with a live and already-served breakdown.
- Credit the waiter selected during paper entry and count it on the date it was recorded. Older entries without submission timestamps use the order opening date. Label that fallback in the report.
- Keep the report readable in a 320 px viewport. Align counts, wrap names, and preserve the last successful result if a refresh fails. Use a visible loading state and allow the admin to retry.

### Menu catalog and availability

- In the admin view, keep **Add dish** alongside menu search. Use one short form for name, category, INR price, and description. Suggest existing categories while allowing new ones. Preserve the form if saving fails.
- Give the kitchen an availability view with **Mark sold out**, **Edit estimate**, and **Confirm available**. The return time is optional and uses India time. Show the estimate and time remaining next to the sold-out label. After the estimate passes, show **Awaiting kitchen confirmation** until staff confirm.
- Update the waiter’s dish picker from the local catalog. Keep sold-out dishes visible and disable live adds. Preserve previously submitted item prices when the catalog changes. If the price changes between review and submission, ask the waiter to review the current total.

### Guest themes

- Both guest themes use the supplied restaurant-menu references. Use a dark navy hero with a copper biryani photograph, gold accents, an ivory canvas, illustrated category links, and rounded dish rows. **Classic** uses compact thumbnails and underlined category titles. **Photo-led** allocates more width to photos and uses a gold marker beside each category heading.
- Allow approved brand color, logo, and imagery through theme tokens and assets. Keep content order and controls common. Test text contrast over photos with the actual assets. If no photo is available, use the text layout gracefully.
- Keep staff sign-in and operations visually separate from the guest website. Photos help guests decide. Staff can identify dishes using text, price, and category.
- Both themes keep the same live dishes, prices, and availability. Search by dish name and category, show a clear action for zero results, and keep category links usable at 320 px. Omit the image frame when there is no photo. Sample dish artwork appears only in sample mode. Guests browse the dine-in menu and place orders with their waiter.
- Admins can upload, replace, or remove a dish photo. Accept a still JPEG, PNG, or WebP up to 4 MB and 16 megapixels. Store a resized WebP and display it next to the named dish. Keep the guest menu readable if a photo fails to load.
- The hosted menu uses the outlet name as its heading and the outlet’s selected theme. Show the last successful update in India time under the heading. Theme switching stays in the local preview. If a menu is unpublished, direct guests to ask the restaurant. If the request fails, let guests retry.
- In the admin catalog, show whether public publishing is off, waiting, or up to date. Keep the last successful publish time visible while changes wait. The staff connection indicator remains separate because local service can continue during an internet outage.

### Table QR cards

- Open the cards from the outlet overview. Let admins print all tables or a single replacement card. Use the current table label as the heading and keep the scan instruction short.
- Print a black code on white with an intact quiet zone. Use two columns on A4 and keep each card together. Hide the staff navigation and print controls on the sheet. Mark every sample card as local preview only, including on paper.
- A card points to the published outlet menu with a table-specific URL fragment. The menu stays read-only and guests ask their waiter to place an order. Let admins open the destination from the card screen before printing.

### Shareable menu images

- Export the whole catalog in category order, even when the admin has searched for a dish. Use a cream background, brick headings, and aligned INR prices from the Classic theme. Include each dish name and a written sold-out label where applicable.
- Use a 1080 × 1350 portrait layout with a user-entered title, an India-time snapshot stamp, and page numbering. Keep a dish together and repeat its category when it continues on a new page. Use text-led pages for social sharing and the guest site for detailed descriptions and photos.
- Show the page preview and an accessible text view before download. Let the admin save the current PNG or get the complete set in one ZIP. Generate the files on the outlet device using the existing catalog data.

### Dine-in coupons

- Show the code, fixed discount, minimum, expiry in India time, and active state on the owner screen. Keep coupon fields together and retain values if saving fails.
- Put coupon verification beside the counter’s receipt fields. Show the discount and the revised item subtotal together, then prompt the cashier to apply it in the billing software. Keep the final receipt amount in its own field. Show the code and amount beside the saved receipt.

### Guest phone sign-in

- Keep browsing available throughout sign-in. Use a small inline guest-account area with the same colors and type as the selected theme.
- Ask for the Indian mobile number first, then show one field for the six-digit code with support for SMS autofill. Show only the last four digits in the confirmation and signed-in state. Let guests correct the number, request a new code, or close the form.
- Place errors inside the account area, preserve the current step on a recoverable error, and give the guest a clear next action.

### Private feedback

- Show a paid receipt’s feedback code in readable groups of four. Print a separate slip with the guest-menu address, expiry, and sync status. Keep receipt and payment details off the slip.
- Put the feedback form in the signed-in guest area. Use explicit rating labels, an optional comment, and a private-submission confirmation. Keep the form available for correction if the code is unavailable.
- Give the owner a time-ordered inbox with rating, timestamp, and comment. Show a retry action if the hosted service is unreachable.

### Public offers and claims

- Use a short public title, the rupee discount, minimum spend, and expiry on guest-facing offers. Keep public offers beside the guest account area and allow browsing before sign-in.
- Keep claims in the guest's account. Label the waiting, ready, redeemed, and unavailable states in text. Show the counter code only when the restaurant has acknowledged that it saved the claim.
- Reuse the existing counter receipt coupon field for shared and claimed codes. Keep the revised item subtotal and the official billing amount separate.

## Do's and Don'ts

- Give each view one clear primary action. Use status words alongside color. Group related controls by proximity and keep decorative effects out of operational screens.
- Keep visual styling separate from business rules. Reuse the same price, availability, permissions, and submission logic at every viewport. Preserve local operation and bundle the staff interface without runtime calls to remote assets or design services.
- Before adding a color or component, look for an existing semantic role. If a new role is necessary, update the token source and this specification together, then check all consuming surfaces.
- Before closing a UI change, check keyboard navigation, visible focus, status announcements, contrast, reduced motion, and reflow. Run automated accessibility and workflow tests. Record real-device checks separately in [VERIFICATION.md](VERIFICATION.md).

### Acceptance checks for the first dish-picker implementation

| Scenario | Expected result |
| --- | --- |
| Pick from a 250-item sample menu on a phone | An item in view adds with one tap. Search and categories remain usable at 320 px with long dish names and the phone keyboard open. Aim for visible results within 150 ms after typing on the agreed test device and record the measured result. |
| Take an order with a PC keyboard | Find Paneer Tikka by search, add two portions, add one Masala Chai, and add a note. Review the right-hand draft and send without a mouse. Focus remains visible. |
| Resize mid-order | The same table, draft, notes, quantities, and total survive the pane change. The phone review bar and PC order pane show the same values. |
| Item sells out or Wi-Fi drops mid-order | Status is explained in text, unaffected items and notes remain intact, and retrying an unresolved send produces one order. |
| Kitchen and billing receive the order | Both see the same table and quantities. The kitchen sees the correct notes, and the counter total agrees with the accepted order. |
| Real-device verification | Repeat on an Android or iPhone staff browser and a Windows counter browser, including keyboard or zoom where relevant. Supply sample accounts, exact steps, and expected results under the [physical handoff checklist](BUILD_PLAN.md#feature-testing-and-physical-handoff). |
