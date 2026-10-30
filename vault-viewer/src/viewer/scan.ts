// Reads the key from a QR code with the device camera (the key card has one), so a phone does not
// need the text typed or pasted. Decoding runs in the page with jsQR; nothing is uploaded.

import jsQR from 'jsqr';
import { h } from '../shared/dom';
import { textToKey } from '../core/keytext';

export class ScanError extends Error {}

/** Resolves with the key text of the first valid key QR, or null if the person closes the scanner. */
export async function scanKeyQr(): Promise<string | null> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new ScanError('這個瀏覽器或連線方式不能使用相機。請改用 https 網址開啟，或直接貼上金鑰文字。');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
  } catch (e) {
    const name = (e as DOMException).name;
    throw new ScanError(
      name === 'NotAllowedError' || name === 'SecurityError'
        ? '沒有取得相機權限。請在瀏覽器網址列允許使用相機後再試一次。'
        : name === 'NotFoundError'
          ? '找不到相機。'
          : '無法開啟相機。',
    );
  }

  return new Promise<string | null>((resolve) => {
    const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
    const hint = h('p', { class: 'scan-hint' }, '把金鑰卡上的 QR Code 對準畫面');
    const finish = (result: string | null) => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const cancel = h('button', { type: 'button', class: 'btn', onclick: () => finish(null) }, '取消');
    const overlay = h('div', { class: 'scan-overlay', role: 'dialog', 'aria-label': '掃描金鑰 QR Code' }, video, h('div', { class: 'scan-frame' }), hint, cancel);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish(null);
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    video.srcObject = stream;
    void video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    let notKey = 0;
    const timer = setInterval(() => {
      if (video.readyState < 2 || !video.videoWidth) return;
      const scale = Math.min(1, 800 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = g.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (!code) return;
      if (textToKey(code.data).ok) finish(code.data);
      else if (++notKey === 3) hint.textContent = '這個 QR Code 不是金鑰，請掃金鑰卡上的那一個';
    }, 150);
  });
}
