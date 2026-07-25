// Tournament settlement lives in the shared db package (used by the web app and
// the realtime scheduler). Re-exported here so existing `@/lib/tournaments`
// imports keep working.
export { finalizeTournament, tournamentEndsAt } from "@gamearena/db";
