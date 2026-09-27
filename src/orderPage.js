// 操作页：复制订单结算台的页面与交互（开单、备料、生产、复核、收款、出库、账本）
import { SIZES, ORDER_STAGES, WASTE_LIMIT } from "./orderCalc.js";

export function orderPage() {
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
    input[type=checkbox] { width:auto; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:6px; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { border-bottom:1px solid var(--line); padding:6px 8px; text-align:left; }
    .inv { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>复制订单结算台</h1><div class="meta">开单报价、备料检查、生产登记、收款出库与每单成本</div></div>
    <div><a class="pill" href="/" style="text-decoration:none;color:inherit">底片整理室</a> <button id="reload">刷新</button></div>
  </header>
  <main>
    <section>
      <form id="createForm">
        <h2>新建复制订单</h2>
        <label>母版（同一母版同时只保留一张未结束订单）</label><select name="masterCode" id="masterSelect"></select>
        <label>成品尺寸</label><select name="size" id="sizeSelect"></select>
        <label>数量（张）</label><input name="qty" type="number" min="1" value="1" required>
        <label><input type="checkbox" name="rush"> 加急（按基础价加收三成，另计）</label>
        <button>开单报价</button>
      </form>
      <div class="panel" style="margin-top:14px">
        <h2>库存与备料</h2>
        <div class="inv" id="inventory"></div>
        <form id="restockForm" style="border:0;padding:12px 0 0">
          <label>补料类型</label><select name="type" id="restockType"><option value="chemical">药液</option><option value="paper">纸张</option></select>
          <label>批次 / 尺寸</label><select name="key" id="restockKey"></select>
          <label>数量（ml 或 张）</label><input name="amount" type="number" min="1" required>
          <button>补料入库</button>
        </form>
      </div>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option></select><input id="search" placeholder="搜索单号或母版"></div>
      <div class="grid" id="orders"></div>
      <div class="panel" style="margin-top:14px">
        <h2>成本账本</h2>
        <div id="accounts"></div>
        <div class="logs meta" id="entries" style="max-height:180px;margin-top:10px"></div>
      </div>
    </section>
  </main>
  <script>
    const SIZES = ${JSON.stringify(SIZES)};
    const ORDER_STAGES = ${JSON.stringify(ORDER_STAGES)};
    const WASTE_LIMIT = ${JSON.stringify(WASTE_LIMIT)};
    let items = [], orders = [], inventory = { chemicals: [], paper: [] }, ledger = { entries: [], accounts: [] };
    const $ = sel => document.querySelector(sel);
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { 'Content-Type': 'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function money(n) { return '¥' + Number(n || 0).toFixed(2); }
    function pct(n) { return (Number(n || 0) * 100).toFixed(1) + '%'; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
    async function load() {
      const results = await Promise.all([api('/api/items'), api('/api/orders'), api('/api/inventory'), api('/api/ledger')]);
      items = results[0]; orders = results[1]; inventory = results[2]; ledger = results[3];
      render();
    }
    function render() {
      $('#masterSelect').innerHTML = items.map(i => '<option value="' + esc(i.code || i.id) + '">' + esc(i.code || i.id) + ' · ' + esc(i.plateSize || '') + '</option>').join('');
      const filter = $('#statusFilter');
      const current = filter.value;
      filter.innerHTML = '<option value="">全部状态</option>' + ORDER_STAGES.map(s => '<option' + (s === current ? ' selected' : '') + '>' + s + '</option>').join('');
      $('#stats').innerHTML = ORDER_STAGES.map(s => '<div class="stat"><span>' + s + '</span><strong>' + orders.filter(o => o.status === s).length + '</strong></div>').join('');
      renderInventory();
      renderOrders();
      renderLedger();
    }
    function renderInventory() {
      const chems = (inventory.chemicals || []).map(c => '<div><b>药液 ' + esc(c.batch) + '</b><br><span class="meta">' + esc(c.name || '') + ' · 库存 ' + c.stockMl + 'ml · ' + c.unitCost + ' 元/ml</span></div>').join('');
      const papers = (inventory.paper || []).map(p => '<div><b>纸 ' + esc(p.size) + '</b><br><span class="meta">' + esc(p.name || '') + ' · 库存 ' + p.stock + ' 张 · ' + p.unitCost + ' 元/张</span></div>').join('');
      $('#inventory').innerHTML = '<div>' + (chems || '<span class="meta">暂无药液</span>') + '</div><div>' + (papers || '<span class="meta">暂无纸张</span>') + '</div>';
      const type = $('#restockType').value;
      const keys = type === 'chemical' ? (inventory.chemicals || []).map(c => c.batch) : (inventory.paper || []).map(p => p.size);
      $('#restockKey').innerHTML = keys.map(k => '<option>' + esc(k) + '</option>').join('');
    }
    function cardHtml(o) {
      const q = o.quote, a = o.account;
      const lines = [
        '<div><b>母版</b> ' + esc(o.masterCode) + ' · <b>尺寸</b> ' + esc(o.size) + ' × ' + o.qty + ' 张' + (o.rush ? ' · <span class="warn">加急</span>' : '') + '</div>',
        '<div><b>报价</b> 基础 ' + money(q.base) + ' + 加急 ' + money(q.rushFee) + ' + 返工 ' + money(q.reworkFee) + ' = <b>' + money(q.total) + '</b></div>',
        '<div><b>已收</b> ' + money(a.received) + ' · <b>成本</b> ' + money(a.cost) + ' · <b>待收</b> ' + money(a.balance) + '</div>'
      ];
      let actions = '';
      if (o.status === '待备料') {
        lines.push('<div class="warn">缺料：' + esc((o.shortage || []).join('；')) + '（母版暂未占用）</div>');
        actions += '<button data-act="recheck" data-id="' + o.id + '">备料复检</button>';
      }
      if (o.status === '待制作') {
        lines.push('<div class="meta">预计用药液 ' + o.estimate.chemicalMl + 'ml · 纸 ' + o.estimate.paperSheets + ' 张</div>');
        actions += '<div class="meta">生产记录</div>'
          + '<input id="finished-' + o.id + '" type="number" min="0" placeholder="成品张数">'
          + '<input id="waste-' + o.id + '" type="number" min="0" placeholder="废片张数">'
          + '<input id="chem-' + o.id + '" type="number" min="0" placeholder="实际药液 ml">'
          + '<input id="paper-' + o.id + '" type="number" min="0" placeholder="实际纸张 张">'
          + '<button data-act="produce" data-id="' + o.id + '">提交生产记录</button>';
      }
      if (o.status === '复核') {
        lines.push('<div class="warn">废片率 ' + pct(o.production && o.production.wasteRate) + ' 超过一成，退回复核</div>');
        actions += '<button data-act="rework" data-id="' + o.id + '">返工（另计返工费）</button><button class="secondary" data-act="accept" data-id="' + o.id + '">复核通过</button>';
      }
      if (o.status === '待出库') {
        lines.push('<div class="meta">成品留存中，尾款结清后方可出库</div>');
        actions += '<button data-act="deliver" data-id="' + o.id + '">出库交付</button>';
      }
      if (o.status !== '已完成' && o.status !== '已取消') {
        actions += '<div class="meta">收款</div><input id="payamt-' + o.id + '" type="number" min="0" step="0.01" placeholder="金额">'
          + '<select id="paykind-' + o.id + '"><option>订金</option><option>尾款</option></select>'
          + '<button class="secondary" data-act="pay" data-id="' + o.id + '">登记收款</button>'
          + '<button class="secondary" data-act="cancel" data-id="' + o.id + '">取消订单</button>';
      }
      const logs = (o.logs || []).slice(-4).map(l => '<div>' + esc(l.step) + '：' + esc(l.note) + '</div>').join('');
      return '<article class="card"><h3>' + esc(o.id) + '</h3><span class="pill">' + esc(o.status) + '</span>' + lines.join('') + actions + '<div class="logs meta">' + (logs || '暂无记录') + '</div></article>';
    }
    function renderOrders() {
      const status = $('#statusFilter').value;
      const q = $('#search').value.trim();
      const visible = orders.filter(o => (!status || o.status === status) && (!q || (o.id + o.masterCode).includes(q)));
      $('#orders').innerHTML = visible.map(cardHtml).join('') || '<div class="panel meta">暂无订单</div>';
      document.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => run(btn.dataset.act, btn.dataset.id));
    }
    function renderLedger() {
      const rows = (ledger.accounts || []).map(a => '<tr><td>' + esc(a.orderId) + '</td><td>' + esc(a.masterCode) + '</td><td>' + money(a.total) + '</td><td>' + money(a.received) + '</td><td>' + money(a.cost) + '</td><td>' + money(a.balance) + '</td><td>' + money(a.margin) + '</td><td>' + esc(a.status) + '</td></tr>').join('');
      $('#accounts').innerHTML = rows
        ? '<table><tr><th>订单</th><th>母版</th><th>报价</th><th>已收</th><th>成本</th><th>待收</th><th>已收-成本</th><th>状态</th></tr>' + rows + '</table>'
        : '<div class="meta">暂无订单账目</div>';
      $('#entries').innerHTML = (ledger.entries || []).slice(-20).reverse().map(e =>
        '<div>' + esc((e.at || '').slice(0, 19).replace('T', ' ')) + ' · ' + esc(e.orderId || '—') + ' · ' + esc(e.kind) + ' · ' + money(e.amount) + (e.note ? ' · ' + esc(e.note) : '') + '</div>'
      ).join('') || '暂无账目流水';
    }
    async function run(act, id) {
      try {
        if (act === 'recheck') await api('/api/orders/' + id + '/recheck', { method: 'POST', body: '{}' });
        if (act === 'produce') {
          const payload = {
            finished: Number($('#finished-' + id).value),
            waste: Number($('#waste-' + id).value),
            chemicalMl: Number($('#chem-' + id).value),
            paperSheets: Number($('#paper-' + id).value)
          };
          await api('/api/orders/' + id + '/production', { method: 'POST', body: JSON.stringify(payload) });
        }
        if (act === 'rework') await api('/api/orders/' + id + '/review', { method: 'POST', body: JSON.stringify({ decision: 'rework' }) });
        if (act === 'accept') await api('/api/orders/' + id + '/review', { method: 'POST', body: JSON.stringify({ decision: 'accept' }) });
        if (act === 'pay') {
          await api('/api/orders/' + id + '/payments', { method: 'POST', body: JSON.stringify({ kind: $('#paykind-' + id).value, amount: Number($('#payamt-' + id).value) }) });
        }
        if (act === 'deliver') await api('/api/orders/' + id + '/deliver', { method: 'POST', body: '{}' });
        if (act === 'cancel' && confirm('确定取消该订单？')) await api('/api/orders/' + id + '/cancel', { method: 'POST', body: '{}' });
        await load();
      } catch (error) { alert(error.message); }
    }
    $('#createForm').onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      data.qty = Number(data.qty);
      data.rush = data.rush === 'on';
      try { await api('/api/orders', { method: 'POST', body: JSON.stringify(data) }); event.target.reset(); await load(); }
      catch (error) { alert(error.message); }
    };
    $('#restockForm').onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      data.amount = Number(data.amount);
      try { await api('/api/inventory/restock', { method: 'POST', body: JSON.stringify(data) }); await load(); }
      catch (error) { alert(error.message); }
    };
    $('#restockType').onchange = renderInventory;
    $('#statusFilter').onchange = renderOrders;
    $('#search').oninput = renderOrders;
    $('#reload').onclick = load;
    $('#sizeSelect').innerHTML = Object.keys(SIZES).map(s => '<option value="' + s + '">' + s + ' · ' + SIZES[s].unitPrice + ' 元/张</option>').join('');
    load();
  </script>
</body>
</html>`;
}
