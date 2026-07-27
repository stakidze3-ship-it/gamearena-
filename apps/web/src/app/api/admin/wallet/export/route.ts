import { NextRequest, NextResponse } from "next/server";
import { iterateLedgerTransactions, type LedgerTransactionView } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";
import { parseWalletQuery } from "@/lib/admin-wallet-query";

/**
 * Admin-only: the filtered ledger as a CSV download.
 *
 * Takes exactly the same query string as /api/admin/wallet/transactions and
 * parses it with the same function, so "export what I am looking at" is true
 * rather than approximately true. That guarantee is the whole reason the filter
 * parsing lives in a shared lib instead of being written twice.
 *
 * STREAMED, not assembled. A month of a busy ledger is hundreds of thousands of
 * rows, and building that as one string before sending it is how an export
 * takes the process down — the memory spike lands on a serverless function with
 * a hard limit, the request dies, and the operator gets a truncated file with
 * no error. Instead the rows are pulled a page at a time and each chunk is
 * written out and forgotten, so peak memory is one page regardless of the size
 * of the export.
 *
 * ONE ROW PER LEDGER ENTRY, not per transaction. A double-entry export whose
 * rows do not sum to zero is not a ledger export, it is a summary — and a
 * summary is the thing an operator reaching for a CSV is specifically trying to
 * get away from. Both legs are here, sharing a transaction_id, so the file can
 * be pivoted, reconciled, and checked for balance in a spreadsheet.
 */
export const dynamic = "force-dynamic";

/**
 * Runaway guard, not a product limit.
 *
 * An unbounded export is one mistyped date range away from streaming the entire
 * ledger until the platform kills the request mid-file. When the ceiling is
 * reached the file ends with a comment line rather than simply stopping —
 * see TRUNCATION_NOTICE.
 */
const MAX_EXPORT_TRANSACTIONS = 100_000;

/**
 * The last line of a truncated file.
 *
 * A deliberate compromise, and worth naming as one. A `#` line is not a valid
 * CSV record, so a strict parser may reject it and a spreadsheet will render it
 * as one stray cell of text. Both of those are LOUD, which is the point: the
 * alternative — ending the file silently at the ceiling — hands the operator a
 * short extract that looks complete, and a reconciliation done against it would
 * be wrong with no indication of why.
 */
const TRUNCATION_NOTICE = (max: number) =>
  `# TRUNCATED at ${max.toLocaleString("en-US")} transactions — this file is INCOMPLETE. ` +
  `Narrow the date range and export again.\r\n`;

/** Columns, in order. The transaction columns repeat on each of its entry rows. */
const COLUMNS = [
  "transaction_id",
  "posted_at_utc",
  "kind",
  "memo",
  "ref_type",
  "ref_id",
  "idempotency_key",
  "transaction_total_tetri",
  "transaction_total_gel",
  "balanced",
  "direction",
  "account_label",
  "account_key",
  "account_type",
  "user_id",
  "username",
  "entry_amount_tetri",
  "entry_amount_gel",
] as const;

/**
 * Money as a decimal string, by integer arithmetic only.
 *
 * `tetri / 100` is a float, and floats are banned in this codebase for exactly
 * the reason that matters here: an export is what somebody reconciles against,
 * and a column that reads 8.749999999999998 destroys trust in the whole file.
 * The integer part and the remainder are formatted separately so the value is
 * always exact.
 */
function gel(tetri: number): string {
  const sign = tetri < 0 ? "-" : "";
  const abs = Math.abs(tetri);
  return `${sign}${Math.floor(abs / 100)}.${(abs % 100).toString().padStart(2, "0")}`;
}

/**
 * CSV quoting, applied to every cell.
 *
 * Memos are free text written by whatever posted the transaction and can
 * contain commas, quotes and newlines. Unquoted, a single memo with a comma
 * shifts every later column on that row — the amount lands in the username
 * column — and the file still opens cleanly, so nobody notices.
 */
function quote(raw: string): string {
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

/**
 * A text cell: quoted, and defused against spreadsheet formula injection.
 *
 * Excel and Sheets execute a cell that begins with =, +, - or @. Memos and
 * usernames are attacker-influenced — a player picks their own name — so a
 * username of `=HYPERLINK(...)` would run the moment an operator opened the
 * export. A leading apostrophe forces the cell to be read as text. It is
 * visible in the raw file, which is the right trade: a stray apostrophe beats a
 * live formula.
 */
function text(value: string | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  return quote(/^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw);
}

/**
 * A numeric cell: quoted if it somehow needs it, and NEVER formula-guarded.
 *
 * Separate from `text` because applying the guard here silently destroys the
 * export. Every debit is negative, so a shared guard prefixes `-500` with an
 * apostrophe, Excel reads the whole amount column as text, and SUM() over it
 * returns zero. An export nobody can add up is worthless for the one job it
 * exists to do — and it looks completely fine until somebody tries to
 * reconcile with it.
 *
 * There is no injection risk to trade away: these values are produced here from
 * integers in the ledger, never from anything a player can type.
 */
function num(value: number | string): string {
  return quote(String(value));
}

/** Every entry of one transaction, as CSV lines sharing the transaction columns. */
function rowsFor(tx: LedgerTransactionView): string {
  return tx.sides
    .map((side) =>
      [
        text(tx.id),
        // ISO 8601 in UTC throughout, matching the date filter's own timezone.
        // A localised timestamp in an export is unusable: whoever opens the file
        // has no way to know which machine's clock it was written against.
        text(tx.createdAt.toISOString()),
        text(tx.kind),
        text(tx.memo),
        text(tx.refType),
        text(tx.refId),
        text(tx.idempotencyKey),
        num(tx.amountTetri),
        num(gel(tx.amountTetri)),
        text(tx.balanced),
        // Named rather than inferred from the sign, so a reader who does not
        // know double-entry can still follow which way the money went.
        text(side.amountTetri >= 0 ? "credit" : "debit"),
        text(side.label),
        text(side.accountKey),
        text(side.accountType),
        text(side.userId),
        text(side.username),
        num(side.amountTetri),
        num(gel(side.amountTetri)),
      ].join(",")
    )
    .join("\r\n")
    .concat("\r\n");
}

/** Filename-safe fragment: lowercase, ASCII, no quotes to break the header. */
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export async function GET(req: NextRequest) {
  // FIRST, and outside every try below. requireAdmin signals "not an admin" by
  // throwing a redirect, and catching that would turn a working auth failure
  // into a 500 that hides it.
  await requireAdmin();

  const parsed = await parseWalletQuery(req.nextUrl.searchParams);
  if (!parsed.ok) {
    // A JSON error for a request that asked for a CSV, deliberately: the browser
    // is being navigated to this URL by a download link, and handing it a file
    // named .csv containing an error message would leave a bad export sitting in
    // the operator's downloads folder looking like data.
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { filters, resolvedUser } = parsed.value;

  const pages = iterateLedgerTransactions(
    // The export walks the whole filtered set from the newest row, so the page
    // size and cursor the console sent for its on-screen view are dropped here.
    { ...filters, limit: undefined, cursor: null },
    { maxTransactions: MAX_EXPORT_TRANSACTIONS }
  );

  const encoder = new TextEncoder();
  let wroteHeader = false;

  const body = new ReadableStream<Uint8Array>({
    /**
     * Pulled one chunk at a time so the stream applies backpressure. Doing this
     * work in `start()` instead would run the entire loop up front and queue
     * every chunk in memory, which is the exact failure this route is built to
     * avoid.
     */
    async pull(controller) {
      if (!wroteHeader) {
        wroteHeader = true;
        // The BOM is for Excel, which otherwise decodes a UTF-8 CSV as the
        // system codepage and mangles every non-ASCII username in the file.
        // Written as an escape rather than a literal so it stays visible to
        // anyone reading this file — an invisible byte-order mark in source is
        // the kind of thing that gets "tidied" away by accident.
        controller.enqueue(encoder.encode(`\uFEFF${COLUMNS.join(",")}\r\n`));
        return;
      }

      try {
        const next = await pages.next();
        if (next.done) {
          controller.close();
          return;
        }

        const { transactions, didTruncate } = next.value;
        if (transactions.length > 0) {
          controller.enqueue(encoder.encode(transactions.map(rowsFor).join("")));
        }
        if (didTruncate) {
          controller.enqueue(encoder.encode(TRUNCATION_NOTICE(MAX_EXPORT_TRANSACTIONS)));
          // The generator is still suspended at its yield and will never be
          // pulled again, so it is closed explicitly rather than left for the
          // collector to notice.
          await pages.return?.(undefined);
          controller.close();
        }
      } catch (err) {
        // The response status was sent long ago, so this cannot become a 500 —
        // the download simply aborts, which the browser reports as a failed
        // file. Erroring the stream is what makes it abort rather than finish
        // with a plausible-looking partial file the operator would trust.
        console.error("[admin] ledger export failed mid-stream:", err);
        controller.error(err);
      }
    },
    cancel() {
      // The operator navigated away or cancelled the download. Closing the
      // generator lets its in-flight page settle and stops further queries for
      // a file nobody is going to read.
      void pages.return?.(undefined);
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const scope = resolvedUser ? `-${slug(resolvedUser.username)}` : "";
  const filename = `gamearena-ledger${scope}-${stamp}.csv`;

  return new NextResponse(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      // attachment, so a click downloads the file instead of rendering it in a
      // tab. The filename is slugged to ASCII above, so plain quoting is safe.
      "content-disposition": `attachment; filename="${filename}"`,
      // No length is known until the last row is read, and guessing one would
      // truncate the download at the guess.
      "cache-control": "no-store",
    },
  });
}
