// QR генерируется локально библиотекой qrcode-generator (K. Arase, MIT), взятой из пакета qrcode-terminal.
import QRCode from "./qrlib/index.js";
import ECL from "./qrlib/QRErrorCorrectLevel.js";

/** Текст для кодирования: ASCII-ссылка кодируется как есть, иначе — в нормализованном виде. */
export function qrText(url) {
  if (!/[^\x00-\x7f]/.test(url)) return url;
  try { return new URL(url).href; } catch (e) { return url; }
}

/** Возвращает {size, d}: один SVG-путь из тёмных модулей с полем 4 модуля вокруг. */
export function qrModel(url) {
  const q = new QRCode(-1, ECL.M);
  q.addData(qrText(url));
  q.make();
  const n = q.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!q.isDark(r, c)) { c++; continue; }
      let len = 0;
      while (c + len < n && q.isDark(r, c + len)) len++;
      d += `M${c + 4} ${r + 4}h${len}v1h-${len}z`;
      c += len;
    }
  }
  return { size: n + 8, d };
}
