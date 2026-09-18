// 更多页：手机底部「更多」入口，列出侧栏中未直接展示的页面
import { el } from '../util.js';

const ITEMS = [
  { page: 'allocation', label: '配置', desc: '组合构成' },
  { page: 'review', label: '复盘', desc: '每日/每月' },
  { page: 'settings', label: '设置', desc: '后端连接' },
];

export async function render(root) {
  root.innerHTML = '';
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-head' }, [el('span', { text: '更多' })]));
  const stack = el('div', { class: 'stack' });
  ITEMS.forEach(it => {
    const btn = el('div', { class: 'card', style: 'padding:16px 18px;cursor:pointer' }, [
      el('div', {}, [el('div', { style: 'font-weight:600', text: it.label }), el('div', { class: 'hint', text: it.desc })]),
    ]);
    btn.addEventListener('click', () => { location.hash = '/' + it.page; });
    stack.appendChild(btn);
  });
  panel.appendChild(stack);
  root.appendChild(panel);
}
