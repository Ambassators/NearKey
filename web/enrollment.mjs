import qrcode from './qrcode-generator.mjs';

// Enrollment links contain only the server origin and its temporary pairing code.
export function enrollmentUrl(origin, pairingCode) {
  return `nearkey://enroll?v=1&origin=${encodeURIComponent(origin)}&code=${encodeURIComponent(pairingCode)}`;
}

export function enrollmentSvg(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url, 'Byte');
  qr.make();
  return qr.createSvgTag({cellSize: 4, margin: 16, scalable: true,
    title: {id: 'enrollment-qr-title', text: 'Scan to enroll your phone with Nearkey'}});
}

// Synchronous local encoding avoids a late image response restoring an old secret.
export class EnrollmentQr {
  constructor({container, message, codeInput, originInput, manual, encode = enrollmentSvg}) {
    Object.assign(this, {container, message, codeInput, originInput, manual, encode});
    this.url = null;
  }

  clear() {
    this.url = null;
    this.container.replaceChildren();
    this.container.hidden = true;
    this.message.textContent = '';
    this.codeInput.value = '';
    this.originInput.value = '';
    this.manual.open = false;
  }

  render(pairing, origin, now = Date.now()) {
    if (!pairing) return this.clear();
    if (!pairing.pageScoped && (!Number.isFinite(pairing.expiresAt) || pairing.expiresAt <= now)) {
      this.clear();
      this.message.textContent = 'This code expired. Get a fresh enrollment code.';
      return;
    }
    const url = enrollmentUrl(origin, pairing.pairingCode);
    if (url === this.url) return;
    this.clear();
    this.url = url;
    this.codeInput.value = pairing.pairingCode;
    this.originInput.value = origin;
    try {
      this.container.innerHTML = this.encode(url);
      this.container.hidden = false;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(new URL(origin).hostname)) {
        this.message.textContent = 'Connect your phone to the same Wi-Fi network as this computer, then scan this QR code and tap Connect website.';
      }
    } catch {
      this.container.replaceChildren();
      this.manual.open = true;
      this.message.textContent = 'The QR code could not be displayed. Enter the details below in your Android app.';
    }
  }
}
