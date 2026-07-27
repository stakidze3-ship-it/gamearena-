import { redirect } from "next/navigation";

/**
 * The testing page moved into the admin console.
 *
 * Kept as a redirect rather than deleted: the old path was handed out in
 * instructions and may be bookmarked, and a 404 for an operator looking for
 * tournament tools during an incident is a worse outcome than one hop.
 */
export default function TestingMoved() {
  redirect("/admin");
}
