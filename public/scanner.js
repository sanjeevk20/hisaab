// Camera barcode scanner. Uses the browser's native BarcodeDetector (Chrome/Android)
// and falls back to ZXing (iOS Safari, Firefox), loaded on first use.
const ZXING_URL = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];
const REPEAT_MS = 1500; // ignore the same code seen again within this window

let zxingLoading;
function loadZxing() {
  zxingLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = ZXING_URL;
    s.onload = () => resolve(window.ZXing);
    s.onerror = () => reject(new Error('Could not load the barcode library. Check your internet connection.'));
    document.head.append(s);
  });
  return zxingLoading;
}

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  const supported = await window.BarcodeDetector.getSupportedFormats();
  const formats = FORMATS.filter((f) => supported.includes(f));
  return formats.length ? new window.BarcodeDetector({ formats }) : null;
}

export class Scanner {
  constructor(video, onCode) {
    this.video = video;
    this.onCode = onCode;
    this.running = false;
    this.last = { code: null, at: 0 };
  }

  #emit(code) {
    const now = Date.now();
    if (code === this.last.code && now - this.last.at < REPEAT_MS) return;
    this.last = { code, at: now };
    this.onCode(code);
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera needs a secure (https) connection. Type the barcode instead.');
    }
    this.running = true;
    try {
      const detector = await nativeDetector();
      if (detector) await this.#startNative(detector);
      else await this.#startZxing();
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  async #startNative(detector) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    const tick = async () => {
      if (!this.running) return;
      try {
        if (this.video.readyState >= 2) {
          const [hit] = await detector.detect(this.video);
          if (hit?.rawValue) this.#emit(hit.rawValue);
        }
      } catch { /* a dropped frame is fine */ }
      this.timer = setTimeout(tick, 150);
    };
    tick();
  }

  async #startZxing() {
    const ZXing = await loadZxing();
    const hints = new Map([[ZXing.DecodeHintType.TRY_HARDER, true]]);
    this.reader = new ZXing.BrowserMultiFormatReader(hints, 200);
    await this.reader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      this.video,
      (result) => { if (result) this.#emit(result.getText()); }
    );
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.reader?.reset();
    this.reader = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

// Short confirmation beep + buzz so the shopkeeper knows a scan registered.
let audio;
export function feedback() {
  navigator.vibrate?.(60);
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 1200;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.08);
  } catch { /* sound is optional */ }
}
