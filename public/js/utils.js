// ============================================================
// 工具库：本地API封装 / 图片处理 / 水印 / ZIP打包 / 并发队列
// ============================================================

function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadLS(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function saveLS(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

// ---------- 本地服务器 API ----------
async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error || `本地服务错误 HTTP ${r.status}`);
  return data;
}

// 通过本地代理请求外部平台。返回 {status, bodyType, body|base64, contentType}
async function proxyFetch(spec) {
  return api('/api/proxy', spec);
}

// 便捷：JSON API 调用，非 2xx 时抛出带平台返回信息的错误
async function proxyJson(spec) {
  const r = await proxyFetch(spec);
  const bodyText = r.bodyType === 'json' ? JSON.stringify(r.body) : String(r.body || '').slice(0, 500);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`平台返回 HTTP ${r.status}: ${bodyText.slice(0, 600)}`);
  }
  if (r.bodyType !== 'json') throw new Error('平台返回了非JSON响应: ' + bodyText.slice(0, 300));
  return r.body;
}

async function saveDataUrl(dataUrl, dir, filename) {
  return api('/api/save-file', { dataUrl, dir, filename });
}
async function saveBase64(base64, mime, dir, filename) {
  return api('/api/save-file', { base64, mime, dir, filename });
}
async function downloadRemote(url, dir, filename, headers) {
  return api('/api/download', { url, dir, filename, headers });
}

// ---------- 文件与图片 ----------
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

// 压缩/缩放图片，避免超过平台参考图大小限制
// 非 jpeg/png 一律重编码：可灵/OpenAI 等平台不接受 webp/gif/bmp 参考图
async function resizeImageDataUrl(dataUrl, maxDim = 2048, mime = 'image/jpeg', quality = 0.92) {
  const img = await loadImage(dataUrl);
  let { width: w, height: h } = img;
  const srcMime = dataUrlMime(dataUrl);
  if ((srcMime === 'image/jpeg' || srcMime === 'image/png') && w <= maxDim && h <= maxDim && dataUrl.length < 6 * 1024 * 1024) return dataUrl;
  const scale = Math.min(maxDim / w, maxDim / h, 1);
  w = Math.round(w * scale);
  h = Math.round(h * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  return cv.toDataURL(mime, quality);
}

// 居中裁剪到精确尺寸（cover），Sora 等要求首帧图与视频分辨率完全一致
async function cropDataUrlToSize(dataUrl, w, h, mime = 'image/jpeg', quality = 0.92) {
  const img = await loadImage(dataUrl);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return cv.toDataURL(mime, quality);
}

function dataUrlToBase64(dataUrl) {
  const i = dataUrl.indexOf(',');
  return dataUrl.slice(i + 1);
}
function dataUrlMime(dataUrl) {
  const m = /^data:([^;,]+)/.exec(dataUrl);
  return m ? m[1] : 'application/octet-stream';
}

// 把本地 /output 路径转成 dataURL（用于把已落盘图片再送给平台）
async function outputPathToDataUrl(path) {
  const r = await fetch(path);
  const blob = await r.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

async function downloadPath(path, name) {
  const r = await fetch(path);
  downloadBlob(await r.blob(), name);
}

// ---------- 水印合成 ----------
// opts: {logoDataUrl, brandText, xhsId, label}  在图片上叠加品牌与小红书号
async function applyWatermark(srcUrl, opts = {}) {
  const img = await loadImage(srcUrl);
  const w = img.naturalWidth, h = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const pad = Math.round(w * 0.035);
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = Math.max(4, w * 0.006);

  // 左上：logo 或品牌名
  if (opts.logoDataUrl) {
    try {
      const logo = await loadImage(opts.logoDataUrl);
      const lh = Math.round(h * 0.045);
      const lw = Math.round((logo.naturalWidth / logo.naturalHeight) * lh);
      ctx.drawImage(logo, pad, pad, lw, lh);
    } catch {}
  } else if (opts.brandText) {
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = `600 ${Math.round(h * 0.03)}px "PingFang SC", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(opts.brandText, pad, pad);
  }

  // 右下：小红书号
  if (opts.xhsId) {
    const fs = Math.round(h * 0.022);
    ctx.font = `500 ${fs}px "PingFang SC", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';
    ctx.fillText(`小红书号：${opts.xhsId}`, w - pad, h - pad);
    ctx.textAlign = 'left';
  }

  // 左下：花色编号标签
  if (opts.label) {
    const fs = Math.round(h * 0.02);
    ctx.font = `500 ${fs}px "PingFang SC", sans-serif`;
    const tw = ctx.measureText(opts.label).width;
    const bx = pad, by = h - pad - fs * 2.1;
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(20,18,16,0.55)';
    roundRect(ctx, bx, by, tw + fs * 1.6, fs * 2.1, fs * 0.5);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.label, bx + fs * 0.8, by + fs * 1.05);
  }

  return cv.toDataURL('image/jpeg', 0.93);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- 成片素材绘制 ----------
// 标题卡：背景图暗化 + 大标题 + 副标题 + 花色行（对齐验收视频风格）
async function drawTitleCard({ width = 1080, height = 1920, bgUrl, title, subtitle, lines = [], brandText }) {
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#161311';
  ctx.fillRect(0, 0, width, height);
  if (bgUrl) {
    try {
      const img = await loadImage(bgUrl);
      const s = Math.max(width / img.naturalWidth, height / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
      ctx.fillStyle = 'rgba(12,10,9,0.52)';
      ctx.fillRect(0, 0, width, height);
    } catch {}
  }
  const px = width * 0.09;
  let y = height * 0.3;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  const tfs = Math.round(width * 0.085);
  ctx.font = `700 ${tfs}px "PingFang SC", sans-serif`;
  for (const ln of String(title || '').split('\n')) {
    ctx.fillText(ln, px, y);
    y += tfs * 1.32;
  }
  if (subtitle) {
    y += tfs * 0.25;
    ctx.font = `400 ${Math.round(width * 0.026)}px "Helvetica Neue", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(String(subtitle).toUpperCase().split('').join(' '), px + 4, y);
  }
  if (lines.length) {
    let ly = height * 0.62;
    const lfs = Math.round(width * 0.042);
    ctx.font = `600 ${lfs}px "PingFang SC", sans-serif`;
    ctx.fillStyle = '#fff';
    for (const ln of lines) {
      ctx.fillText(ln, px, ly);
      ly += lfs * 1.5;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(px, height * 0.62 - lfs * 0.9, width * 0.82, 3);
  }
  if (brandText) {
    ctx.font = `500 ${Math.round(width * 0.03)}px "PingFang SC", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(brandText, px, height * 0.9);
  }
  return cv.toDataURL('image/png');
}

// 片段标注层：透明PNG，左上小标题 + 中部引线标注（花色编号）
function drawLabelOverlay({ width = 1080, height = 1920, heading, label }) {
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  const ctx = cv.getContext('2d');
  const px = width * 0.08;
  if (heading) {
    const fs = Math.round(width * 0.045);
    ctx.font = `600 ${fs}px "PingFang SC", sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'top';
    ctx.fillText(heading, px, height * 0.09);
  }
  if (label) {
    const fs = Math.round(width * 0.032);
    const y = height * 0.66;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(px + 4, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(px + 12, y - 1, width * 0.06, 2);
    ctx.font = `500 ${fs}px "PingFang SC", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, px + 12 + width * 0.06 + 10, y);
  }
  return cv.toDataURL('image/png');
}

// ---------- ZIP 打包（store模式，无压缩，纯前端） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
// files: [{name: string, data: Uint8Array}]
function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();
  for (const f of files) {
    const nameBuf = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 文件名
    lh.setUint16(8, 0, true); // store
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, nameBuf.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), nameBuf, f.data);
    central.push({ nameBuf, crc, size: f.data.length, offset });
    offset += 30 + nameBuf.length + f.data.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, c.crc, true);
    ch.setUint32(20, c.size, true);
    ch.setUint32(24, c.size, true);
    ch.setUint16(28, c.nameBuf.length, true);
    ch.setUint32(42, c.offset, true);
    chunks.push(new Uint8Array(ch.buffer), c.nameBuf);
    offset += 46 + c.nameBuf.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, offset - cdStart, true);
  end.setUint32(16, cdStart, true);
  chunks.push(new Uint8Array(end.buffer));
  return new Blob(chunks, { type: 'application/zip' });
}

async function dataUrlToUint8(dataUrl) {
  const r = await fetch(dataUrl);
  return new Uint8Array(await r.arrayBuffer());
}

// ---------- 并发任务池 ----------
async function runPool(items, worker, concurrency = 2, onEach) {
  const queue = [...items.entries()];
  const results = new Array(items.length);
  async function lane() {
    while (queue.length) {
      const [i, item] = queue.shift();
      try {
        results[i] = { ok: true, value: await worker(item, i) };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
      if (onEach) onEach(results[i], item, i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
  return results;
}

// ---------- 可灵 JWT（浏览器端 HS256） ----------
async function klingJwt(accessKey, secretKey) {
  const enc = new TextEncoder();
  const b64url = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(enc.encode(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 })));
  const key = await crypto.subtle.importKey('raw', enc.encode(secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}
