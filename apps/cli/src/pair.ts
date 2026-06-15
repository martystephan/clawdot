/**
 * `clawdot pair` — asks the locally running daemon to open a pairing window
 * and renders the result: a QR code (scan with the phone camera; it opens the
 * hosted web app with the ticket in the URL fragment) plus the raw ticket for
 * manual entry. Pairing tickets can only be minted over the local socket.
 */
import * as p from "@clack/prompts";
import qrcode from "qrcode-terminal";
import { DaemonClient } from "./daemon-client.js";

export async function runPair(port: number): Promise<void> {
  p.intro("clawdot pair");
  const s = p.spinner();
  s.start("Asking the daemon for a pairing ticket");

  let ticket;
  try {
    const client = await DaemonClient.connect(port);
    ticket = await client.request({ type: "pair.start" }, "pair.ticket");
    client.close();
  } catch (err) {
    s.error("No ticket");
    p.cancel(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (ticket.expiresAt === null) {
    s.stop("Pairing window open — never expires, pairs unlimited devices");
  } else {
    const minutes = Math.round((ticket.expiresAt - Date.now()) / 60_000);
    s.stop(`Pairing window open — ${minutes} minutes, pairs one device`);
  }

  console.log("\n  Scan with your phone camera:\n");
  qrcode.generate(ticket.url, { small: true });
  p.log.info(`Or open:  ${ticket.url}`);
  p.note(ticket.ticket, "Manual pairing code (paste into the app)");
  p.outro(`Relay: ${ticket.relayUrl}`);
}
