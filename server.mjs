// ============================================================
// 板材宣传素材工坊 · 本地服务器
// 零依赖，Node.js >= 18。职责：
//   1. 托管前端页面 (public/) 与生成结果 (output/)
//   2. /api/proxy     通用API转发（浏览器直连各AI平台会被CORS拦截）
//   3. /api/save-file 把 base64 图片/音频落盘到 output/
//   4. /api/download  把远程图片/视频下载落盘到 output/
//   5. /api/mock-video 演示模式：用 ffmpeg 从静态图生成推近运镜视频
//   6. /api/compose   成片合成：标题卡 + 视频片段 + 标注层 + BGM
// ============================================================

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const OUTPUT_DIR = path.join(__dirname, 'output');
const PORT = Number(process.env.PORT || 3888);
const MAX_BODY = 300 * 1024 * 1024; // 300MB

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------- ffmpeg 定位 ----------
const FFMPEG_CANDIDATES = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
const FFPROBE_CANDIDATES = ['ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'];
function findBin(cands) {
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
      if (r.status === 0) return c;
    } catch {}
  }
  return null;
}
const FFMPEG = findBin(FFMPEG_CANDIDATES);
const FFPROBE = findBin(FFPROBE_CANDIDATES);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------- 小工具 ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  return JSON.parse(buf.toString('utf8') || '{}');
}

// 只允许安全的文件名片段（保留中文），去掉路径分隔符等
function sanitizeName(name, fallback = 'file') {
  const s = String(name || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim();
  return s || fallback;
}

// 目录可以包含子层级：逐段清洗，丢弃空段与 ".." 等
function sanitizeDir(dir) {
  return String(dir || '')
    .split('/')
    .map((seg) => sanitizeName(seg, '').slice(0, 80))
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/') || 'misc';
}

// 把 /output/xx 或相对路径解析为 output 下的绝对路径，防目录穿越
function resolveOutputPath(p) {
  let rel = String(p || '');
  if (rel.startsWith('/output/')) rel = rel.slice('/output/'.length);
  const abs = path.resolve(OUTPUT_DIR, rel);
  if (!abs.startsWith(OUTPUT_DIR + path.sep) && abs !== OUTPUT_DIR) throw new Error('非法路径');
  return abs;
}

function toWebPath(abs) {
  return '/output/' + path.relative(OUTPUT_DIR, abs).split(path.sep).join('/');
}

function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) throw new Error('无效的 dataURL');
  const mime = m[1] || 'application/octet-stream';
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { mime, buf };
}

function extForMime(mime) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/wav': '.wav',
  };
  return map[(mime || '').split(';')[0].trim()] || '';
}

function uid() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function runCmd(bin, args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('命令超时')); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 40000) err = err.slice(-20000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-1200)}`));
    });
  });
}

async function probeDuration(file) {
  if (!FFPROBE) return null;
  return new Promise((resolve) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', () => {
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) ? n : null);
    });
    p.on('error', () => resolve(null));
  });
}

// ---------- API 处理 ----------

// 通用代理：前端把目标平台请求描述发过来，由本机 Node 转发（绕过浏览器CORS）
async function handleProxy(req, res) {
  const spec = await readJson(req);
  const { url, method = 'POST', headers = {}, bodyType = 'json', body, multipart, timeoutMs = 300000 } = spec;
  if (!/^https?:\/\//.test(url || '')) return json(res, 400, { error: '缺少合法的 url' });

  const init = { method, headers: { ...headers } };
  if (bodyType === 'json' && body !== undefined) {
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  } else if (bodyType === 'text' && body !== undefined) {
    init.body = String(body);
  } else if (bodyType === 'multipart' && Array.isArray(multipart)) {
    const fd = new FormData();
    for (const f of multipart) {
      if (f.dataUrl || f.dataBase64) {
        const { mime, buf } = f.dataUrl
          ? parseDataUrl(f.dataUrl)
          : { mime: f.contentType || 'application/octet-stream', buf: Buffer.from(f.dataBase64, 'base64') };
        fd.append(f.name, new Blob([buf], { type: mime }), f.filename || 'file' + extForMime(mime));
      } else {
        fd.append(f.name, String(f.value ?? ''));
      }
    }
    delete init.headers['Content-Type'];
    init.body = fd;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.min(timeoutMs, 600000));
  init.signal = ctl.signal;

  try {
    const r = await fetch(url, init);
    const ct = r.headers.get('content-type') || '';
    let payload;
    if (ct.includes('application/json')) {
      payload = { status: r.status, contentType: ct, bodyType: 'json', body: await r.json().catch(() => null) };
    } else if (ct.startsWith('text/') || ct.includes('xml') || ct.includes('urlencoded')) {
      payload = { status: r.status, contentType: ct, bodyType: 'text', body: await r.text() };
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      payload = { status: r.status, contentType: ct, bodyType: 'binary', base64: buf.toString('base64') };
    }
    json(res, 200, payload);
  } catch (e) {
    json(res, 502, { error: '转发失败: ' + (e && e.message), cause: String((e && e.cause) || '') });
  } finally {
    clearTimeout(timer);
  }
}

// base64/dataURL 落盘
async function handleSaveFile(req, res) {
  const { dataUrl, base64, mime, dir = 'misc', filename } = await readJson(req);
  let data;
  if (dataUrl) data = parseDataUrl(dataUrl);
  else if (base64) data = { mime: mime || 'application/octet-stream', buf: Buffer.from(base64, 'base64') };
  else return json(res, 400, { error: '缺少 dataUrl 或 base64' });

  const safeDir = sanitizeDir(dir);
  const ext = path.extname(filename || '') || extForMime(data.mime) || '.bin';
  const base = sanitizeName(path.basename(filename || '', path.extname(filename || '')), uid()).slice(0, 120);
  const target = resolveOutputPath(path.join(safeDir, base + ext));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, data.buf);
  json(res, 200, { path: toWebPath(target), bytes: data.buf.length });
}

// 远程文件下载落盘（生成结果的 URL 通常有时效，必须及时保存）
async function handleDownload(req, res) {
  const { url, headers = {}, dir = 'downloads', filename } = await readJson(req);
  if (!/^https?:\/\//.test(url || '')) return json(res, 400, { error: '缺少合法的 url' });
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return json(res, 502, { error: `下载失败 HTTP ${r.status}` });
    const ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    const safeDir = sanitizeDir(dir);
    let ext = path.extname(filename || '');
    if (!ext) ext = extForMime(ct) || path.extname(new URL(url).pathname) || '.bin';
    const base = sanitizeName(path.basename(filename || '', path.extname(filename || '')), uid()).slice(0, 120);
    const target = resolveOutputPath(path.join(safeDir, base + ext));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buf);
    json(res, 200, { path: toWebPath(target), bytes: buf.length, contentType: ct });
  } catch (e) {
    json(res, 502, { error: '下载失败: ' + (e && e.message) });
  }
}

// 演示模式视频：静态图 → 缓慢推近 + 轻微光影变化 的 mp4
async function handleMockVideo(req, res) {
  if (!FFMPEG) return json(res, 500, { error: '本机未找到 ffmpeg，演示视频不可用（brew install ffmpeg）' });
  const { imagePath, duration = 5, width = 1080, height = 1440 } = await readJson(req);
  const src = resolveOutputPath(imagePath);
  if (!fs.existsSync(src)) return json(res, 400, { error: '源图不存在' });
  const dur = Math.min(Math.max(Number(duration) || 5, 2), 15);
  const fps = 30;
  const frames = Math.round(dur * fps);
  const target = resolveOutputPath(path.join('视频', `演示_${uid()}.mp4`));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // 放大后 zoompan 推近，模拟运镜；eq 做轻微亮度呼吸模拟光影
  const vf = [
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
    `crop=${width * 2}:${height * 2}`,
    `zoompan=z='1+0.12*on/${frames}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`,
    `format=yuv420p`,
  ].join(',');
  try {
    await runCmd(FFMPEG, ['-y', '-loop', '1', '-t', String(dur), '-i', src, '-vf', vf, '-t', String(dur), '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart', '-an', target]);
    json(res, 200, { path: toWebPath(target) });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}

// 成片合成：标题卡(可选) + N个片段(可带标注PNG覆盖层) + BGM(可选)
async function handleCompose(req, res) {
  if (!FFMPEG) return json(res, 500, { error: '本机未找到 ffmpeg，成片合成不可用（brew install ffmpeg）' });
  const { width = 1080, height = 1920, fps = 30, titlePngDataUrl, titleDuration = 3, clips = [], bgmPath, outName } = await readJson(req);
  if (!clips.length) return json(res, 400, { error: '至少选择一个视频片段' });

  const w = Math.round(width / 2) * 2, h = Math.round(height / 2) * 2;
  const tmp = path.join(OUTPUT_DIR, '.tmp-' + uid());
  await fsp.mkdir(tmp, { recursive: true });
  const parts = [];
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-an', '-r', String(fps)];

  try {
    // 1) 标题卡
    if (titlePngDataUrl) {
      const { buf } = parseDataUrl(titlePngDataUrl);
      const tp = path.join(tmp, 'title.png');
      await fsp.writeFile(tp, buf);
      const td = Math.min(Math.max(Number(titleDuration) || 3, 1), 10);
      const out = path.join(tmp, 'part-title.mp4');
      const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,fade=t=in:st=0:d=0.4,fade=t=out:st=${(td - 0.4).toFixed(2)}:d=0.4`;
      await runCmd(FFMPEG, ['-y', '-loop', '1', '-t', String(td), '-i', tp, '-vf', vf, ...enc, out]);
      parts.push(out);
    }

    // 2) 各片段：统一规格 + 可选标注覆盖层 + 首尾淡入淡出
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const src = resolveOutputPath(c.path);
      if (!fs.existsSync(src)) throw new Error(`片段不存在: ${c.path}`);
      const out = path.join(tmp, `part-${i}.mp4`);
      const dur = (await probeDuration(src)) || 5;
      const fadeOutStart = Math.max(dur - 0.35, 0).toFixed(2);
      const base = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps}[b]`;
      if (c.labelPngDataUrl) {
        const { buf } = parseDataUrl(c.labelPngDataUrl);
        const lp = path.join(tmp, `label-${i}.png`);
        await fsp.writeFile(lp, buf);
        const fc = `${base};[1:v]scale=${w}:${h}[lb];[b][lb]overlay=0:0,fade=t=in:st=0:d=0.35,fade=t=out:st=${fadeOutStart}:d=0.35[v]`;
        await runCmd(FFMPEG, ['-y', '-i', src, '-i', lp, '-filter_complex', fc, '-map', '[v]', ...enc, out]);
      } else {
        const fc = `${base};[b]fade=t=in:st=0:d=0.35,fade=t=out:st=${fadeOutStart}:d=0.35[v]`;
        await runCmd(FFMPEG, ['-y', '-i', src, '-filter_complex', fc, '-map', '[v]', ...enc, out]);
      }
      parts.push(out);
    }

    // 3) 拼接
    const listFile = path.join(tmp, 'list.txt');
    await fsp.writeFile(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const finalName = sanitizeName(outName || `成片_${uid()}`).slice(0, 100) + '.mp4';
    const target = resolveOutputPath(path.join('成片', finalName));
    await fsp.mkdir(path.dirname(target), { recursive: true });

    if (bgmPath) {
      const bgm = resolveOutputPath(bgmPath);
      await runCmd(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-stream_loop', '-1', '-i', bgm,
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-af', 'afade=t=out:st=9999:d=0', '-shortest', '-movflags', '+faststart', target]);
    } else {
      await runCmd(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', target]);
    }
    json(res, 200, { path: toWebPath(target) });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- 静态文件（带 Range，Safari 播放视频必需） ----------
function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start > end || end >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  let p;
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    p = decodeURIComponent(u.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }

  try {
    if (req.method === 'POST' && p === '/api/proxy') return await handleProxy(req, res);
    if (req.method === 'POST' && p === '/api/save-file') return await handleSaveFile(req, res);
    if (req.method === 'POST' && p === '/api/download') return await handleDownload(req, res);
    if (req.method === 'POST' && p === '/api/mock-video') return await handleMockVideo(req, res);
    if (req.method === 'POST' && p === '/api/compose') return await handleCompose(req, res);
    if (req.method === 'GET' && p === '/api/bgm-list') {
      const dir = path.join(OUTPUT_DIR, 'BGM');
      let files = [];
      try {
        files = fs.readdirSync(dir)
          .filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f))
          .sort()
          .map((f) => ({ name: f, path: '/output/BGM/' + f }));
      } catch {}
      return json(res, 200, { files });
    }
    if (req.method === 'GET' && p === '/api/health') {
      return json(res, 200, { ok: true, ffmpeg: !!FFMPEG, ffprobe: !!FFPROBE, output: OUTPUT_DIR });
    }
    if (req.method === 'GET' && p === '/api/open-output') {
      spawn('open', [OUTPUT_DIR], { stdio: 'ignore' }).on('error', () => {});
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p.startsWith('/output/')) {
        let abs;
        try { abs = resolveOutputPath(p); } catch { res.writeHead(403); return res.end(); }
        return serveStatic(req, res, abs);
      }
      let rel = p === '/' ? '/index.html' : p;
      const abs = path.resolve(PUBLIC_DIR, '.' + rel);
      if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
      return serveStatic(req, res, abs);
    }

    res.writeHead(405); res.end();
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   板材宣传素材工坊 已启动                    ║');
  console.log(`  ║   请在浏览器打开  http://localhost:${PORT}      ║`);
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log(`  生成结果保存在: ${OUTPUT_DIR}`);
  console.log(`  ffmpeg: ${FFMPEG ? '已找到 (' + FFMPEG + ')' : '未找到 —— 演示视频/成片合成不可用，可 brew install ffmpeg'}`);
  console.log('');
});
