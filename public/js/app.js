// ============================================================
// 板材宣传素材工坊 · 主逻辑
// ============================================================

/* global DEFAULT_SCENES, DEFAULT_VIDEO_PROMPT, DEFAULT_NEGATIVE_PROMPT, DEFAULT_STYLE_SUFFIX,
          IMAGE_PROVIDERS, VIDEO_PROVIDERS */

const LS = {
  settings: 'bancai.settings.v1',
  prompts: 'bancai.prompts.v1',
  textures: 'bancai.textures.v1',
  results: 'bancai.results.v1',
  videos: 'bancai.videos.v1',
};

const state = {
  textures: loadLS(LS.textures, []),
  results: loadLS(LS.results, []),
  videoTasks: loadLS(LS.videos, []),
  settings: Object.assign(
    {
      imgProvider: 'mock',
      vidProvider: 'mock',
      providers: {},
      imgRatio: '3:4',
      vidDuration: 5,
      concurrency: 2,
      retries: 1,
      brandName: '',
      brandXhs: '',
      brandLogoPath: '',
      wmEnable: true,
      selectedTex: [],
      bgmPath: '',
    },
    loadLS(LS.settings, {})
  ),
  prompts: Object.assign(
    {
      scenes: DEFAULT_SCENES.map((s) => ({ ...s, enabled: true, custom: false })),
      video: DEFAULT_VIDEO_PROMPT,
      negative: DEFAULT_NEGATIVE_PROMPT,
      styleSuffix: DEFAULT_STYLE_SUFFIX,
    },
    loadLS(LS.prompts, {})
  ),
};

// 若默认场景库新增了场景，而本地存的是旧列表，则补齐缺失的默认场景
for (const def of DEFAULT_SCENES) {
  if (!state.prompts.scenes.find((s) => s.id === def.id)) {
    state.prompts.scenes.push({ ...def, enabled: true, custom: false });
  }
}
// 多花色搭配指令：补齐缺失的默认值
state.prompts.comboInstructions = Object.assign({}, DEFAULT_COMBO_INSTRUCTIONS, state.prompts.comboInstructions || {});
if (!state.settings.comboCount) state.settings.comboCount = 1;

let stopFlag = false;
let generating = false;
const texDataUrlCache = {};

// ---------- 基础工具 ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3200);
}
function persist() {
  saveLS(LS.settings, state.settings);
  saveLS(LS.prompts, state.prompts);
  saveLS(LS.textures, state.textures);
  saveLS(LS.results, state.results);
  saveLS(LS.videos, state.videoTasks);
}
function texLabel(tex) {
  return [tex.code, tex.name].filter(Boolean).join(' ') || '未命名花色';
}
function ratioCss(r) {
  return { '3:4': '3/4', '1:1': '1/1', '4:3': '4/3', '16:9': '16/9', '9:16': '9/16' }[r] || '3/4';
}
async function getTexDataUrl(tex) {
  if (!texDataUrlCache[tex.id]) {
    const raw = await outputPathToDataUrl(tex.path);
    texDataUrlCache[tex.id] = await resizeImageDataUrl(raw, 2048);
  }
  return texDataUrlCache[tex.id];
}
function providerCfg(pid) {
  const p = state.settings.providers[pid] || {};
  const reg = IMAGE_PROVIDERS[pid] || VIDEO_PROVIDERS[pid] || {};
  return {
    apiKey: (p.apiKey || '').trim(),
    secretKey: (p.secretKey || '').trim(),
    baseUrl: ((p.baseUrl || '').trim() || reg.defaultBaseUrl || '').replace(/\/+$/, ''),
    model: p.model || reg.defaultModel,
  };
}

// ---------- 步骤切换 ----------
$$('.step').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.step').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    $('#sec-' + btn.dataset.step).classList.add('active');
  })
);

// ---------- ① 花色素材 ----------
const texDrop = $('#tex-drop');
texDrop.addEventListener('click', () => $('#tex-input').click());
$('#tex-input').addEventListener('change', (e) => addTextureFiles([...e.target.files]));
texDrop.addEventListener('dragover', (e) => { e.preventDefault(); texDrop.classList.add('drag'); });
texDrop.addEventListener('dragleave', () => texDrop.classList.remove('drag'));
texDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  texDrop.classList.remove('drag');
  addTextureFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
});

async function addTextureFiles(files) {
  if (!files.length) return;
  for (const f of files) {
    try {
      const raw = await readFileAsDataUrl(f);
      const resized = await resizeImageDataUrl(raw, 2048);
      const id = uid();
      const baseName = f.name.replace(/\.[^.]+$/, '');
      const saved = await saveDataUrl(resized, '花色素材', `${baseName}_${id}`);
      state.textures.push({ id, code: '', name: baseName, path: saved.path });
      state.settings.selectedTex.push(id);
    } catch (e) {
      toast(`「${f.name}」上传失败：${e.message}`, 'err');
    }
  }
  persist();
  renderTextures();
  renderGenControl();
  toast(`已添加 ${files.length} 个花色`, 'ok');
}

function renderTextures() {
  const wrap = $('#tex-list');
  wrap.innerHTML = '';
  for (const tex of state.textures) {
    const card = document.createElement('div');
    card.className = 'tex-card';
    card.innerHTML = `
      <img src="${esc(tex.path)}" alt="" />
      <div class="tex-form">
        <input type="text" data-k="code" placeholder="花色编号，如 L8310 BTRL" value="${esc(tex.code)}" />
        <input type="text" data-k="name" placeholder="花色名称，如 榆悦" value="${esc(tex.name)}" />
      </div>
      <div class="tex-actions"><button class="btn small ghost" data-del>删除</button></div>`;
    card.querySelectorAll('input').forEach((inp) =>
      inp.addEventListener('input', () => {
        tex[inp.dataset.k] = inp.value;
        persist();
        renderGenControl();
      })
    );
    card.querySelector('[data-del]').addEventListener('click', () => {
      if (!confirm(`删除花色「${texLabel(tex)}」？（已生成的图片不受影响）`)) return;
      state.textures = state.textures.filter((t) => t.id !== tex.id);
      state.settings.selectedTex = state.settings.selectedTex.filter((i) => i !== tex.id);
      persist();
      renderTextures();
      renderGenControl();
    });
    wrap.appendChild(card);
  }
}

// 品牌信息
$('#brand-name').value = state.settings.brandName;
$('#brand-xhs').value = state.settings.brandXhs;
$('#brand-name').addEventListener('input', (e) => { state.settings.brandName = e.target.value; persist(); });
$('#brand-xhs').addEventListener('input', (e) => { state.settings.brandXhs = e.target.value; persist(); });
$('#btn-logo-pick').addEventListener('click', () => $('#brand-logo-input').click());
$('#brand-logo-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const dataUrl = await readFileAsDataUrl(f);
  const saved = await saveDataUrl(dataUrl, '品牌', 'logo_' + uid());
  state.settings.brandLogoPath = saved.path;
  persist();
  renderLogo();
});
$('#btn-logo-clear').addEventListener('click', () => {
  state.settings.brandLogoPath = '';
  persist();
  renderLogo();
});
function renderLogo() {
  const img = $('#brand-logo-preview');
  const has = !!state.settings.brandLogoPath;
  img.hidden = !has;
  $('#btn-logo-clear').hidden = !has;
  if (has) img.src = state.settings.brandLogoPath;
}

// ---------- ② 场景与提示词 ----------
function renderScenes() {
  const wrap = $('#scene-list');
  wrap.innerHTML = '';
  for (const scene of state.prompts.scenes) {
    const def = DEFAULT_SCENES.find((d) => d.id === scene.id);
    const card = document.createElement('div');
    card.className = 'scene-card' + (scene.enabled ? '' : ' off');
    card.innerHTML = `
      <div class="scene-head">
        <label class="check" title="是否参与生成"><input type="checkbox" ${scene.enabled ? 'checked' : ''} data-en /></label>
        <input type="text" value="${esc(scene.name)}" data-name />
        ${def ? '' : '<button class="btn small ghost" data-del>删除</button>'}
      </div>
      <textarea data-prompt>${esc(scene.prompt)}</textarea>
      <div class="scene-foot">
        <span class="modified">${def && scene.prompt !== def.prompt ? '已修改' : ''}</span>
        ${def ? '<button class="btn small ghost" data-reset>恢复默认</button>' : ''}
      </div>`;
    card.querySelector('[data-en]').addEventListener('change', (e) => {
      scene.enabled = e.target.checked;
      card.classList.toggle('off', !scene.enabled);
      persist();
      renderGenControl();
    });
    card.querySelector('[data-name]').addEventListener('input', (e) => { scene.name = e.target.value; persist(); });
    card.querySelector('[data-prompt]').addEventListener('input', (e) => {
      scene.prompt = e.target.value;
      card.querySelector('.modified').textContent = def && scene.prompt !== def.prompt ? '已修改' : '';
      persist();
    });
    const resetBtn = card.querySelector('[data-reset]');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      scene.prompt = def.prompt;
      scene.name = def.name;
      persist();
      renderScenes();
    });
    const delBtn = card.querySelector('[data-del]');
    if (delBtn) delBtn.addEventListener('click', () => {
      state.prompts.scenes = state.prompts.scenes.filter((s) => s.id !== scene.id);
      persist();
      renderScenes();
      renderGenControl();
    });
    wrap.appendChild(card);
  }
}
$('#btn-scene-all').addEventListener('click', () => { state.prompts.scenes.forEach((s) => (s.enabled = true)); persist(); renderScenes(); renderGenControl(); });
$('#btn-scene-none').addEventListener('click', () => { state.prompts.scenes.forEach((s) => (s.enabled = false)); persist(); renderScenes(); renderGenControl(); });
$('#btn-scene-reset-all').addEventListener('click', () => {
  if (!confirm('把所有场景恢复为默认提示词？自定义场景会保留。')) return;
  const customs = state.prompts.scenes.filter((s) => !DEFAULT_SCENES.find((d) => d.id === s.id));
  state.prompts.scenes = DEFAULT_SCENES.map((s) => ({ ...s, enabled: true, custom: false })).concat(customs);
  persist();
  renderScenes();
  renderGenControl();
});
$('#btn-scene-add').addEventListener('click', () => {
  state.prompts.scenes.push({
    id: 'custom-' + uid(),
    name: '自定义场景',
    prompt: '将参考图中的板材花色应用到……（描述你的场景），严格保留花色原本的纹理与色泽，超写实室内实景摄影，8K画质',
    enabled: true,
    custom: true,
  });
  persist();
  renderScenes();
  renderGenControl();
});

// 多花色搭配指令编辑区（2/3/4种各一条，可恢复默认）
function renderComboInstr() {
  const wrap = $('#combo-instr-wrap');
  wrap.innerHTML = '';
  for (const n of [2, 3, 4]) {
    const div = document.createElement('div');
    div.style.marginBottom = '12px';
    div.innerHTML = `
      <h4 style="display:flex;align-items:center">${n} 种花色搭配
        <span class="modified" style="color:var(--accent);font-size:12px;margin-left:8px">${state.prompts.comboInstructions[n] !== DEFAULT_COMBO_INSTRUCTIONS[n] ? '已修改' : ''}</span>
        <button class="btn small ghost right" type="button" data-reset>恢复默认</button>
      </h4>
      <textarea rows="3" data-instr>${esc(state.prompts.comboInstructions[n])}</textarea>`;
    div.querySelector('[data-instr]').addEventListener('input', (e) => {
      state.prompts.comboInstructions[n] = e.target.value;
      div.querySelector('.modified').textContent = e.target.value !== DEFAULT_COMBO_INSTRUCTIONS[n] ? '已修改' : '';
      persist();
    });
    div.querySelector('[data-reset]').addEventListener('click', () => {
      state.prompts.comboInstructions[n] = DEFAULT_COMBO_INSTRUCTIONS[n];
      persist();
      renderComboInstr();
    });
    wrap.appendChild(div);
  }
}

$('#video-prompt').value = state.prompts.video;
$('#negative-prompt').value = state.prompts.negative;
$('#style-suffix').value = state.prompts.styleSuffix || '';
$('#video-prompt').addEventListener('input', (e) => { state.prompts.video = e.target.value; persist(); });
$('#negative-prompt').addEventListener('input', (e) => { state.prompts.negative = e.target.value; persist(); });
$('#style-suffix').addEventListener('input', (e) => { state.prompts.styleSuffix = e.target.value; persist(); });
$('#btn-video-prompt-reset').addEventListener('click', () => { state.prompts.video = DEFAULT_VIDEO_PROMPT; $('#video-prompt').value = DEFAULT_VIDEO_PROMPT; persist(); });
$('#btn-negative-reset').addEventListener('click', () => { state.prompts.negative = DEFAULT_NEGATIVE_PROMPT; $('#negative-prompt').value = DEFAULT_NEGATIVE_PROMPT; persist(); });

// ---------- ③ 平台与密钥 ----------
function renderProviderList(registry, wrapSel, settingKey) {
  const wrap = $(wrapSel);
  wrap.innerHTML = '';
  for (const p of Object.values(registry)) {
    const cfg = state.settings.providers[p.id] || {};
    const selected = state.settings[settingKey] === p.id;
    const card = document.createElement('div');
    card.className = 'provider-card' + (selected ? ' selected' : '');
    const models = (p.models || []).map((m) => `<option value="${esc(m.id)}" ${((cfg.model || p.defaultModel) === m.id) ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
    card.innerHTML = `
      <div class="provider-head">
        <input type="radio" name="${settingKey}" ${selected ? 'checked' : ''} />
        <span class="p-name">${esc(p.name)}</span>
        <span class="p-desc">${esc(p.desc || '')}</span>
        ${p.docsUrl ? `<a href="${esc(p.docsUrl)}" target="_blank">获取Key / 文档 ↗</a>` : ''}
      </div>
      ${p.id === 'mock' ? '' : `
      <div class="provider-body">
        <label>${esc(p.keyLabel || 'API Key')}
          <input type="password" data-k="apiKey" placeholder="粘贴你的 Key" value="${esc(cfg.apiKey || '')}" autocomplete="off" />
        </label>
        ${p.needsSecret ? `<label>${p.secretOptional ? 'Secret Key（旧版AK/SK方式才需要，可留空）' : 'Secret Key'}
          <input type="password" data-k="secretKey" placeholder="粘贴 Secret Key" value="${esc(cfg.secretKey || '')}" autocomplete="off" />
        </label>` : ''}
        <label>模型
          <select data-k="model">${models}</select>
        </label>
        <label>接口地址（默认官方，可填中转）
          <input type="text" data-k="baseUrl" placeholder="${esc(p.defaultBaseUrl || '')}" value="${esc(cfg.baseUrl || '')}" />
        </label>
      </div>`}`;
    card.querySelector('input[type=radio]').addEventListener('change', () => {
      state.settings[settingKey] = p.id;
      persist();
      renderProviderList(registry, wrapSel, settingKey);
      if (settingKey === 'vidProvider') renderVideoTasks(); // 任务卡上显示的平台跟随刷新
      if (settingKey === 'imgProvider') renderGenControl();
    });
    card.querySelectorAll('[data-k]').forEach((inp) =>
      inp.addEventListener('input', () => {
        state.settings.providers[p.id] = state.settings.providers[p.id] || {};
        state.settings.providers[p.id][inp.dataset.k] = inp.value;
        persist();
      })
    );
    wrap.appendChild(card);
  }
}

['img-ratio', 'vid-duration', 'concurrency', 'retries'].forEach((id) => {
  const key = { 'img-ratio': 'imgRatio', 'vid-duration': 'vidDuration', concurrency: 'concurrency', retries: 'retries' }[id];
  const el = $('#' + id);
  el.value = String(state.settings[key]);
  el.addEventListener('change', () => {
    state.settings[key] = id === 'img-ratio' ? el.value : Number(el.value);
    persist();
  });
});

$('#combo-count').value = String(state.settings.comboCount || 1);
$('#combo-count').addEventListener('change', (e) => {
  state.settings.comboCount = Number(e.target.value);
  persist();
  renderGenControl();
});

// ---------- ④ 批量生成 ----------
function comboCount() {
  return Math.min(Math.max(Number(state.settings.comboCount || 1), 1), 4);
}

function renderGenControl() {
  const chips = $('#gen-tex-chips');
  const N = comboCount();
  chips.innerHTML = '';
  for (const tex of state.textures) {
    const idx = state.settings.selectedTex.indexOf(tex.id);
    const on = idx >= 0;
    const chip = document.createElement('span');
    chip.className = 'chip' + (on ? ' on' : '');
    // 组合模式下显示选择顺序（①=主花色）
    const badge = on && N > 1 ? `<b style="color:var(--accent)">${['①','②','③','④'][idx] || idx + 1}</b> ` : '';
    chip.innerHTML = `<img src="${esc(tex.path)}" />${badge}${esc(texLabel(tex))}`;
    chip.addEventListener('click', () => {
      if (on) state.settings.selectedTex = state.settings.selectedTex.filter((i) => i !== tex.id);
      else state.settings.selectedTex.push(tex.id);
      persist();
      renderGenControl();
    });
    chips.appendChild(chip);
  }
  const nTex = state.settings.selectedTex.filter((id) => state.textures.find((t) => t.id === id)).length;
  const nScene = state.prompts.scenes.filter((s) => s.enabled).length;
  const providerName = (IMAGE_PROVIDERS[state.settings.imgProvider] || {}).name || '未选择';
  let summary, ready;
  if (!state.textures.length) {
    summary = '请先在第①步上传花色';
    ready = false;
  } else if (!nScene) {
    summary = '未勾选任何场景，请到第②步「场景与提示词」至少勾选一个场景';
    ready = false;
  } else if (N === 1) {
    summary = nTex
      ? `已选 ${nTex} 个花色 × ${nScene} 个场景 = 共 ${nTex * nScene} 张图 · 生图平台：${providerName}`
      : '点击上方花色进行勾选';
    ready = nTex > 0;
  } else {
    ready = nTex === N;
    summary = ready
      ? `组合模式：${N} 种花色搭配出图 × ${nScene} 个场景 = 共 ${nScene} 张图（①为主花色）· 生图平台：${providerName}`
      : `组合模式需要正好选择 ${N} 个花色，当前已选 ${nTex} 个（点击花色按顺序选择，先选=主花色）`;
  }
  $('#gen-summary').textContent = summary;
  $('#btn-generate').disabled = generating || !ready;
}

$('#wm-enable').checked = !!state.settings.wmEnable;
$('#wm-enable').addEventListener('change', (e) => { state.settings.wmEnable = e.target.checked; persist(); });

$('#btn-generate').addEventListener('click', startBatch);
$('#btn-stop').addEventListener('click', () => { stopFlag = true; toast('正在停止，等待进行中的任务结束…'); });

async function startBatch() {
  if (generating) return;
  const provider = IMAGE_PROVIDERS[state.settings.imgProvider];
  if (!provider) return toast('请先在第③步选择生图平台', 'err');
  const cfg = providerCfg(provider.id);
  if (provider.id !== 'mock' && !cfg.apiKey) return toast(`请先填写「${provider.name}」的 API Key`, 'err');

  // selectedTex 保持点击顺序：组合模式下 第1个=主花色
  const selTexes = state.settings.selectedTex
    .map((id) => state.textures.find((t) => t.id === id))
    .filter(Boolean);
  const scenes = state.prompts.scenes.filter((s) => s.enabled);
  const N = comboCount();
  const jobs = [];
  if (N > 1) {
    if (selTexes.length !== N) return toast(`组合模式需要正好选择 ${N} 个花色（当前 ${selTexes.length} 个）`, 'err');
    for (const scene of scenes) jobs.push({ texes: selTexes, scene });
  } else {
    for (const tex of selTexes) for (const scene of scenes) jobs.push({ texes: [tex], scene });
  }

  // 建立/复用结果条目（组合结果以 combo:id1+id2 作为分组键）
  for (const job of jobs) {
    const texKey = job.texes.length > 1 ? 'combo:' + job.texes.map((t) => t.id).join('+') : job.texes[0].id;
    const comboLabel = job.texes.length > 1 ? job.texes.map((t) => texLabel(t)).join(' ＋ ') : '';
    let r = state.results.find((x) => x.texId === texKey && x.sceneId === job.scene.id);
    if (!r) {
      r = { id: uid(), texId: texKey, sceneId: job.scene.id, sceneName: job.scene.name, status: 'pending' };
      state.results.push(r);
    }
    Object.assign(r, {
      status: 'pending', error: '', sceneName: job.scene.name, provider: provider.id,
      prompt: job.scene.prompt, texIds: job.texes.map((t) => t.id), comboLabel,
    });
    job.resultId = r.id;
  }
  persist();
  renderResults();

  generating = true;
  stopFlag = false;
  $('#btn-generate').disabled = true;
  $('#btn-stop').hidden = false;
  $('#gen-progress').hidden = false;
  let done = 0;
  const total = jobs.length;
  const setProgress = () => {
    $('#gen-progress-bar').style.width = Math.round((done / total) * 100) + '%';
    $('#gen-progress-text').textContent = `${done} / ${total}`;
  };
  setProgress();

  await runPool(
    jobs,
    async (job) => {
      const r = state.results.find((x) => x.id === job.resultId);
      if (stopFlag) {
        r.status = 'failed';
        r.error = '已取消';
        done++;
        setProgress();
        renderCell(r);
        return;
      }
      r.status = 'running';
      renderCell(r);
      const maxTry = 1 + Number(state.settings.retries || 0);
      for (let attempt = 1; attempt <= maxTry; attempt++) {
        try {
          const refDataUrls = [];
          for (const tex of job.texes) refDataUrls.push(await getTexDataUrl(tex));
          const comboInstr = job.texes.length > 1 ? (state.prompts.comboInstructions[job.texes.length] || '') + '\n' : '';
          const prompt = comboInstr + job.scene.prompt + (state.prompts.styleSuffix ? '，' + state.prompts.styleSuffix : '');
          const jobLabel = job.texes.length > 1 ? job.texes.map((t) => texLabel(t)).join(' ＋ ') : texLabel(job.texes[0]);
          const out = await provider.generate(cfg, {
            prompt,
            negativePrompt: state.prompts.negative,
            refDataUrl: refDataUrls[0],
            refDataUrls,
            ratio: state.settings.imgRatio,
            sceneName: job.scene.name,
            texLabel: jobLabel,
          });
          const dir = job.texes.length > 1
            ? `图片/组合_${job.texes.map((t) => t.code || t.name || '花色').join('+')}`
            : `图片/${texLabel(job.texes[0])}`;
          const fname = `${job.scene.name}_${uid()}`;
          let saved;
          if (out.kind === 'url') saved = await downloadRemote(out.value, dir, fname, out.headers);
          else if (out.kind === 'b64') saved = await saveBase64(out.value, out.mime || 'image/png', dir, fname);
          else saved = await saveDataUrl(out.value, dir, fname);
          r.path = saved.path;
          r.status = 'done';
          r.error = '';
          break;
        } catch (e) {
          r.error = String(e.message || e);
          r.status = attempt < maxTry && !stopFlag ? 'running' : 'failed';
          if (r.status === 'running') await sleep(1500 * attempt);
          else break;
        }
      }
      done++;
      setProgress();
      persist();
      renderCell(r);
    },
    Number(state.settings.concurrency || 2)
  );

  generating = false;
  $('#btn-stop').hidden = true;
  persist();
  setProgress();
  renderGenControl();
  const fails = jobs.filter((j) => (state.results.find((r) => r.id === j.resultId) || {}).status === 'failed').length;
  toast(fails ? `完成，其中 ${fails} 张失败（可在图上点重试）` : '全部生成完成 ✅', fails ? 'err' : 'ok');
}

// 单张重新生成
async function regenOne(resultId) {
  const r = state.results.find((x) => x.id === resultId);
  if (!r) return;
  if (generating) return toast('批量生成进行中，请等它结束后再单张重生成', 'err');
  if (r.status === 'running') return;
  // 兼容组合结果：texIds 记录了当时用到的所有花色（顺序=主花色在前）
  const texIds = r.texIds && r.texIds.length ? r.texIds : [r.texId];
  const texes = texIds.map((id) => state.textures.find((t) => t.id === id));
  if (texes.some((t) => !t)) return toast('组合中有花色已被删除，无法重新生成', 'err');
  const tex = texes[0];
  // 优先取当前场景提示词；场景被删除时回退到生成当时存下的提示词
  const scene = state.prompts.scenes.find((s) => s.id === r.sceneId);
  const scenePrompt = scene ? scene.prompt : r.prompt;
  const sceneName = scene ? scene.name : r.sceneName;
  if (!scenePrompt) {
    r.status = 'failed';
    r.error = '场景已删除，无法重新生成';
    persist();
    renderCell(r);
    return toast('对应场景已被删除，无法重新生成', 'err');
  }
  const provider = IMAGE_PROVIDERS[state.settings.imgProvider];
  const cfg = providerCfg(provider.id);
  if (provider.id !== 'mock' && !cfg.apiKey) return toast(`请先填写「${provider.name}」的 API Key`, 'err');
  generating = true;
  $('#btn-generate').disabled = true;
  r.status = 'running';
  r.error = '';
  renderCell(r);
  try {
    const refDataUrls = [];
    for (const t of texes) refDataUrls.push(await getTexDataUrl(t));
    const comboInstr = texes.length > 1 ? (state.prompts.comboInstructions[texes.length] || '') + '\n' : '';
    const prompt = comboInstr + scenePrompt + (state.prompts.styleSuffix ? '，' + state.prompts.styleSuffix : '');
    const jobLabel = texes.length > 1 ? texes.map((t) => texLabel(t)).join(' ＋ ') : texLabel(tex);
    const out = await provider.generate(cfg, {
      prompt, negativePrompt: state.prompts.negative, refDataUrl: refDataUrls[0], refDataUrls,
      ratio: state.settings.imgRatio, sceneName, texLabel: jobLabel,
    });
    const dir = texes.length > 1
      ? `图片/组合_${texes.map((t) => t.code || t.name || '花色').join('+')}`
      : `图片/${texLabel(tex)}`;
    const fname = `${sceneName}_${uid()}`;
    let saved;
    if (out.kind === 'url') saved = await downloadRemote(out.value, dir, fname, out.headers);
    else if (out.kind === 'b64') saved = await saveBase64(out.value, out.mime || 'image/png', dir, fname);
    else saved = await saveDataUrl(out.value, dir, fname);
    r.path = saved.path;
    r.status = 'done';
  } catch (e) {
    r.status = 'failed';
    r.error = String(e.message || e);
  } finally {
    generating = false;
    renderGenControl();
  }
  persist();
  renderCell(r);
}

// ---------- 结果渲染 ----------
function renderResults() {
  const wrap = $('#results');
  wrap.innerHTML = '';
  const texIds = [...new Set(state.results.map((r) => r.texId))];
  for (const texId of texIds) {
    const tex = state.textures.find((t) => t.id === texId);
    const results = state.results.filter((r) => r.texId === texId);
    const groupLabel = results[0]?.comboLabel
      ? '🎨 组合：' + results[0].comboLabel
      : tex ? texLabel(tex) : '（已删除的花色）';
    const group = document.createElement('div');
    group.className = 'result-group';
    group.dataset.texId = texId;
    const doneCount = results.filter((r) => r.status === 'done').length;
    group.innerHTML = `
      <div class="result-group-head">
        <span class="g-title">${esc(groupLabel)}</span>
        <span class="g-sub">${doneCount}/${results.length} 张完成</span>
        <span class="g-actions">
          <button class="btn small" data-zip>⬇ 下载九宫格 ZIP</button>
        </span>
      </div>
      <div class="nine-grid"></div>`;
    const grid = group.querySelector('.nine-grid');
    for (const r of results) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.resultId = r.id;
      cell.style.aspectRatio = ratioCss(state.settings.imgRatio);
      grid.appendChild(cell);
      fillCell(cell, r);
    }
    group.querySelector('[data-zip]').addEventListener('click', () => downloadGroupZip(texId));
    wrap.appendChild(group);
  }
}

function renderCell(r) {
  const cell = document.querySelector(`.cell[data-result-id="${r.id}"]`);
  if (cell) fillCell(cell, r);
  const group = document.querySelector(`.result-group[data-tex-id="${r.texId}"]`);
  if (group) {
    const results = state.results.filter((x) => x.texId === r.texId);
    group.querySelector('.g-sub').textContent = `${results.filter((x) => x.status === 'done').length}/${results.length} 张完成`;
  } else {
    renderResults();
  }
}

function fillCell(cell, r) {
  cell.classList.toggle('error', r.status === 'failed');
  if (r.status === 'done' && r.path) {
    cell.innerHTML = `
      <img src="${esc(r.path)}" loading="lazy" />
      <span class="cell-tag">${esc(r.sceneName)}</span>
      <span class="cell-actions">
        <button class="mini-btn" title="生成视频" data-act="video">🎬</button>
        <button class="mini-btn" title="重新生成" data-act="regen">🔄</button>
        <button class="mini-btn" title="下载" data-act="dl">⬇</button>
      </span>`;
    cell.querySelector('img').addEventListener('click', () => openLightbox(r.id));
    cell.querySelector('[data-act=video]').addEventListener('click', () => addVideoTaskFromResult(r.id));
    cell.querySelector('[data-act=regen]').addEventListener('click', () => regenOne(r.id));
    cell.querySelector('[data-act=dl]').addEventListener('click', () => downloadOne(r.id));
  } else if (r.status === 'running') {
    cell.innerHTML = `<div class="cell-status"><div class="spinner" style="margin:0 auto 8px"></div>${esc(r.sceneName)}<br>生成中…</div>`;
  } else if (r.status === 'failed') {
    cell.innerHTML = `<div class="cell-status">❌ ${esc(r.sceneName)}<br><span style="font-size:11px">${esc((r.error || '').slice(0, 120))}</span><br><button class="mini-btn" style="margin-top:6px" data-act="retry">重试</button></div>`;
    cell.querySelector('[data-act=retry]').addEventListener('click', () => regenOne(r.id));
  } else {
    cell.innerHTML = `<div class="cell-status">${esc(r.sceneName)}<br>排队中…</div>`;
  }
}

// 结果的展示标签：组合用组合名，单花色用花色名
function resultLabel(r) {
  if (r.comboLabel) return r.comboLabel;
  const tex = state.textures.find((t) => t.id === r.texId);
  return tex ? texLabel(tex) : '';
}

function wmOpts(labelText) {
  return {
    logoDataUrl: state.settings.brandLogoPath || '',
    brandText: state.settings.brandLogoPath ? '' : state.settings.brandName,
    xhsId: state.settings.brandXhs,
    label: labelText || '',
  };
}

// 有品牌信息或至少有花色标签可画时才走水印合成，否则原图直出
function shouldWatermark(labelText) {
  const s = state.settings;
  return s.wmEnable && (s.brandXhs || s.brandName || s.brandLogoPath || labelText);
}

function pathExt(p) {
  const m = /\.[a-z0-9]+$/i.exec(p || '');
  return m ? m[0] : '.jpg';
}

async function downloadOne(resultId) {
  const r = state.results.find((x) => x.id === resultId);
  if (!r || !r.path) return;
  const label = resultLabel(r);
  if (shouldWatermark(label)) {
    const wm = await applyWatermark(r.path, wmOpts(label));
    downloadBlob(await (await fetch(wm)).blob(), `${label || '花色'}_${r.sceneName}.jpg`);
  } else {
    await downloadPath(r.path, `${label || '花色'}_${r.sceneName}${pathExt(r.path)}`);
  }
}

async function downloadGroupZip(texId) {
  const results = state.results.filter((r) => r.texId === texId && r.status === 'done' && r.path);
  if (!results.length) return toast('该组还没有生成完成的图片', 'err');
  const label = resultLabel(results[0]);
  toast('正在打包…');
  const files = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    let data, ext;
    if (shouldWatermark(label)) {
      const wm = await applyWatermark(r.path, wmOpts(label));
      data = await dataUrlToUint8(wm);
      ext = '.jpg';
    } else {
      data = new Uint8Array(await (await fetch(r.path)).arrayBuffer());
      ext = pathExt(r.path);
    }
    files.push({ name: `${String(i + 1).padStart(2, '0')}_${r.sceneName}${ext}`, data });
  }
  const zip = makeZip(files);
  downloadBlob(zip, `${(label || '花色').replace(/ ＋ /g, '+')}_九宫格.zip`);
  toast('打包完成，已开始下载 ✅', 'ok');
}

// ---------- 灯箱 ----------
let lightboxResultId = null;
function openLightbox(resultId) {
  const r = state.results.find((x) => x.id === resultId);
  if (!r || !r.path) return;
  lightboxResultId = resultId;
  $('#lightbox-img').src = r.path;
  $('#lightbox').hidden = false;
}
$('#lb-close').addEventListener('click', () => ($('#lightbox').hidden = true));
$('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('#lightbox').hidden = true; });
$('#lb-download').addEventListener('click', async () => {
  const r = state.results.find((x) => x.id === lightboxResultId);
  if (r) await downloadPath(r.path, `${r.sceneName}${pathExt(r.path)}`);
});
$('#lb-download-wm').addEventListener('click', async () => {
  const r = state.results.find((x) => x.id === lightboxResultId);
  if (!r) return;
  const wm = await applyWatermark(r.path, wmOpts(resultLabel(r)));
  downloadBlob(await (await fetch(wm)).blob(), `${r.sceneName}_水印.jpg`);
});
$('#lb-video').addEventListener('click', () => { addVideoTaskFromResult(lightboxResultId); $('#lightbox').hidden = true; });
$('#lb-regen').addEventListener('click', () => { regenOne(lightboxResultId); $('#lightbox').hidden = true; });

// ---------- ⑤ 视频任务 ----------
function addVideoTaskFromResult(resultId) {
  const r = state.results.find((x) => x.id === resultId);
  if (!r || !r.path) return;
  state.videoTasks.push({
    id: uid(),
    sourcePath: r.path,
    label: resultLabel(r),
    sceneName: r.sceneName,
    prompt: state.prompts.video,
    status: 'idle',
    provider: state.settings.vidProvider,
  });
  persist();
  renderVideoTasks();
  $$('.step').find((b) => b.dataset.step === 'video').click();
  toast('已加入视频任务列表');
}

$('#btn-video-upload').addEventListener('click', () => $('#video-upload-input').click());
$('#video-upload-input').addEventListener('change', async (e) => {
  for (const f of [...e.target.files]) {
    const raw = await readFileAsDataUrl(f);
    const resized = await resizeImageDataUrl(raw, 2048);
    const saved = await saveDataUrl(resized, '视频源图', f.name.replace(/\.[^.]+$/, '') + '_' + uid());
    state.videoTasks.push({
      id: uid(),
      sourcePath: saved.path,
      label: f.name.replace(/\.[^.]+$/, ''),
      sceneName: '',
      prompt: state.prompts.video,
      status: 'idle',
      provider: state.settings.vidProvider,
    });
  }
  persist();
  renderVideoTasks();
});

function renderVideoTasks() {
  const wrap = $('#video-tasks');
  wrap.innerHTML = '';
  if (!state.videoTasks.length) {
    wrap.innerHTML = '<p class="hint">还没有视频任务。去第④步在图片上点「🎬」，或点上方「上传图片生成视频」。</p>';
    renderComposeClips();
    return;
  }
  for (const t of state.videoTasks) {
    const card = document.createElement('div');
    card.className = 'video-task';
    card.dataset.taskId = t.id;
    const statusText = { idle: '待开始', creating: '提交任务中…', polling: '生成中（平台排队/渲染）…', downloading: '下载视频中…', done: '✅ 已完成', failed: '❌ 失败' }[t.status] || t.status;
    const statusCls = ['creating', 'polling', 'downloading'].includes(t.status) ? 'running' : t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed' : '';
    // 未开始/失败的任务将使用「当前选中」的平台；进行中/已完成显示实际使用的平台
    const shownProvider = ['idle', 'failed'].includes(t.status) ? state.settings.vidProvider : t.provider;
    card.innerHTML = `
      <img class="vt-thumb" src="${esc(t.sourcePath)}" />
      <div class="vt-body">
        <div class="vt-meta">
          <b>${esc(t.label || '视频任务')}</b>
          ${t.sceneName ? `<span>场景：${esc(t.sceneName)}</span>` : ''}
          <span>平台：${esc((VIDEO_PROVIDERS[shownProvider] || {}).name || shownProvider)}</span>
          <span class="vt-status ${statusCls}">${statusText}${t.status === 'failed' && t.error ? '：' + esc(String(t.error).slice(0, 160)) : ''}</span>
        </div>
        <textarea rows="2" data-prompt ${['creating', 'polling', 'downloading'].includes(t.status) ? 'disabled' : ''}>${esc(t.prompt)}</textarea>
        <div class="vt-actions">
          ${t.status === 'idle' || t.status === 'failed' ? '<button class="btn small primary" data-start>▶ 开始生成</button>' : ''}
          <button class="btn small ghost" data-resetp>提示词恢复默认</button>
          ${t.videoPath ? '<button class="btn small" data-dl>⬇ 下载视频</button>' : ''}
          <button class="btn small ghost" data-del>删除</button>
        </div>
        ${t.videoPath ? `<video src="${esc(t.videoPath)}" controls preload="metadata"></video>` : ''}
      </div>`;
    card.querySelector('[data-prompt]').addEventListener('input', (e) => { t.prompt = e.target.value; persist(); });
    card.querySelector('[data-resetp]').addEventListener('click', () => {
      t.prompt = state.prompts.video;
      card.querySelector('[data-prompt]').value = t.prompt;
      persist();
    });
    const startBtn = card.querySelector('[data-start]');
    if (startBtn) startBtn.addEventListener('click', () => runVideoTask(t.id));
    const dlBtn = card.querySelector('[data-dl]');
    if (dlBtn) dlBtn.addEventListener('click', () => downloadPath(t.videoPath, `${t.label || '视频'}_${t.sceneName || ''}.mp4`));
    card.querySelector('[data-del]').addEventListener('click', () => {
      if (!confirm('删除这个视频任务？')) return;
      state.videoTasks = state.videoTasks.filter((x) => x.id !== t.id);
      persist();
      renderVideoTasks();
    });
    wrap.appendChild(card);
  }
  renderComposeClips();
}

async function runVideoTask(taskId) {
  const t = state.videoTasks.find((x) => x.id === taskId);
  if (!t) return;
  const provider = VIDEO_PROVIDERS[state.settings.vidProvider];
  if (!provider) return toast('请先在第③步选择生视频平台', 'err');
  const cfg = providerCfg(provider.id);
  if (provider.id !== 'mock' && !cfg.apiKey) return toast(`请先填写「${provider.name}」的 API Key`, 'err');
  t.provider = provider.id;
  t.status = 'creating';
  t.error = '';
  persist();
  renderVideoTasks();
  try {
    const imageDataUrl = await resizeImageDataUrl(await outputPathToDataUrl(t.sourcePath), 1920);
    const ref = await provider.create(cfg, {
      prompt: t.prompt,
      negativePrompt: state.prompts.negative,
      imageDataUrl,
      imagePath: t.sourcePath,
      duration: Number(state.settings.vidDuration || 5),
      ratio: state.settings.imgRatio,
    });
    if (ref && ref.immediatePath) {
      t.videoPath = ref.immediatePath;
      t.status = 'done';
      persist();
      renderVideoTasks();
      return;
    }
    t.taskRef = ref;
    t.status = 'polling';
    persist();
    renderVideoTasks();
    await pollVideoTask(t, provider, cfg);
  } catch (e) {
    t.status = 'failed';
    t.error = String(e.message || e);
    persist();
    renderVideoTasks();
  }
}

async function pollVideoTask(t, provider, cfg) {
  const interval = provider.pollInterval || 8000;
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    let s;
    try {
      s = await provider.poll(cfg, t.taskRef);
    } catch (e) {
      // 轮询偶发失败不致命，继续
      continue;
    }
    if (s.status === 'done') {
      t.status = 'downloading';
      persist();
      renderVideoTasks();
      const saved = await downloadRemote(s.videoUrl, '视频', `${t.label || '视频'}_${t.sceneName || ''}_${uid()}`, s.headers);
      t.videoPath = saved.path;
      t.status = 'done';
      persist();
      renderVideoTasks();
      toast('视频生成完成 ✅', 'ok');
      return;
    }
    if (s.status === 'failed') {
      t.status = 'failed';
      t.error = s.error || '平台生成失败';
      persist();
      renderVideoTasks();
      return;
    }
  }
  t.status = 'failed';
  t.error = '等待超时（30分钟）';
  persist();
  renderVideoTasks();
}

// 刷新后恢复未完成的轮询
async function resumePendingVideoTasks() {
  for (const t of state.videoTasks) {
    if (['creating', 'downloading'].includes(t.status)) {
      t.status = 'failed';
      t.error = '页面刷新中断，请重新开始';
    } else if (t.status === 'polling' && t.taskRef) {
      const provider = VIDEO_PROVIDERS[t.provider];
      if (provider && provider.poll) {
        const cfg = providerCfg(provider.id);
        pollVideoTask(t, provider, cfg).catch((e) => {
          t.status = 'failed';
          t.error = String((e && e.message) || e);
          persist();
          renderVideoTasks();
        });
      } else {
        t.status = 'failed';
        t.error = '页面刷新中断，请重新开始';
      }
    }
  }
  // 图片任务无法恢复
  for (const r of state.results) {
    if (r.status === 'running' || r.status === 'pending') {
      r.status = 'failed';
      r.error = '页面刷新中断，请点击重试';
    }
  }
  persist();
}

// ---------- 成片合成 ----------
let composeOrder = [];
function renderComposeClips() {
  const wrap = $('#compose-clips');
  const doneTasks = state.videoTasks.filter((t) => t.status === 'done' && t.videoPath);
  composeOrder = composeOrder.filter((id) => doneTasks.find((t) => t.id === id));
  if (!doneTasks.length) {
    wrap.innerHTML = '<p class="hint">先在上方生成视频片段，完成后可在这里勾选合成</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const t of doneTasks) {
    const idx = composeOrder.indexOf(t.id);
    const div = document.createElement('div');
    div.className = 'clip-pick' + (idx >= 0 ? ' on' : '');
    div.innerHTML = `
      ${idx >= 0 ? `<span class="order">${idx + 1}</span>` : ''}
      <img src="${esc(t.sourcePath)}" />
      <div class="clip-name">${esc(t.label || '片段')}${t.sceneName ? ' · ' + esc(t.sceneName) : ''}</div>`;
    div.addEventListener('click', () => {
      const i = composeOrder.indexOf(t.id);
      if (i >= 0) composeOrder.splice(i, 1);
      else composeOrder.push(t.id);
      renderComposeClips();
    });
    wrap.appendChild(div);
  }
}

function setBgm(path, displayName) {
  state.settings.bgmPath = path || '';
  persist();
  $('#bgm-name').textContent = displayName || '';
  $('#btn-bgm-clear').hidden = !path;
  const audio = $('#bgm-preview');
  if (path) {
    audio.src = path;
    audio.hidden = false;
  } else {
    audio.pause();
    audio.removeAttribute('src');
    audio.hidden = true;
  }
}

$('#btn-bgm-random').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/bgm-list');
    const d = await r.json();
    if (!d.files || !d.files.length) {
      return toast('曲库为空：把 mp3 放进 output/BGM 文件夹即可使用随机配乐', 'err');
    }
    // 随机换一首（避免连续抽到同一首）
    let pick;
    do {
      pick = d.files[Math.floor(Math.random() * d.files.length)];
    } while (d.files.length > 1 && pick.path === state.settings.bgmPath);
    setBgm(pick.path, '🎲 ' + pick.name.replace(/\.[^.]+$/, ''));
  } catch (e) {
    toast('读取曲库失败：' + (e.message || e), 'err');
  }
});

$('#btn-bgm-pick').addEventListener('click', () => $('#compose-bgm-input').click());
$('#compose-bgm-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const dataUrl = await readFileAsDataUrl(f);
  const saved = await saveDataUrl(dataUrl, 'BGM', f.name.replace(/\.[^.]+$/, '') + '_' + uid());
  setBgm(saved.path, f.name);
});
$('#btn-bgm-clear').addEventListener('click', () => setBgm('', ''));

$('#btn-compose').addEventListener('click', async () => {
  const tasks = composeOrder.map((id) => state.videoTasks.find((t) => t.id === id)).filter(Boolean);
  if (!tasks.length) return toast('请先勾选要拼接的视频片段', 'err');
  const [w, h] = $('#compose-size').value.split('x').map(Number);
  $('#btn-compose').disabled = true;
  $('#compose-progress').hidden = false;
  $('#compose-result').innerHTML = '';
  try {
    const title = $('#compose-title').value.trim();
    const lines = $('#compose-lines').value.split('\n').map((s) => s.trim()).filter(Boolean);
    let titlePngDataUrl = null;
    if (title) {
      titlePngDataUrl = await drawTitleCard({
        width: w, height: h,
        bgUrl: tasks[0].sourcePath,
        title,
        subtitle: $('#compose-sub').value.trim(),
        lines,
        brandText: state.settings.brandName,
      });
    }
    const clips = tasks.map((t) => ({
      path: t.videoPath,
      labelPngDataUrl: drawLabelOverlay({
        width: w, height: h,
        heading: '应用效果图展示',
        label: t.label || '',
      }),
    }));
    const r = await api('/api/compose', {
      width: w, height: h,
      titlePngDataUrl,
      titleDuration: 3,
      clips,
      bgmPath: state.settings.bgmPath || undefined,
      outName: `宣传成片_${new Date().toISOString().slice(0, 10)}_${uid().slice(-4)}`,
    });
    $('#compose-result').innerHTML = `
      <video src="${esc(r.path)}" controls></video>
      <div style="margin-top:8px"><button class="btn" id="btn-compose-dl">⬇ 下载成片</button></div>`;
    $('#btn-compose-dl').addEventListener('click', () => downloadPath(r.path, '宣传成片.mp4'));
    toast('成片合成完成 ✅', 'ok');
  } catch (e) {
    toast('合成失败：' + (e.message || e), 'err');
  } finally {
    $('#btn-compose').disabled = false;
    $('#compose-progress').hidden = true;
  }
});

// ---------- 其他 ----------
$('#btn-open-output').addEventListener('click', () => fetch('/api/open-output'));

async function checkHealth() {
  const el = $('#server-status');
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    el.textContent = d.ffmpeg ? '● 服务正常' : '● 服务正常（未装ffmpeg，演示视频/成片不可用）';
    el.className = 'status-dot ok';
  } catch {
    el.textContent = '● 无法连接本地服务';
    el.className = 'status-dot err';
  }
}

// ---------- 启动 ----------
function init() {
  // 若缓存里存的平台已被移除（如只保留Google后），回退到当前可用的平台
  if (!IMAGE_PROVIDERS[state.settings.imgProvider]) {
    state.settings.imgProvider = IMAGE_PROVIDERS.gemini ? 'gemini' : Object.keys(IMAGE_PROVIDERS)[0];
  }
  if (!VIDEO_PROVIDERS[state.settings.vidProvider]) {
    state.settings.vidProvider = VIDEO_PROVIDERS.veo ? 'veo' : Object.keys(VIDEO_PROVIDERS)[0];
  }
  renderTextures();
  renderLogo();
  renderComboInstr();
  if (state.settings.bgmPath) {
    setBgm(state.settings.bgmPath, decodeURIComponent(state.settings.bgmPath.split('/').pop() || '已选择音乐'));
  }
  renderScenes();
  renderProviderList(IMAGE_PROVIDERS, '#img-provider-list', 'imgProvider');
  renderProviderList(VIDEO_PROVIDERS, '#vid-provider-list', 'vidProvider');
  renderGenControl();
  renderResults();
  renderVideoTasks();
  resumePendingVideoTasks();
  checkHealth();
}
init();
