import { api } from './api.js';
import { esc, toast, openModal } from './ui.js';
import { mountWorkspace } from './workspace.js';

async function renderHome() {
  const view = document.getElementById('view');
  const projects = await api.listProjects();
  view.innerHTML = `
    <div class="home-wrap">
      <h1>考古陶片拼接方案</h1>
      <p class="kv">在同一方案中上传陶片照片、标定毫米比例尺，并以“接缝”记录片间旋转、平移与断口说明。画布按已采纳接缝拼出连通组；成环超差会被拒绝。</p>

      <div class="new-project">
        <label class="field">方案名称
          <input type="text" id="np-name" placeholder="例如：2026 秋 · H3 灰陶罐" />
        </label>
        <label class="field">闭合环毫米容差
          <input type="number" id="np-tol" min="0.01" step="0.1" value="2" />
        </label>
        <button id="np-create">新建方案</button>
        <button class="secondary" id="np-import">📥 导入方案包 (.zip)</button>
        <input type="file" id="np-import-file" accept=".zip,application/zip" hidden />
      </div>

      <table class="list">
        <thead><tr><th>ID</th><th>名称</th><th>容差</th><th>版本</th><th>更新时间</th><th></th></tr></thead>
        <tbody>
          ${projects.map((p) => `
            <tr>
              <td>${p.id}</td>
              <td><a href="#/project/${p.id}">${esc(p.name)}</a></td>
              <td>${p.tolerance_mm} mm</td>
              <td>v${p.version}</td>
              <td>${esc(p.updated_at)}</td>
              <td><a href="#/project/${p.id}">进入</a></td>
            </tr>`).join('') ||
            '<tr><td colspan="6" class="kv" style="text-align:center;padding:24px">还没有方案，先新建一个。</td></tr>'}
        </tbody>
      </table>
    </div>`;

  document.getElementById('topbar-right').innerHTML = '';
  document.getElementById('np-create').onclick = async () => {
    const name = document.getElementById('np-name').value.trim() || `方案 ${new Date().toLocaleString()}`;
    const tol = parseFloat(document.getElementById('np-tol').value);
    if (!(tol > 0)) return toast('容差必须是正数（毫米）', 'error');
    const state = await api.createProject(name, tol);
    location.hash = `#/project/${state.project.id}`;
  };

  // 导入另一台工作台导出的自包含方案包：成功后进入新创建的独立方案。
  const importFile = document.getElementById('np-import-file');
  document.getElementById('np-import').onclick = () => importFile.click();
  importFile.addEventListener('change', async () => {
    const file = importFile.files[0];
    importFile.value = '';
    if (!file) return;
    try {
      const state = await api.importPackage(file);
      toast(`方案包已导入为独立新方案「${state.project.name}」：${state.imported_from.sherd_count} 片陶片、${state.imported_from.seam_count} 条接缝`, 'success');
      location.hash = `#/project/${state.project.id}`;
    } catch (e) {
      showImportError(e);
    }
  });
}

// 方案包导入失败：把服务器给出的逐条校验原因列出（整包拒绝，未创建任何方案）。
function showImportError(err) {
  const info = err.data && err.data.error;
  const lines = (info && info.errors) ? info.errors : [];
  const msg = (info && info.message) || err.message;
  const { body } = openModal({ title: '📦 方案包被拒绝', wide: lines.length > 4 });
  body.innerHTML = `
    <div class="conflict-box">
      <div>${esc(msg)}</div>
      ${lines.length ? `<ul style="margin:8px 0 0 18px">${lines.slice(0, 50).map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
    </div>
    <div class="kv" style="margin-top:8px">整包未通过校验，未创建方案，也不会留下照片文件。请修正后重新选择方案包。</div>
    <div class="actions"><button id="imp-ok">知道了</button></div>`;
  body.querySelector('#imp-ok').onclick = () => body.closest('.modal-mask').remove();
}

async function route() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/project\/(\d+)/);
  if (m) {
    try {
      await mountWorkspace(parseInt(m[1], 10));
    } catch (e) {
      const view = document.getElementById('view');
      view.innerHTML = `<div class="home-wrap"><div class="conflict-box">加载方案失败：${esc(e.message)}</div>
        <a href="#/">← 返回方案列表</a></div>`;
    }
  } else {
    await renderHome();
  }
}

window.addEventListener('hashchange', route);
route();
