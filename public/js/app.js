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
        <span style="flex-basis:100%;height:0;margin:0"></span>
        <label class="import-box" id="import-box">
          📦 导入方案包（.zip，自包含；创建为独立新方案）
          <input type="file" id="import-input" accept=".zip,application/zip" hidden />
        </label>
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

  const importInput = document.getElementById('import-input');
  document.getElementById('import-box').addEventListener('click', (e) => {
    if (e.target.tagName !== 'INPUT') importInput.click();
  });
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append('package', file, file.name);
      const { data, status } = await api.importPackage(fd);
      if (status === 201) {
        toast(`已导入为独立新方案「${data.project.name}」（${data.sherds.length} 片陶片、${data.seams.length} 条接缝）`, 'success');
        location.hash = `#/project/${data.project.id}`;
      }
    } catch (e) {
      showImportError(e);
    }
  });
}

// 导入失败：损坏/不合法整包拒绝。逐条列出清单/照片/路径问题或闭合环超差，
// 并明确“未创建任何方案”。
function showImportError(err) {
  const info = err.data && err.data.error;
  const issues = info && Array.isArray(info.issues) ? info.issues : [];
  const isCycle = info && info.reason === 'import_cycle_tolerance_exceeded';
  const detail = issues.length
    ? `<div class="import-issues">${issues.slice(0, 50).map((it) => {
      if (it.tolerance_mm !== undefined) {
        return `<div class="imp-it">🔗 接缝 #${it.seam_seq}（陶片 ${it.from_seq}→${it.to_seq}）闭合残差 `
          + `${it.deviation_mm} mm / ${it.rotation_deg}°，超过容差 ${it.tolerance_mm} mm，整包拒绝。</div>`;
      }
      return `<div class="imp-it">${esc(it.path ? `[${it.path}] ` : '')}${esc(it.message)}</div>`;
    }).join('')}${issues.length > 50 ? `<div class="kv">其余 ${issues.length - 50} 项从略。</div>` : ''}</div>`
    : '';
  const { body } = openModal({ title: isCycle ? '🚫 导入被拒绝：闭合环超容差' : '🚫 方案包不合法，整包拒绝' });
  body.innerHTML = `
    <div class="conflict-box">
      <div>${esc(info ? info.message : err.message)}</div>
      ${detail}
      <div class="kv" style="margin-top:8px">未创建任何方案，也不会留下照片文件。请在源工作台核对后重新导出。</div>
    </div>
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
