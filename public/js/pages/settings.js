// 设置页：仅后端连接（本地 localStorage 存连接信息，/api/save 写数据需 API Key）
// 2026-09-08 合并精简：持仓管理（添加/费率/日限/买入增删/删基金）已全部迁入「持仓」页，
// 关注池为死功能已整体删除。本页只保留后端连接面板。
import * as store from '../store.js';
import * as api from '../api.js';
import { el } from '../util.js';

export async function render(root) {
  root.innerHTML = '';
  root.appendChild(connectionPanel());
}

/* ---------- 后端连接 ---------- */
function connectionPanel() {
  const p = el('div', { class: 'panel' });
  p.appendChild(el('div', { class: 'panel-head' }, [el('span', { text: '后端连接' })]));
  // App 内 location.origin 是 http://localhost（指向手机自己），不能当默认值预填
  const native = api.isNativeApp();
  const url = el('input', {
    class: 'input', id: 'setUrl',
    value: store.getBackendUrl() || (native ? '' : location.origin),
    placeholder: 'http://192.168.x.x:3000',
  });
  const key = el('input', { class: 'input', id: 'setKey', value: store.getApiKey(), placeholder: 'API Key（写入数据时需要）', type: 'password' });
  p.appendChild(field('后端地址', url));
  p.appendChild(field('API Key', key));
  const msg = el('div', { class: 'hint', id: 'connMsg', style: 'margin-top:6px' });
  const testBtn = el('button', { class: 'btn', text: '测试连接' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '保存连接' });
  testBtn.addEventListener('click', async () => {
    store.updateSettings({ backendUrl: url.value.trim(), apiKey: key.value.trim() });
    msg.textContent = '测试中…';
    try { await api.getState(); msg.className = 'hint'; msg.style.color = 'var(--down)'; msg.textContent = '✓ 连接成功'; }
    catch (e) { msg.className = 'hint'; msg.style.color = 'var(--up)'; msg.textContent = '✗ ' + e.message; }
  });
  saveBtn.addEventListener('click', () => {
    store.updateSettings({ backendUrl: url.value.trim(), apiKey: key.value.trim() });
    msg.className = 'hint'; msg.style.color = 'var(--accent-soft)'; msg.textContent = '已保存到本机（仅存于此浏览器）。';
  });
  p.appendChild(el('div', { class: 'btn-row' }, [testBtn, saveBtn]));
  p.appendChild(msg);
  const tip = native
    ? 'App 版必须填电脑的局域网地址 http://<电脑IP>:3000（App 里的 localhost 指的是手机自己，填了连不上）。电脑上开 cmd 跑 ipconfig，看「无线局域网适配器 WLAN → IPv4 地址」。换了 Wi-Fi 只需回来改这一行，不用重装 App。'
    : '留空=自动用当前打开地址（手机浏览器/电脑都正确，推荐）。手机装了 App 版时，需在 App 里手动填电脑局域网地址 http://<电脑IP>:3000。';
  p.appendChild(el('div', { class: 'hint', style: 'margin-top:8px', text: tip + ' 读数据无需 Key；增删持仓需 Key（电脑端环境变量 FUND_API_KEY，或 config.json 的 apiKey）。' }));
  return p;
}

function field(label, input) {
  return el('div', { class: 'field' }, [el('label', { text: label }), input]);
}
