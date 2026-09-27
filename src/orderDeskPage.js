// 复制订单结算台操作页:开单试算、备料检查、生产填报、复核、收款结清与账本视图
import { SIZE_TABLE, ORDER_STAGES } from "./orderPricing.js";

const sizes = Object.keys(SIZE_TABLE);

export function orderDeskPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>复制订单结算台 · 古法蓝晒底片整理室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .nav { display:flex; gap:14px; align-items:center; } .nav a { color:var(--accent); font-weight:700; text-decoration:none; }
    .check { display:flex; align-items:center; gap:8px; color:var(--ink); } .check input { width:auto; }
    .quote { background:#f6f8f4; border:1px dashed var(--line); border-radius:6px; padding:10px; margin:12px 0; font-size:13px; line-height:1.7; }
    .row { display:flex; gap:8px; margin:6px 0 12px; } .row input { flex:1; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    .prodform { display:grid; gap:4px; border-top:1px dashed var(--line); padding-top:8px; }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { border-bottom:1px solid var(--line); padding:6px 8px; text-align:left; } th { color:var(--muted); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>复制订单结算台</h1><div class="meta">开单计价、备料检查、生产填报、复核与尾款结清</div></div>
    <div class="nav"><a href="/">底片整理室</a><button id="reload">刷新</button></div>
  </header>
  <main>
    <section>
      <form id="orderForm">
        <h2>新增复制订单</h2>
        <label>母版(底片)</label><select name="masterCode" id="masterSelect" required></select>
        <label>成品尺寸</label><select name="size" id="sizeSelect">${sizes.map(s => "<option>" + s + "</option>").join("")}</select>
        <label>数量</label><input name="quantity" type="number" min="1" value="1" required>
        <label class="check"><input type="checkbox" name="rush"> 加急订单(加急费另计)</label>
        <div class="quote" id="quoteBox">选择尺寸与数量后自动试算</div>
        <button>开单</button>
      </form>
      <div class="panel" style="margin-top:14px"><h2>物料库存</h2><div id="materials"></div></div>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部状态</option>${ORDER_STAGES.map(s => "<option>" + s + "</option>").join("")}</select>
        <input id="search" placeholder="搜索订单号或母版">
      </div>
      <div class="grid" id="orders"></div>
      <div class="panel" style="margin-top:14px"><h2>成本账本</h2><div id="ledger"></div></div>
    </section>
  </main>
  <script>
    const stages = ${JSON.stringify(ORDER_STAGES)};
    let items = [], orders = [], materials = null, ledger = [];
    const statsEl = document.querySelector('#stats');
    const ordersEl = document.querySelector('#orders');
    const orderForm = document.querySelector('#orderForm');
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { 'Content-Type': 'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function money(n) { return '¥' + Number(n || 0).toFixed(2); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    async function load() {
      const results = await Promise.all([api('/api/items'), api('/api/orders'), api('/api/materials'), api('/api/ledger')]);
      items = results[0]; orders = results[1]; materials = results[2]; ledger = results[3];
      renderMasters(); renderMaterials(); renderOrders(); renderLedger(); refreshQuote();
    }
    function renderMasters() {
      const sel = document.querySelector('#masterSelect');
      const current = sel.value;
      sel.innerHTML = items.map(function (it) {
        return '<option value="' + esc(it.code || it.id) + '">' + esc(it.code || it.id) + ' · ' + esc(it.plateSize || '') + ' · ' + esc(it.status || '') + '</option>';
      }).join('');
      if (current) sel.value = current;
    }
    function renderMaterials() {
      const el = document.querySelector('#materials');
      let out = '<div><b>蓝晒药液</b> ' + materials.chemical.stock + ' ml <span class="meta">成本 ' + materials.chemical.unitCost + ' 元/ml</span></div>';
      out += '<div class="row"><input type="number" min="1" id="chemAdd" placeholder="补充药液 ml"><button data-rep="chemical">补充药液</button></div>';
      out += Object.keys(materials.papers).map(function (size) {
        const p = materials.papers[size];
        return '<div><b>' + size + ' 纸张</b> ' + p.stock + ' 张 <span class="meta">成本 ' + p.unitCost + ' 元/张</span></div>'
          + '<div class="row"><input type="number" min="1" placeholder="补充张数" data-paper="' + size + '"><button data-rep="paper" data-size="' + size + '">补充纸张</button></div>';
      }).join('');
      el.innerHTML = out;
      el.querySelectorAll('[data-rep]').forEach(function (btn) {
        btn.onclick = async function () {
          const kind = btn.dataset.rep;
          const input = kind === 'chemical' ? document.querySelector('#chemAdd') : el.querySelector('input[data-paper="' + btn.dataset.size + '"]');
          const amount = Number(input.value);
          if (!amount || amount <= 0) return alert('请输入补充数量');
          try {
            await api('/api/materials/replenish', { method: 'POST', body: JSON.stringify({ kind: kind, size: btn.dataset.size, amount: amount }) });
            await load();
          } catch (e) { alert(e.message); }
        };
      });
    }
    function renderOrders() {
      statsEl.innerHTML = stages.map(function (s) {
        return '<div class="stat"><span>' + s + '</span><strong>' + orders.filter(function (o) { return o.status === s; }).length + '</strong></div>';
      }).join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = orders.filter(function (o) { return (!status || o.status === status) && (!q || (o.id + o.masterCode).includes(q)); });
      ordersEl.innerHTML = visible.map(cardHtml).join('') || '<div class="panel meta">暂无订单</div>';
      ordersEl.querySelectorAll('[data-act]').forEach(function (btn) { btn.onclick = function () { handleAct(btn); }; });
    }
    function cardHtml(o) {
      const a = o.account;
      const parts = [];
      parts.push('<h3>' + o.id + (o.rush ? ' <span class="warn">加急</span>' : '') + '</h3>');
      parts.push('<span class="pill">' + o.status + '</span>');
      parts.push('<div class="meta">母版 ' + esc(o.masterCode) + ' · ' + esc(o.size) + ' × ' + o.quantity + '</div>');
      parts.push('<div>基础价 ' + money(a.base) + ' + 加急 ' + money(a.rushFee) + ' + 返工 ' + money(a.reworkFee) + ' = <b>应收 ' + money(a.total) + '</b></div>');
      parts.push('<div class="meta">成本:药液 ' + money(a.chemCost) + ' + 纸张 ' + money(a.paperCost) + ' = ' + money(a.costTotal)
        + ' · 已收 ' + money(a.paid) + ' · <span class="' + (a.due > 0 ? 'warn' : '') + '">尾款 ' + money(a.due) + '</span></div>');
      if (o.status === '待备料' && o.shortage && o.shortage.length) parts.push('<div class="warn">待备料:' + o.shortage.join(';') + '(母版未占用)</div>');
      if (o.status === '待出库' && o.retained) parts.push('<div class="meta">成品留存中,尾款结清后出库</div>');
      (o.rounds || []).forEach(function (r, i) {
        parts.push('<div class="meta">第' + (i + 1) + '次生产:成品 ' + r.good + ' · 废片 ' + r.waste + ' · 药液 ' + r.chemUsed + 'ml · 纸 ' + r.paperUsed + ' 张</div>');
      });
      const acts = [];
      if (o.status === '待备料') acts.push('<button data-act="recheck" data-id="' + o.id + '">重新备料检查</button>');
      if (o.status === '待生产' || o.status === '生产中') acts.push('<button data-act="prod" data-id="' + o.id + '">填写生产记录</button>');
      if (o.status === '待复核') {
        acts.push('<button data-act="pass" data-id="' + o.id + '">复核通过</button>');
        acts.push('<button class="secondary" data-act="rework" data-id="' + o.id + '">退回返工</button>');
      }
      if (['待生产', '生产中', '待复核', '待出库'].indexOf(o.status) >= 0) acts.push('<button class="secondary" data-act="pay" data-id="' + o.id + '">登记收款</button>');
      if (o.status === '待出库') acts.push('<button data-act="settle" data-id="' + o.id + '">结清出库</button>');
      if (o.status !== '已结清' && o.status !== '已取消') acts.push('<button class="secondary" data-act="cancel" data-id="' + o.id + '">取消订单</button>');
      if (acts.length) parts.push('<div class="actions">' + acts.join('') + '</div>');
      if (o.status === '待生产' || o.status === '生产中') {
        parts.push('<div class="prodform" id="prod-' + o.id + '" style="display:none">'
          + '<label>成品数</label><input type="number" min="0" value="' + o.quantity + '" data-f="good">'
          + '<label>废片数</label><input type="number" min="0" value="0" data-f="waste">'
          + '<label>实际药液用量(ml)</label><input type="number" min="0" value="' + o.estimate.chemMl + '" data-f="chemUsed">'
          + '<label>实际纸张用量(张)</label><input type="number" min="0" value="' + o.estimate.paperSheets + '" data-f="paperUsed">'
          + '<button data-act="prodSubmit" data-id="' + o.id + '">提交生产记录</button></div>');
      }
      const logs = (o.logs || []).slice(-4).map(function (l) { return '<div>' + l.step + ':' + esc(l.note) + '</div>'; }).join('');
      parts.push('<div class="logs meta">' + (logs || '暂无记录') + '</div>');
      return '<article class="card">' + parts.join('') + '</article>';
    }
    async function handleAct(btn) {
      const id = btn.dataset.id, act = btn.dataset.act;
      try {
        if (act === 'prod') {
          const f = document.querySelector('#prod-' + id);
          f.style.display = f.style.display === 'none' ? 'grid' : 'none';
          return;
        }
        if (act === 'recheck') await api('/api/orders/' + id + '/recheck', { method: 'POST' });
        else if (act === 'prodSubmit') {
          const f = document.querySelector('#prod-' + id);
          const val = function (k) { return Number(f.querySelector('input[data-f="' + k + '"]').value); };
          await api('/api/orders/' + id + '/production', { method: 'POST', body: JSON.stringify({ good: val('good'), waste: val('waste'), chemUsed: val('chemUsed'), paperUsed: val('paperUsed') }) });
        }
        else if (act === 'pass') await api('/api/orders/' + id + '/review', { method: 'POST', body: JSON.stringify({ decision: '通过' }) });
        else if (act === 'rework') await api('/api/orders/' + id + '/review', { method: 'POST', body: JSON.stringify({ decision: '返工' }) });
        else if (act === 'pay') {
          const amount = Number(prompt('收款金额(元)'));
          if (!amount || amount <= 0) return;
          await api('/api/orders/' + id + '/payments', { method: 'POST', body: JSON.stringify({ amount: amount, label: '尾款' }) });
        }
        else if (act === 'settle') await api('/api/orders/' + id + '/settle', { method: 'POST' });
        else if (act === 'cancel') {
          if (!confirm('确认取消该订单?')) return;
          await api('/api/orders/' + id + '/cancel', { method: 'POST' });
        }
        await load();
      } catch (e) { alert(e.message); }
    }
    function renderLedger() {
      const rows = ledger.slice(0, 20).map(function (e) {
        return '<tr><td class="meta">' + e.at.slice(0, 16).replace('T', ' ') + '</td><td>' + e.orderId + '</td><td>' + e.kind + '</td><td>' + esc(e.label) + '</td><td>' + money(e.amount) + '</td></tr>';
      }).join('');
      document.querySelector('#ledger').innerHTML = rows
        ? '<table><thead><tr><th>时间</th><th>订单</th><th>类目</th><th>说明</th><th>金额</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="meta">暂无账目</div>';
    }
    async function refreshQuote() {
      const size = orderForm.querySelector('[name=size]').value;
      const quantity = Number(orderForm.querySelector('[name=quantity]').value);
      const rush = orderForm.querySelector('[name=rush]').checked;
      const box = document.querySelector('#quoteBox');
      if (!quantity) { box.textContent = '选择尺寸与数量后自动试算'; return; }
      try {
        const q = await api('/api/orders/quote', { method: 'POST', body: JSON.stringify({ size: size, quantity: quantity, rush: rush }) });
        box.innerHTML = '基础价 ' + money(q.basePrice) + '(' + q.unitPrice + ' 元/张 × ' + quantity + ')'
          + '<br>加急费 ' + money(q.rushFee) + ' · 返工费发生时另计'
          + '<br><b>预计应收 ' + money(q.total) + '</b>'
          + '<br>预计用药 ' + q.estimate.chemMl + ' ml · 用纸 ' + q.estimate.paperSheets + ' 张'
          + (q.shortage.length ? '<br><span class="warn">备料不足:' + q.shortage.join(';') + ',开单后停在待备料,母版暂不占用</span>' : '<br>备料充足,开单即占用母版');
      } catch (e) { box.textContent = e.message; }
    }
    orderForm.onsubmit = async function (event) {
      event.preventDefault();
      const payload = {
        masterCode: orderForm.querySelector('[name=masterCode]').value,
        size: orderForm.querySelector('[name=size]').value,
        quantity: Number(orderForm.querySelector('[name=quantity]').value),
        rush: orderForm.querySelector('[name=rush]').checked
      };
      try {
        await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
        orderForm.reset();
        await load();
      } catch (e) { alert(e.message); }
    };
    orderForm.querySelector('[name=size]').onchange = refreshQuote;
    orderForm.querySelector('[name=quantity]').oninput = refreshQuote;
    orderForm.querySelector('[name=rush]').onchange = refreshQuote;
    document.querySelector('#statusFilter').onchange = renderOrders;
    document.querySelector('#search').oninput = renderOrders;
    document.querySelector('#reload').onclick = load;
    load();
  </script>
</body>
</html>`;
}
