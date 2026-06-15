import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

/**
 * Live camera view that decodes the first QR code it sees. Used for in-app
 * pairing — inside the Tauri shell a scanned QR can't deep-link into the app,
 * so the app scans it itself.
 */
export function QrScanner({ onScan }: { onScan: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  // The decode loop fires onScan once, even if frames keep coming.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera access is not available here.");
      return;
    }

    let disposed = false;
    let stream: MediaStream | null = null;
    let frame = 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      if (disposed) return;
      if (ctx && video.readyState >= video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, {
          inversionAttempts: "dontInvert",
        });
        if (code && code.data) {
          disposed = true;
          onScanRef.current(code.data);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        if (disposed) {
          for (const track of s.getTracks()) track.stop();
          return;
        }
        stream = s;
        video.srcObject = s;
        // iOS refuses to autoplay camera video without playsinline.
        video.setAttribute("playsinline", "true");
        void video.play();
        frame = requestAnimationFrame(tick);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Camera permission was denied."
            : "Could not open the camera.",
        );
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      if (stream) for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    };
  }, []);

  if (error) {
    return <p className="text-[11.5px] text-del">{error}</p>;
  }

  return (
    <video
      ref={videoRef}
      muted
      className="aspect-square w-full rounded-sm bg-black object-cover"
    />
  );
}
