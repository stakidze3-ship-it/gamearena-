import { NextRequest, NextResponse } from "next/server";
import { DEMO_UNUSED_TX_KINDS, TxKind, listLedgerTransactions } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";
import { parseWalletQuery, paymentsEnabled } from "@/lib/admin-wallet-query";

/**
 * Admin-only: one page of the ledger, filtered.
 *
 * The read side of the wallet explorer. GET because it changes nothing — and
 * force-dynamic because a cached page of the ledger is actively harmful: an
 * operator checking whether a refund landed needs the answer as of now, and a
 * stale "no such transaction" would have them post the refund a second time.
 *
 * Cursor pagination rather than offset, all the way down. The ledger only
 * grows, and it grows fastest during the settlements an operator is most likely
 * to be watching, so an offset window would shift under them: page two would
 * repeat rows from page one and skip whatever slid between them.
 */
export const dynamic = "force-dynamic";

/**
 * Every kind the console offers, sent with the first page so the filter
 * dropdown is built from the enum rather than from a hand-maintained copy of it
 * that goes stale the next time a TxKind is added.
 */
const ALL_KINDS = Object.values(TxKind);

export async function GET(req: NextRequest) {
  await requireAdmin();

  const parsed = await parseWalletQuery(req.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { filters, resolvedUser } = parsed.value;

  try {
    const page = await listLedgerTransactions(filters);

    // The honest explanation for an empty payments view.
    //
    // DEPOSIT and WITHDRAWAL are in the enum because the platform was built for
    // real money, but this deployment runs on demo credits: PAYMENTS_ENABLED is
    // false and nothing in the codebase posts either kind. Filtering to them
    // therefore returns nothing — which looks exactly like a broken deposits
    // view, and an operator who reads it that way escalates an outage that does
    // not exist. So the API says which it is, rather than leaving an empty list
    // to speak for itself.
    const filteredKinds = filters.kinds ?? [];
    const onlyDemoUnusedKinds =
      filteredKinds.length > 0 && filteredKinds.every((kind) => DEMO_UNUSED_TX_KINDS.includes(kind));

    const notice =
      onlyDemoUnusedKinds && !paymentsEnabled()
        ? "This deployment is demo-credit only (PAYMENTS_ENABLED is false), so no deposit or " +
          "withdrawal has ever been posted. An empty list here is correct — not a fault."
        : null;

    return NextResponse.json({
      ok: true,
      transactions: page.transactions,
      nextCursor: page.nextCursor,
      kinds: ALL_KINDS,
      // Named separately from `kinds` so the console can grey the two out rather
      // than hiding them — an operator who cannot find "Deposit" in the list
      // will assume the filter is broken, which is the confusion this avoids.
      demoUnusedKinds: DEMO_UNUSED_TX_KINDS,
      paymentsEnabled: paymentsEnabled(),
      resolvedUser,
      notice,
      message:
        page.transactions.length === 0
          ? (notice ?? "No transactions match these filters.")
          : undefined,
    });
  } catch (err) {
    return adminOpsErrorResponse(err, { fallback: "Could not read the ledger" });
  }
}
