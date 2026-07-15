// ============================================================
// 平台适配器：生图 / 生视频
// 接口规范均已对照 2026-07 各平台官方文档核实。
// 统一约定：
//   生图  provider.generate(cfg, args) -> {kind:'url'|'b64'|'dataUrl', value, mime?, headers?}
//   生视频 provider.create(cfg, args) -> taskRef 或 {immediatePath}
//          provider.poll(cfg, taskRef) -> {status:'running'|'done'|'failed', videoUrl?, headers?, error?}
//   cfg = {apiKey, secretKey, baseUrl, model}
//   args(图) = {prompt, negativePrompt, refDataUrl, ratio, sceneName, texLabel}
//   args(视频) = {prompt, negativePrompt, imageDataUrl, imagePath, duration, ratio}
// ============================================================

function stripDataUrl(dataUrl) {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

function pickErr(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 300);
  return (
    body.error?.message || body.error?.msg || body.message || body.msg ||
    body.base_resp?.status_msg ||
    (typeof body.error === 'string' ? body.error : '') ||
    JSON.stringify(body).slice(0, 300)
  );
}

const IMAGE_PROVIDERS = {};
const VIDEO_PROVIDERS = {};

// ================= 生图平台 =================

// —— 演示模式（不调用任何API，本地画一张示意图）——
IMAGE_PROVIDERS.mock = {
  id: 'mock',
  name: '演示模式',
  desc: '不消耗API，本地生成示意图，用于先跑通流程',
  async generate(cfg, { refDataUrl, refDataUrls, sceneName, texLabel, ratio }) {
    const dims = { '3:4': [900, 1200], '1:1': [1000, 1000], '4:3': [1200, 900], '16:9': [1280, 720], '9:16': [720, 1280] }[ratio] || [900, 1200];
    const [w, h] = dims;
    const refs = refDataUrls && refDataUrls.length ? refDataUrls : [refDataUrl];
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#efe7db');
    bg.addColorStop(1, '#d8cbb8');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#c9baa5';
    ctx.fillRect(0, h * 0.78, w, h * 0.22);
    // 多花色时把面板竖向分条展示（①主花色占一半，其余平分）
    const pw = w * 0.62, ph = h * 0.6, px = w * 0.19, py = h * 0.14;
    let x = px;
    for (let i = 0; i < refs.length; i++) {
      const img = await loadImage(refs[i]);
      const sw = refs.length === 1 ? pw : (i === 0 ? pw * 0.5 : (pw * 0.5) / (refs.length - 1));
      const s = Math.max(sw / img.naturalWidth, ph / img.naturalHeight);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, py, sw, ph);
      ctx.clip();
      ctx.drawImage(img, x + (sw - img.naturalWidth * s) / 2, py + (ph - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
      ctx.restore();
      x += sw;
    }
    ctx.strokeStyle = 'rgba(90,70,50,0.5)';
    ctx.lineWidth = 4;
    ctx.strokeRect(px, py, pw, ph);
    const glow = ctx.createLinearGradient(px, py, px + pw, py + ph);
    glow.addColorStop(0, 'rgba(255,255,255,0.22)');
    glow.addColorStop(0.5, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = 'rgba(60,45,30,0.8)';
    ctx.font = `600 ${Math.round(w * 0.04)}px "PingFang SC", sans-serif`;
    ctx.fillText(`${sceneName}（演示）`, w * 0.06, h * 0.08);
    ctx.font = `400 ${Math.round(w * 0.028)}px "PingFang SC", sans-serif`;
    ctx.fillText(texLabel || '', w * 0.06, h * 0.94);
    await sleep(600 + Math.random() * 900);
    return { kind: 'dataUrl', value: cv.toDataURL('image/jpeg', 0.9) };
  },
};

// —— 即梦 Seedream（火山方舟）——
// POST /api/v3/images/generations，同步返回；image 支持 dataURI 数组（最多14张参考图）
IMAGE_PROVIDERS.volc = {
  id: 'volc',
  name: '即梦 Seedream（火山方舟）',
  desc: '国内推荐 · 参考图上花色效果好',
  docsUrl: 'https://console.volcengine.com/ark',
  defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
  defaultModel: 'doubao-seedream-4-5-251128',
  models: [
    { id: 'doubao-seedream-5-0-260128', label: 'Seedream 5.0' },
    { id: 'doubao-seedream-5-0-lite-260128', label: 'Seedream 5.0 Lite（便宜）' },
    { id: 'doubao-seedream-4-5-251128', label: 'Seedream 4.5' },
    { id: 'doubao-seedream-4-0-250828', label: 'Seedream 4.0' },
  ],
  // 官方推荐的2K档尺寸；像素值需满足总像素在 [2560x1440, 4096x4096] 区间
  sizeFor(ratio) {
    return { '3:4': '1728x2304', '1:1': '2048x2048', '4:3': '2304x1728', '16:9': '2848x1600', '9:16': '1600x2848' }[ratio] || '1728x2304';
  },
  async generate(cfg, { prompt, refDataUrl, refDataUrls, ratio }) {
    const body = {
      model: cfg.model,
      prompt,
      image: refDataUrls && refDataUrls.length ? refDataUrls : [refDataUrl], // 最多支持14张参考图
      size: this.sizeFor(ratio),
      sequential_image_generation: 'disabled',
      response_format: 'url',
      watermark: false,
    };
    if (/-t2i-/.test(cfg.model)) delete body.image; // 纯文生图模型不接受参考图
    const r = await proxyJson({
      url: `${cfg.baseUrl}/api/v3/images/generations`,
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'json',
      body,
    });
    const url = r.data?.[0]?.url;
    if (!url) throw new Error('未返回图片: ' + pickErr(r));
    return { kind: 'url', value: url };
  },
};

// —— 通义千问 图像编辑（阿里百炼）——
// POST /api/v1/services/aigc/multimodal-generation/generation，同步返回
IMAGE_PROVIDERS.dashscope = {
  id: 'dashscope',
  name: '通义千问 Qwen-Image（阿里百炼）',
  desc: '国内 · 图像编辑模型',
  docsUrl: 'https://bailian.console.aliyun.com/',
  defaultBaseUrl: 'https://dashscope.aliyuncs.com',
  defaultModel: 'qwen-image-2.0-pro',
  models: [
    { id: 'qwen-image-2.0-pro', label: 'Qwen-Image 2.0 Pro（最新）' },
    { id: 'qwen-image-edit-max', label: 'Qwen-Image-Edit Max' },
    { id: 'qwen-image-edit-plus', label: 'Qwen-Image-Edit Plus' },
    { id: 'qwen-image-edit', label: 'Qwen-Image-Edit 基础版' },
  ],
  // 基础版不支持指定分辨率；其余用 "宽*高"
  sizeFor(ratio) {
    return { '3:4': '1536*2048', '1:1': '2048*2048', '4:3': '2048*1536', '16:9': '2048*1152', '9:16': '1152*2048' }[ratio] || '1536*2048';
  },
  async generate(cfg, { prompt, negativePrompt, refDataUrl, refDataUrls, ratio }) {
    const refs = refDataUrls && refDataUrls.length ? refDataUrls : [refDataUrl];
    if (refs.length > 3) throw new Error('通义千问图像编辑最多支持3张花色组合，4张请改用「即梦 Seedream」');
    const parameters = { watermark: false };
    if (negativePrompt) parameters.negative_prompt = negativePrompt;
    if (cfg.model !== 'qwen-image-edit') parameters.size = this.sizeFor(ratio);
    const r = await proxyJson({
      url: `${cfg.baseUrl}/api/v1/services/aigc/multimodal-generation/generation`,
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'json',
      body: {
        model: cfg.model,
        input: { messages: [{ role: 'user', content: [...refs.map((u) => ({ image: u })), { text: prompt }] }] },
        parameters,
      },
    });
    const content = r.output?.choices?.[0]?.message?.content || [];
    const imgItem = content.find((c) => c.image);
    if (!imgItem) throw new Error('未返回图片: ' + pickErr(r));
    return { kind: 'url', value: imgItem.image };
  },
};

// —— 可灵 图像生成（异步任务）——
// 新版鉴权：API Key 直接 Bearer；旧版 AK+SK 生成 JWT（填了 SecretKey 就走 JWT）
async function klingAuthHeader(cfg) {
  const token = cfg.secretKey ? await klingJwt(cfg.apiKey, cfg.secretKey) : cfg.apiKey;
  return { Authorization: `Bearer ${token}` };
}

IMAGE_PROVIDERS.kling = {
  id: 'kling',
  name: '可灵 图像（可灵开放平台）',
  desc: '国内 · 新版填API Key即可；旧版AK/SK则两项都填',
  docsUrl: 'https://app.klingai.com/cn/dev',
  keyLabel: 'API Key（或旧版 Access Key）',
  needsSecret: true,
  secretOptional: true,
  defaultBaseUrl: 'https://api-beijing.klingai.com',
  defaultModel: 'kling-v2-1',
  models: [
    { id: 'kling-v3', label: 'Kling V3' },
    { id: 'kling-v2-1', label: 'Kling V2.1' },
    { id: 'kling-v2', label: 'Kling V2' },
    { id: 'kling-v1-5', label: 'Kling V1.5' },
  ],
  async generate(cfg, { prompt, refDataUrl, refDataUrls, ratio }) {
    if (refDataUrls && refDataUrls.length > 1) {
      throw new Error('可灵图生图仅支持1张参考图，多花色组合请改用「即梦 Seedream」或「通义千问」');
    }
    const body = {
      model_name: cfg.model,
      prompt,
      image: stripDataUrl(refDataUrl), // 官方要求：裸 base64，不带 data: 前缀
      n: 1,
      aspect_ratio: ratio,
      resolution: '2k',
    };
    if (cfg.model === 'kling-v1-5') {
      body.image_reference = 'subject'; // v1-5 传参考图时必填
      body.image_fidelity = 0.6;
    }
    // 注意：图生图时可灵不支持 negative_prompt
    const r = await proxyJson({
      url: `${cfg.baseUrl}/v1/images/generations`,
      method: 'POST',
      headers: await klingAuthHeader(cfg),
      bodyType: 'json',
      body,
    });
    if (r.code !== 0) throw new Error('可灵返回错误: ' + pickErr(r));
    const taskId = r.data?.task_id;
    if (!taskId) throw new Error('未返回任务ID: ' + pickErr(r));
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const q = await proxyJson({
        url: `${cfg.baseUrl}/v1/images/generations/${taskId}`,
        method: 'GET',
        headers: await klingAuthHeader(cfg),
        bodyType: 'none',
      });
      const st = q.data?.task_status;
      if (st === 'succeed') {
        const url = q.data?.task_result?.images?.[0]?.url;
        if (!url) throw new Error('任务成功但未返回图片');
        return { kind: 'url', value: url };
      }
      if (st === 'failed') throw new Error(q.data?.task_status_msg || '可灵生成失败');
    }
    throw new Error('可灵生图等待超时');
  },
};

// —— Gemini 图像（nano banana 系列）——
IMAGE_PROVIDERS.gemini = {
  id: 'gemini',
  name: 'Gemini 图像（Google）',
  desc: '需海外网络 · 花色迁移效果好',
  docsUrl: 'https://aistudio.google.com/apikey',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  defaultModel: 'gemini-3.1-flash-image',
  models: [
    { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image（推荐）' },
    { id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image（更强）' },
    { id: 'gemini-3.1-flash-lite-image', label: 'Gemini 3.1 Flash Lite（便宜）' },
    { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image（旧版）' },
  ],
  async generate(cfg, { prompt, refDataUrl, refDataUrls, ratio }) {
    const refs = refDataUrls && refDataUrls.length ? refDataUrls : [refDataUrl];
    const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
    if (/gemini-3/.test(cfg.model)) {
      // imageSize 必须大写K；lite 只支持 1K
      const size = /lite/.test(cfg.model) ? '1K' : '2K';
      generationConfig.responseFormat = { image: { aspectRatio: ratio, imageSize: size } };
    }
    const r = await proxyJson({
      url: `${cfg.baseUrl}/v1beta/models/${cfg.model}:generateContent`,
      method: 'POST',
      headers: { 'x-goog-api-key': cfg.apiKey },
      bodyType: 'json',
      body: {
        contents: [{
          parts: [
            ...refs.map((u) => ({ inline_data: { mime_type: dataUrlMime(u), data: stripDataUrl(u) } })),
            { text: prompt },
          ],
        }],
        generationConfig,
      },
    });
    const parts = r.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
    if (!imgPart) throw new Error('未返回图片: ' + pickErr(r));
    const d = imgPart.inlineData || imgPart.inline_data;
    return { kind: 'b64', value: d.data, mime: d.mimeType || d.mime_type || 'image/png' };
  },
};

// —— OpenAI GPT-Image ——
IMAGE_PROVIDERS.openai = {
  id: 'openai',
  name: 'GPT-Image（OpenAI）',
  desc: '需海外网络 · 支持中转地址',
  docsUrl: 'https://platform.openai.com/api-keys',
  defaultBaseUrl: 'https://api.openai.com',
  defaultModel: 'gpt-image-1.5',
  models: [
    { id: 'gpt-image-1.5', label: 'GPT-Image 1.5' },
    { id: 'gpt-image-2', label: 'GPT-Image 2（最新）' },
    { id: 'gpt-image-1', label: 'GPT-Image 1' },
    { id: 'gpt-image-1-mini', label: 'GPT-Image 1 Mini（便宜）' },
  ],
  sizeFor(ratio) {
    return { '3:4': '1024x1536', '9:16': '1024x1536', '1:1': '1024x1024', '4:3': '1536x1024', '16:9': '1536x1024' }[ratio] || '1024x1536';
  },
  async generate(cfg, { prompt, refDataUrl, refDataUrls, ratio }) {
    const refs = refDataUrls && refDataUrls.length ? refDataUrls : [refDataUrl];
    const multipart = [
      { name: 'model', value: cfg.model },
      { name: 'prompt', value: prompt },
      { name: 'size', value: this.sizeFor(ratio) },
      { name: 'quality', value: 'high' },
      ...refs.map((u, i) => ({ name: 'image[]', dataUrl: u, filename: `ref${i + 1}.jpg` })),
    ];
    // gpt-image-2 恒为高保真，不接受该参数
    if (cfg.model !== 'gpt-image-2') multipart.push({ name: 'input_fidelity', value: 'high' });
    const r = await proxyJson({
      url: `${cfg.baseUrl}/v1/images/edits`,
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'multipart',
      multipart,
    });
    const b64 = r.data?.[0]?.b64_json;
    if (!b64) throw new Error('未返回图片: ' + pickErr(r));
    return { kind: 'b64', value: b64, mime: 'image/png' };
  },
};

// ================= 生视频平台 =================

// —— 演示模式（本地ffmpeg推近运镜）——
VIDEO_PROVIDERS.mock = {
  id: 'mock',
  name: '演示模式',
  desc: '不消耗API，本地用图片生成推近运镜视频（需要ffmpeg）',
  async create(cfg, { imagePath, duration, ratio }) {
    const dims = { '3:4': [1080, 1440], '1:1': [1080, 1080], '4:3': [1440, 1080], '16:9': [1920, 1080], '9:16': [1080, 1920] }[ratio] || [1080, 1440];
    const r = await api('/api/mock-video', { imagePath, duration, width: dims[0], height: dims[1] });
    return { immediatePath: r.path };
  },
  async poll() {
    return { status: 'done' };
  },
};

// —— 即梦 Seedance（火山方舟）——
// POST /api/v3/contents/generations/tasks（异步）；规格参数用顶层JSON字段（官方推荐）
VIDEO_PROVIDERS.volcVideo = {
  id: 'volcVideo',
  name: '即梦 Seedance（火山方舟）',
  desc: '国内推荐 · 运镜质感好',
  docsUrl: 'https://console.volcengine.com/ark',
  defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
  defaultModel: 'doubao-seedance-1-5-pro-251215',
  models: [
    { id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0（需账户余额>200元开通）' },
    { id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast（720p）' },
    { id: 'doubao-seedance-1-5-pro-251215', label: 'Seedance 1.5 Pro（推荐）' },
    { id: 'doubao-seedance-1-0-pro-250528', label: 'Seedance 1.0 Pro' },
  ],
  pollInterval: 10000,
  async create(cfg, { prompt, imageDataUrl, duration }) {
    // 2.0 Fast / Mini 不支持 1080p
    const resolution = /2-0-(fast|mini)/.test(cfg.model) ? '720p' : '1080p';
    const body = {
      model: cfg.model,
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageDataUrl }, role: 'first_frame' },
      ],
      resolution,
      ratio: 'adaptive',
      duration: Math.min(Math.max(duration, 4), 12),
      watermark: false,
    };
    if (/seedance-2-0|seedance-1-5-pro/.test(cfg.model)) body.generate_audio = false;
    const r = await proxyJson({
      url: `${cfg.baseUrl}/api/v3/contents/generations/tasks`,
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'json',
      body,
    });
    const id = r.id;
    if (!id) throw new Error('未返回任务ID: ' + pickErr(r));
    return { id };
  },
  async poll(cfg, ref) {
    const r = await proxyJson({
      url: `${cfg.baseUrl}/api/v3/contents/generations/tasks/${ref.id}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'none',
    });
    if (r.status === 'succeeded') return { status: 'done', videoUrl: r.content?.video_url };
    if (['failed', 'cancelled', 'expired'].includes(r.status)) return { status: 'failed', error: pickErr(r.error) || r.status };
    return { status: 'running' };
  },
};

// —— NoToken 中转（火山 Seedance 2.0，第三方中转站）——
// 与火山原生同格式：POST /api/v3/contents/generations/tasks；base 指向 notoken.pro
VIDEO_PROVIDERS.notokenVideo = {
  id: 'notokenVideo',
  name: 'NoToken 中转（Seedance）',
  desc: '第三方中转 · 火山 Seedance 2.0，填令牌即可（仅生视频）',
  docsUrl: 'https://notoken.pro',
  keyLabel: '令牌（NoToken 控制台创建）',
  defaultBaseUrl: 'https://notoken.pro',
  defaultModel: 'seedance-2.0-mini|480p',
  // 模型ID用 “模型|分辨率” 编码。模型名以令牌 /v1/models 实际返回的短名为准
  // （当前令牌分组 SeeDance满血 返回 seedance-2.0 / -fast / -mini）。
  models: [
    { id: 'seedance-2.0-mini|480p', label: '2.0 Mini · 480p（低分辨率最便宜）' },
    { id: 'seedance-2.0-fast|480p', label: '2.0 Fast · 480p' },
    { id: 'seedance-2.0-mini|720p', label: '2.0 Mini · 720p' },
    { id: 'seedance-2.0-fast|720p', label: '2.0 Fast · 720p' },
    { id: 'seedance-2.0|720p', label: '2.0 正式版 · 720p' },
    { id: 'seedance-2.0|1080p', label: '2.0 正式版 · 1080p（最清晰）' },
  ],
  pollInterval: 8000,
  // NoToken 渠道不收 base64：先把首帧图传到其素材库，换公网 URL
  async uploadFrame(cfg, imageDataUrl) {
    const up = await proxyJson({
      url: `${cfg.baseUrl}/api/v3/files/uploads`,
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'multipart',
      multipart: [{ name: 'file', dataUrl: imageDataUrl, filename: 'frame.jpg' }],
    });
    const url = up.url || up.data?.url;
    if (!url) throw new Error('素材上传未返回URL: ' + JSON.stringify(up).slice(0, 200));
    return url;
  },
  async create(cfg, { prompt, imageDataUrl, duration }) {
    const [model, resolution = '720p'] = cfg.model.split('|');
    const frameUrl = await this.uploadFrame(cfg, imageDataUrl);
    const body = {
      model,
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: frameUrl }, role: 'first_frame' },
      ],
      resolution,
      ratio: 'adaptive',
      duration: Math.min(Math.max(duration, 4), 12),
      watermark: false,
      generate_audio: false,
    };
    const r = await proxyJson({
      url: `${cfg.baseUrl}/api/v3/contents/generations/tasks`,
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'json',
      body,
    });
    const id = r.id;
    if (!id) throw new Error('未返回任务ID: ' + pickErr(r));
    return { id };
  },
  async poll(cfg, ref) {
    const r = await proxyJson({
      url: `${cfg.baseUrl}/api/v3/contents/generations/tasks/${ref.id}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'none',
    });
    if (r.status === 'succeeded') {
      const url = r.content?.video_url || r.video_url || r.url;
      // NoToken 特性：渲染完成但余额不足时会扣住链接（结果保留48小时，充值后可取回，不重复扣费）
      if (!url) {
        return { status: 'failed', error: (r.message || (r.payment_required ? 'NoToken余额不足' : '任务成功但未返回视频地址')) + '（视频已渲染并保留48小时，充值后可免费取回；直接重新生成会再次计费）' };
      }
      return { status: 'done', videoUrl: url };
    }
    if (['failed', 'cancelled', 'expired'].includes(r.status)) return { status: 'failed', error: pickErr(r.error) || r.status };
    return { status: 'running' };
  },
};

// —— 通义万相（阿里百炼）——
// 创建需 X-DashScope-Async: enable；轮询 GET /api/v1/tasks/{id}
VIDEO_PROVIDERS.dashscopeVideo = {
  id: 'dashscopeVideo',
  name: '通义万相 Wan（阿里百炼）',
  desc: '国内 · 图生视频',
  docsUrl: 'https://bailian.console.aliyun.com/',
  defaultBaseUrl: 'https://dashscope.aliyuncs.com',
  defaultModel: 'wan2.6-i2v-flash',
  models: [
    { id: 'wan2.6-i2v-flash', label: 'Wan 2.6 Flash（最新，可关音频）' },
    { id: 'wan2.6-i2v', label: 'Wan 2.6' },
    { id: 'wan2.5-i2v-preview', label: 'Wan 2.5（自动配乐不可关）' },
    { id: 'wan2.2-i2v-plus', label: 'Wan 2.2 Plus（固定5秒）' },
  ],
  pollInterval: 10000,
  async create(cfg, { prompt, negativePrompt, imageDataUrl, duration }) {
    const parameters = { resolution: '1080P', prompt_extend: true, watermark: false };
    if (!cfg.model.startsWith('wan2.2')) parameters.duration = duration; // 2.2 固定5秒
    if (cfg.model === 'wan2.6-i2v-flash') parameters.audio = false; // 仅此模型支持关音频
    const input = { prompt, img_url: imageDataUrl };
    if (negativePrompt) input.negative_prompt = negativePrompt;
    const r = await proxyJson({
      url: `${cfg.baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`,
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'X-DashScope-Async': 'enable' },
      bodyType: 'json',
      body: { model: cfg.model, input, parameters },
    });
    const id = r.output?.task_id;
    if (!id) throw new Error('未返回任务ID: ' + pickErr(r));
    return { id };
  },
  async poll(cfg, ref) {
    const r = await proxyJson({
      url: `${cfg.baseUrl}/api/v1/tasks/${ref.id}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'none',
    });
    const st = r.output?.task_status;
    if (st === 'SUCCEEDED') return { status: 'done', videoUrl: r.output?.video_url };
    if (st === 'FAILED' || st === 'CANCELED' || st === 'UNKNOWN') {
      return { status: 'failed', error: r.output?.message || pickErr(r) };
    }
    return { status: 'running' };
  },
};

// —— 可灵 Kling 视频 ——
VIDEO_PROVIDERS.klingVideo = {
  id: 'klingVideo',
  name: '可灵 Kling（图生视频）',
  desc: '国内 · 新版填API Key即可；旧版AK/SK则两项都填',
  docsUrl: 'https://app.klingai.com/cn/dev',
  keyLabel: 'API Key（或旧版 Access Key）',
  needsSecret: true,
  secretOptional: true,
  defaultBaseUrl: 'https://api-beijing.klingai.com',
  defaultModel: 'kling-v2-5-turbo',
  models: [
    { id: 'kling-v3', label: 'Kling V3（3-15秒）' },
    { id: 'kling-v2-6', label: 'Kling V2.6' },
    { id: 'kling-v2-5-turbo', label: 'Kling V2.5 Turbo（推荐）' },
    { id: 'kling-v2-1', label: 'Kling V2.1' },
    { id: 'kling-v1-6', label: 'Kling V1.6' },
  ],
  pollInterval: 8000,
  async create(cfg, { prompt, negativePrompt, imageDataUrl, duration }) {
    const body = {
      model_name: cfg.model,
      image: stripDataUrl(imageDataUrl), // 裸 base64，不带前缀
      prompt,
      mode: 'pro', // pro=1080P
      duration: String(duration === 10 ? 10 : 5),
      sound: 'off',
    };
    if (negativePrompt) body.negative_prompt = negativePrompt;
    if (/^kling-v1/.test(cfg.model)) body.cfg_scale = 0.5; // v2.x 系列不支持该参数
    const r = await proxyJson({
      url: `${cfg.baseUrl}/v1/videos/image2video`,
      method: 'POST',
      headers: await klingAuthHeader(cfg),
      bodyType: 'json',
      body,
    });
    if (r.code !== 0) throw new Error('可灵返回错误: ' + pickErr(r));
    const id = r.data?.task_id;
    if (!id) throw new Error('未返回任务ID: ' + pickErr(r));
    return { id };
  },
  async poll(cfg, ref) {
    const r = await proxyJson({
      url: `${cfg.baseUrl}/v1/videos/image2video/${ref.id}`,
      method: 'GET',
      headers: await klingAuthHeader(cfg),
      bodyType: 'none',
    });
    const st = r.data?.task_status; // submitted / processing / succeed / failed
    if (st === 'succeed') return { status: 'done', videoUrl: r.data?.task_result?.videos?.[0]?.url };
    if (st === 'failed') return { status: 'failed', error: r.data?.task_status_msg || '可灵生成失败' };
    return { status: 'running' };
  },
};

// —— MiniMax 海螺 ——
VIDEO_PROVIDERS.minimax = {
  id: 'minimax',
  name: 'MiniMax 海螺',
  desc: '国内 · 图生视频（支持[推进][环绕]运镜指令）',
  docsUrl: 'https://platform.minimaxi.com/',
  defaultBaseUrl: 'https://api.minimaxi.com',
  defaultModel: 'MiniMax-Hailuo-2.3',
  models: [
    { id: 'MiniMax-Hailuo-2.3', label: 'Hailuo 2.3（推荐）' },
    { id: 'MiniMax-Hailuo-2.3-Fast', label: 'Hailuo 2.3 Fast' },
    { id: 'MiniMax-Hailuo-02', label: 'Hailuo 02' },
    { id: 'I2V-01-Director', label: 'I2V-01 Director（运镜指令）' },
  ],
  pollInterval: 10000,
  async create(cfg, { prompt, imageDataUrl, duration }) {
    // Hailuo 2.3: 6秒支持768P/1080P，10秒仅768P
    const dur = duration >= 10 ? 10 : 6;
    const body = {
      model: cfg.model,
      prompt,
      first_frame_image: imageDataUrl, // 需带 data:image/...;base64, 前缀
      prompt_optimizer: true,
      aigc_watermark: false,
    };
    if (/^MiniMax-Hailuo/.test(cfg.model)) {
      body.duration = dur;
      body.resolution = dur === 10 ? '768P' : '1080P';
    }
    const r = await proxyJson({
      url: `${cfg.baseUrl}/v1/video_generation`,
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'json',
      body,
    });
    if (r.base_resp && r.base_resp.status_code !== 0) throw new Error('MiniMax返回错误: ' + pickErr(r));
    const id = r.task_id;
    if (!id) throw new Error('未返回任务ID: ' + pickErr(r));
    return { id };
  },
  async poll(cfg, ref) {
    const r = await proxyJson({
      url: `${cfg.baseUrl}/v1/query/video_generation?task_id=${encodeURIComponent(ref.id)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'none',
    });
    // status: Preparing / Queueing / Processing / Success / Fail
    if (r.status === 'Success') {
      const f = await proxyJson({
        url: `${cfg.baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(r.file_id)}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        bodyType: 'none',
      });
      const url = f.file?.download_url;
      if (!url) return { status: 'failed', error: '任务成功但未取到下载地址' };
      return { status: 'done', videoUrl: url }; // 下载URL有效期1小时，立即转存
    }
    if (r.status === 'Fail') return { status: 'failed', error: pickErr(r) };
    return { status: 'running' };
  },
};

// —— Vidu ——
VIDEO_PROVIDERS.vidu = {
  id: 'vidu',
  name: 'Vidu（生数科技）',
  desc: '国内 · 图生视频',
  docsUrl: 'https://platform.vidu.cn/',
  defaultBaseUrl: 'https://api.vidu.cn',
  defaultModel: 'viduq3-turbo',
  models: [
    { id: 'viduq3-pro', label: 'Vidu Q3 Pro' },
    { id: 'viduq3-turbo', label: 'Vidu Q3 Turbo（推荐）' },
    { id: 'viduq2-turbo', label: 'Vidu Q2 Turbo' },
    { id: 'viduq1', label: 'Vidu Q1（固定5秒）' },
  ],
  pollInterval: 8000,
  // 各模型时长/分辨率档位不同：Q3 1-16秒；Q2 1-10秒；Q1 仅5秒(1080p)；vidu2.0 仅4/8秒
  async create(cfg, { prompt, imageDataUrl, duration }) {
    const body = {
      model: cfg.model,
      images: [imageDataUrl],
      prompt,
      movement_amplitude: 'auto',
    };
    if (cfg.model === 'viduq1' || cfg.model === 'viduq1-classic') {
      body.resolution = '1080p'; // duration 固定5，不传
    } else if (cfg.model === 'vidu2.0') {
      body.duration = duration >= 10 ? 8 : 4;
      body.resolution = body.duration === 8 ? '720p' : '1080p';
    } else {
      body.duration = duration;
      body.resolution = '1080p';
      if (/^viduq3/.test(cfg.model)) body.audio = false; // Q3 支持音画同出，宣传片段不要声音
    }
    const r = await proxyJson({
      url: `${cfg.baseUrl}/ent/v2/img2video`,
      method: 'POST',
      headers: { Authorization: `Token ${cfg.apiKey}` },
      bodyType: 'json',
      body,
    });
    const id = r.task_id;
    if (!id) throw new Error('未返回任务ID: ' + pickErr(r));
    return { id };
  },
  async poll(cfg, ref) {
    const r = await proxyJson({
      url: `${cfg.baseUrl}/ent/v2/tasks/${ref.id}/creations`,
      method: 'GET',
      headers: { Authorization: `Token ${cfg.apiKey}` },
      bodyType: 'none',
    });
    if (r.state === 'success') return { status: 'done', videoUrl: r.creations?.[0]?.url };
    if (r.state === 'failed') return { status: 'failed', error: r.err_code || 'Vidu 生成失败' };
    return { status: 'running' };
  },
};

// —— Google Veo ——
VIDEO_PROVIDERS.veo = {
  id: 'veo',
  name: 'Veo（Google）',
  desc: '需海外网络 · 仅支持 16:9 / 9:16',
  docsUrl: 'https://aistudio.google.com/apikey',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  defaultModel: 'veo-3.1-generate-preview',
  models: [
    { id: 'veo-3.1-generate-preview', label: 'Veo 3.1' },
    { id: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast' },
  ],
  pollInterval: 10000,
  async create(cfg, { prompt, imageDataUrl, duration, ratio }) {
    const aspect = ['16:9', '4:3'].includes(ratio) ? '16:9' : '9:16';
    const r = await proxyJson({
      url: `${cfg.baseUrl}/v1beta/models/${cfg.model}:predictLongRunning`,
      method: 'POST',
      headers: { 'x-goog-api-key': cfg.apiKey },
      bodyType: 'json',
      body: {
        instances: [{
          prompt,
          image: { inlineData: { mimeType: dataUrlMime(imageDataUrl), data: stripDataUrl(imageDataUrl) } },
        }],
        parameters: { aspectRatio: aspect, resolution: '1080p', durationSeconds: '8', numberOfVideos: 1 },
      },
    });
    const name = r.name;
    if (!name) throw new Error('未返回任务: ' + pickErr(r));
    return { name };
  },
  async poll(cfg, ref) {
    const r = await proxyJson({
      url: `${cfg.baseUrl}/v1beta/${ref.name}`,
      method: 'GET',
      headers: { 'x-goog-api-key': cfg.apiKey },
      bodyType: 'none',
    });
    if (r.done) {
      if (r.error) return { status: 'failed', error: pickErr(r.error) };
      const uri = r.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) return { status: 'failed', error: '完成但未返回视频地址: ' + JSON.stringify(r).slice(0, 200) };
      return { status: 'done', videoUrl: uri, headers: { 'x-goog-api-key': cfg.apiKey } };
    }
    return { status: 'running' };
  },
};

// —— OpenAI Sora ——
VIDEO_PROVIDERS.sora = {
  id: 'sora',
  name: 'Sora（OpenAI）',
  desc: '需海外网络 · 支持中转地址',
  docsUrl: 'https://platform.openai.com/docs/guides/video-generation',
  defaultBaseUrl: 'https://api.openai.com',
  defaultModel: 'sora-2',
  models: [
    { id: 'sora-2', label: 'Sora 2' },
    { id: 'sora-2-pro', label: 'Sora 2 Pro（支持1080p）' },
  ],
  pollInterval: 10000,
  sizeFor(cfgModel, ratio) {
    const portrait = !['16:9', '4:3'].includes(ratio);
    if (cfgModel === 'sora-2-pro') return portrait ? '1080x1920' : '1920x1080';
    return portrait ? '720x1280' : '1280x720';
  },
  async create(cfg, { prompt, imageDataUrl, duration, ratio }) {
    const size = this.sizeFor(cfg.model, ratio);
    const [w, h] = size.split('x').map(Number);
    // Sora 要求首帧图分辨率与视频完全一致
    const cropped = await cropDataUrlToSize(imageDataUrl, w, h, 'image/jpeg');
    const r = await proxyJson({
      url: `${cfg.baseUrl}/v1/videos`,
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'multipart',
      multipart: [
        { name: 'model', value: cfg.model },
        { name: 'prompt', value: prompt },
        { name: 'size', value: size },
        { name: 'seconds', value: duration >= 10 ? '12' : '8' },
        { name: 'input_reference', dataUrl: cropped, filename: 'ref.jpg' },
      ],
    });
    const id = r.id;
    if (!id) throw new Error('未返回任务ID: ' + pickErr(r));
    return { id };
  },
  async poll(cfg, ref) {
    const r = await proxyJson({
      url: `${cfg.baseUrl}/v1/videos/${ref.id}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      bodyType: 'none',
    });
    if (r.status === 'completed') {
      return {
        status: 'done',
        videoUrl: `${cfg.baseUrl}/v1/videos/${ref.id}/content`,
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      };
    }
    if (r.status === 'failed' || r.status === 'expired') return { status: 'failed', error: pickErr(r.error) || 'Sora 生成失败' };
    return { status: 'running' };
  },
};
