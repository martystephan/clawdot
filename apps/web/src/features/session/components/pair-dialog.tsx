import { Link2, ScanLine } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, DialogFooter, DialogHeader, TextInput } from "@/components/ui";
import { QrScanner } from "@/features/session/components/qr-scanner";
import type { RemoteInfo } from "@/features/session/hooks/use-daemon";

/** A scanned QR holds the full pairing URL (…/#pair=<ticket>) — pull the
 * ticket out of it; a bare ticket (pasted or scanned) passes through. */
function extractPairCode(text: string): string {
  const match = text.match(/#pair=(.+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : text.trim();
}

/**
 * Remote access management: scan the QR from `clawdot pair` with the in-app
 * camera (the only QR path inside the Tauri shell, where deep links can't
 * open the app), paste the code by hand, or review/revoke an existing
 * pairing. Outside the shell, scanning the QR with the system camera also
 * works — it opens the app with the ticket in the URL fragment.
 */
export function PairDialog({
  open,
  remote,
  pairingError,
  connected,
  onPair,
  onUnpair,
  onClose,
}: {
  open: boolean;
  remote: RemoteInfo | null;
  pairingError: string | null;
  connected: boolean;
  onPair: (code: string) => void;
  onUnpair: () => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);

  const submit = () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    onPair(extractPairCode(trimmed));
    setCode("");
  };

  const close = () => {
    setScanning(false);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close}>
      <DialogHeader icon={Link2}>Remote access</DialogHeader>

      <div className="flex flex-col gap-2.5 px-3.5 py-3 text-[12.5px] text-fg-mid">
        {remote ? (
          <>
            <p>
              This device is paired. Traffic is end-to-end encrypted; the relay
              only forwards ciphertext.
            </p>
            <p className="font-mono text-[11.5px] text-fg-faint">
              relay: {remote.relayUrl} — {connected ? "connected" : "not connected"}
            </p>
          </>
        ) : (
          <>
            <p>
              Run <span className="font-mono">clawdot pair</span> on the machine
              where the daemon runs, then scan the QR code — or paste the
              pairing code below.
            </p>
            {scanning ? (
              <QrScanner
                onScan={(text) => {
                  setScanning(false);
                  onPair(extractPairCode(text));
                }}
              />
            ) : (
              <Button className="justify-center" onClick={() => setScanning(true)}>
                <ScanLine size={13} />
                Scan QR code
              </Button>
            )}
            <TextInput
              placeholder="pairing code"
              value={code}
              spellCheck={false}
              onValueChange={setCode}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </>
        )}
        {pairingError && <p className="text-[11.5px] text-del">{pairingError}</p>}
      </div>

      <DialogFooter>
        {remote ? (
          <>
            <Button onClick={onUnpair}>Unpair this device</Button>
            <span className="flex-1" />
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        ) : (
          <>
            <span className="flex-1" />
            <Button variant="primary" disabled={!code.trim()} onClick={submit}>
              Pair
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
