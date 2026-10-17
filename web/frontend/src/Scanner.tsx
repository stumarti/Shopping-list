import { useEffect, useRef, useState, type FormEvent } from "react";
import { isBarcode } from "./api";
import Icon from "./Icon";

// The browser's own barcode reader (Chrome on Android, some others); ZXing stands in where there isn't one.
type Detected = { rawValue: string };
type Detector = { detect: (source: CanvasImageSource | ImageBitmap) => Promise<Detected[]> };
declare global {
  interface Window {
    BarcodeDetector?: new (options: { formats: string[] }) => Detector;
  }
}
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];

function nativeDetector(): Detector | null {
  try {
    return window.BarcodeDetector ? new window.BarcodeDetector({ formats: FORMATS }) : null;
  } catch {
    return null;
  }
}

/** ZXing, loaded only when it's needed (it's big). Reads product barcodes only. */
async function zxingReader() {
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E]]]);
  return new BrowserMultiFormatReader(hints);
}

/** Read a barcode from a photo. */
async function fromPhoto(file: File): Promise<string | null> {
  const native = nativeDetector();
  if (native) {
    try {
      const found = await native.detect(await createImageBitmap(file));
      if (found[0]) return found[0].rawValue;
    } catch {
      // Fall through to ZXing.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return (await (await zxingReader()).decodeFromImageUrl(url)).getText();
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Scan a product barcode with the phone's camera. Live scanning needs the page on https (or localhost); on plain
 * http it offers a photo instead, which works everywhere. You can also type the number.
 */
export default function Scanner({ title, onCode, onClose }: { title: string; onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const photo = useRef<HTMLInputElement>(null);
  const live = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
  const [status, setStatus] = useState(live ? "Starting the camera…" : "");
  const [typed, setTyped] = useState("");
  const done = useRef(false);

  const found = (code: string) => {
    if (done.current || !isBarcode(code)) return;
    done.current = true;
    navigator.vibrate?.(60);
    onCode(code);
  };

  // Live camera: read frames until a barcode turns up.
  useEffect(() => {
    if (!live) return;
    let stream: MediaStream | null = null;
    let stopZxing: (() => void) | null = null;
    let timer = 0;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (cancelled || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        setStatus("Point the camera at the barcode.");
        const native = nativeDetector();
        if (native) {
          const look = async () => {
            if (cancelled || done.current || !video.current) return;
            try {
              const codes = await native.detect(video.current);
              if (codes[0]) return found(codes[0].rawValue);
            } catch {
              // A frame that couldn't be read; try the next.
            }
            timer = window.setTimeout(look, 150);
          };
          void look();
        } else {
          const reader = await zxingReader();
          if (cancelled || !video.current) return;
          const controls = await reader.decodeFromVideoElement(video.current, (result) => result && found(result.getText()));
          stopZxing = () => controls.stop();
        }
      } catch (e) {
        const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
        setStatus(denied ? "The camera wasn't allowed. Take a photo instead, or type the number." : "Couldn't start the camera. Take a photo instead, or type the number.");
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stopZxing?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Close with Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    setStatus("Reading the photo…");
    const code = await fromPhoto(file);
    if (code && isBarcode(code)) found(code);
    else setStatus("Couldn't read a barcode in that photo. Try again closer, with the barcode flat and in focus.");
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (isBarcode(typed)) found(typed.trim());
    else setStatus("A barcode is 8 to 14 digits.");
  };

  return (
    <div className="scanner-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="scanner" role="dialog" aria-modal="true" aria-label={title}>
        <div className="section-head">
          <h2>{title}</h2>
          <button className="remove" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        {live && (
          <div className="viewfinder">
            <video ref={video} playsInline muted />
            <span className="aim" aria-hidden="true" />
          </div>
        )}
        {status && (
          <p className="muted scan-status" role="status">
            {status}
          </p>
        )}
        {!live && (
          <p className="muted scan-status">
            Live scanning needs this page on https. Take a photo of the barcode instead: it works the same.
          </p>
        )}

        <div className="scan-actions">
          <button className={live ? "link" : "primary"} onClick={() => photo.current?.click()}>
            <Icon name="camera" size={20} /> Take a photo
          </button>
          <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />
        </div>

        <form className="add-form scan-type" onSubmit={submit}>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            maxLength={14}
            placeholder="Or type the barcode number"
            aria-label="Barcode number"
          />
          <button type="submit" className="primary" disabled={!typed}>
            Use
          </button>
        </form>
      </div>
    </div>
  );
}
