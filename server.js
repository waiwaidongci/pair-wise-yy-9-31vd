import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteOrder, estimateMaterials, wasteRate, isOverWasteLimit, masterHoldingOrder } from "./src/orderCalc.js";
import { defaultInventory, materialShortage, postProductionCosts, postPayment, orderAccount, restock } from "./src/ledger.js";
import { orderPage } from "./src/orderPage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "cyanotype-negative-room.json");
const port = Number(process.env.PORT || 3040);
const seed = {
  "items": [
    {
      "code": "CN-001",
      "plateSize": "18x24cm",
      "chemicalBatch": "B-0620",
      "exposure": "8分钟",
      "waterSource": "井水过滤",
      "box": "蓝盒A-03",
      "status": "冲洗中",
      "defect": "边角显影不均",
      "logs": [
        {
          "at": "2026-06-20",
          "step": "曝光",
          "note": "阴天补时2分钟"
        }
      ]
    }
  ],
  "inventory": defaultInventory(),
  "orders": [],
  "ledger": []
};
function normalize(db) {
  db.items ||= [];
  db.inventory ||= defaultInventory();
  db.inventory.chemicals ||= [];
  db.inventory.paper ||= [];
  db.orders ||= [];
  db.ledger ||= [];
  return db;
}
const fields = [["code","底片编号","text"],["plateSize","玻璃板尺寸","text"],["chemicalBatch","药液批次","text"],["exposure","曝光时间","text"],["waterSource","冲洗水源","text"],["box","存放盒位","text"]];
const stages = ["待曝光","冲洗中","待入盒","已交付"];
const statLabels = ["待曝光","冲洗中","待入盒","已交付"];
const extraFields = [["step","步骤"],["developStatus","显影状态"],["defect","缺陷类型"],["repair","修补记录"],["note","备注"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return normalize(JSON.parse(await readFile(dbPath, "utf8")));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "CN-" + Date.now(); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法蓝晒底片整理室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法蓝晒底片整理室</h1><div class="meta">底片任务、工艺步骤、缺陷和入盒交付</div></div><div><a class="pill" href="/orders" style="margin-right:8px;text-decoration:none;color:inherit">复制订单结算台</a><button id="reload">刷新</button></div></header>
  <main>
    <section>
      <form id="createForm"><h2>新增底片</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存底片</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>记录工艺步骤</h2><label>选择底片</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>创建蓝晒任务后，按涂布、晾干、曝光、冲洗、复晒、入盒记录每一步历史。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","底片编号","text"],["plateSize","玻璃板尺寸","text"],["chemicalBatch","药液批次","text"],["exposure","曝光时间","text"],["waterSource","冲洗水源","text"],["box","存放盒位","text"]];
    const stages = ["待曝光","冲洗中","待入盒","已交付"];
    const extraFields = [["step","步骤"],["developStatus","显影状态"],["defect","缺陷类型"],["repair","修补记录"],["note","备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建底片" }] };
      
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      Object.assign(item, await body(req));
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.steps ||= [];
      item.steps.push({ at: new Date().toISOString(), ...input });
      if (input.defect) item.defect = input.defect;
      if (input.step === "冲洗") item.status = "冲洗中";
      else if (input.step === "入盒") item.status = "待入盒";
      else if (input.step === "交付") item.status = "已交付";
      else item.status = "待曝光";
      item.logs.push({ at: new Date().toISOString(), step: input.step || "工艺", note: input.note || input.developStatus || "步骤记录" });
      await saveDb(db);
      return send(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/orders") return html(res, orderPage());
    if (req.method === "GET" && url.pathname === "/api/orders") {
      const list = db.orders.map(o => ({
        ...o,
        account: orderAccount(db, o),
        shortage: o.status === "待备料" ? materialShortage(db, o) : o.shortage || [],
      }));
      return send(res, 200, list);
    }
    if (req.method === "POST" && url.pathname === "/api/orders") {
      const input = await body(req);
      const master = db.items.find(x => x.id === input.masterCode || x.code === input.masterCode);
      if (!master) return send(res, 404, { error: "master_not_found" });
      const masterCode = master.code || master.id;
      const holding = masterHoldingOrder(db.orders, masterCode);
      if (holding) return send(res, 409, { error: `母版 ${masterCode} 已有未结束订单 ${holding.id}，同一母版同时只保留一张` });
      const qty = Number(input.qty);
      const rush = input.rush === true || input.rush === "true" || input.rush === "on";
      let quote, estimate;
      try {
        quote = quoteOrder({ size: input.size, qty, rush });
        estimate = estimateMaterials({ size: input.size, qty });
      } catch (error) { return send(res, 400, { error: error.message }); }
      const now = new Date().toISOString();
      const order = {
        id: "PO-" + Date.now(),
        masterCode,
        chemicalBatch: master.chemicalBatch || "",
        size: input.size,
        qty,
        rush,
        reworkRounds: 0,
        quote,
        estimate,
        production: null,
        status: "待备料",
        shortage: [],
        logs: [{ at: now, step: "开单", note: `复制 ${qty} 张 ${input.size}${rush ? "，加急" : ""}，报价 ${quote.total} 元` }],
        createdAt: now,
      };
      const shortage = materialShortage(db, order);
      if (shortage.length) {
        order.shortage = shortage;
        order.logs.push({ at: now, step: "待备料", note: shortage.join("；") + "，母版暂不占用" });
      } else {
        order.status = "待制作";
        order.logs.push({ at: now, step: "排产", note: "备料充足，母版占用" });
      }
      db.orders.unshift(order);
      await saveDb(db);
      return send(res, 201, order);
    }
    const orderAct = url.pathname.match(/^\/api\/orders\/([^/]+)\/(recheck|production|review|payments|deliver|cancel)$/);
    if (orderAct && req.method === "POST") {
      const order = db.orders.find(o => o.id === orderAct[1]);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const input = await body(req);
      const now = new Date().toISOString();
      const act = orderAct[2];
      if (act === "recheck") {
        if (order.status !== "待备料") return send(res, 409, { error: "只有待备料订单需要复检" });
        const holding = masterHoldingOrder(db.orders, order.masterCode, order.id);
        if (holding) return send(res, 409, { error: `母版 ${order.masterCode} 已被订单 ${holding.id} 占用` });
        const shortage = materialShortage(db, order);
        if (shortage.length) {
          order.shortage = shortage;
          order.logs.push({ at: now, step: "待备料", note: shortage.join("；") });
          await saveDb(db);
          return send(res, 409, { error: "仍缺料：" + shortage.join("；") });
        }
        order.shortage = [];
        order.status = "待制作";
        order.logs.push({ at: now, step: "排产", note: "备料齐，母版占用" });
      }
      if (act === "production") {
        if (order.status !== "待制作") return send(res, 409, { error: "订单当前不在待制作状态" });
        const actual = {
          finished: Number(input.finished),
          waste: Number(input.waste),
          chemicalMl: Number(input.chemicalMl),
          paperSheets: Number(input.paperSheets),
        };
        if (![actual.finished, actual.waste, actual.paperSheets].every(n => Number.isInteger(n) && n >= 0) || !(actual.chemicalMl >= 0)) {
          return send(res, 400, { error: "成品、废片、纸张须为非负整数，药液须为非负数" });
        }
        if (actual.finished + actual.waste === 0) return send(res, 400, { error: "成品与废片不能同时为 0" });
        try { postProductionCosts(db, order, actual); } catch (error) { return send(res, 409, { error: error.message }); }
        const rate = wasteRate(actual.finished, actual.waste);
        order.production = { ...actual, wasteRate: rate, at: now };
        if (isOverWasteLimit(actual.finished, actual.waste)) {
          order.status = "复核";
          order.logs.push({ at: now, step: "复核", note: `废片率 ${(rate * 100).toFixed(1)}% 超过一成，退回复核` });
        } else {
          order.status = "待出库";
          order.logs.push({ at: now, step: "生产完成", note: `成品 ${actual.finished} 张、废片 ${actual.waste} 张，成品留存待出库` });
        }
      }
      if (act === "review") {
        if (order.status !== "复核") return send(res, 409, { error: "订单当前不在复核状态" });
        if (input.decision === "rework") {
          order.reworkRounds = (order.reworkRounds || 0) + 1;
          order.quote = quoteOrder({ size: order.size, qty: order.qty, rush: order.rush, reworkRounds: order.reworkRounds });
          order.production = null;
          order.status = "待制作";
          order.logs.push({ at: now, step: "返工", note: `第 ${order.reworkRounds} 轮返工，返工费另计 ${order.quote.reworkFee} 元` });
        } else if (input.decision === "accept") {
          order.status = "待出库";
          order.logs.push({ at: now, step: "复核通过", note: "成品留存待出库" });
        } else {
          return send(res, 400, { error: "decision 只能是 rework 或 accept" });
        }
      }
      if (act === "payments") {
        if (["已完成", "已取消"].includes(order.status)) return send(res, 409, { error: "订单已结束，不能再收款" });
        try { postPayment(db, order, { kind: input.kind || "收款", amount: input.amount }); }
        catch (error) { return send(res, 400, { error: error.message }); }
        order.logs.push({ at: now, step: "收款", note: `${input.kind || "收款"} ${Number(input.amount).toFixed(2)} 元` });
      }
      if (act === "deliver") {
        if (order.status !== "待出库") return send(res, 409, { error: "订单当前不在待出库状态" });
        const account = orderAccount(db, order);
        if (account.received < order.quote.total) {
          return send(res, 409, { error: `尾款未结清（已收 ${account.received} / 应收 ${order.quote.total}），成品留存，账面保持待出库` });
        }
        order.status = "已完成";
        order.logs.push({ at: now, step: "出库", note: "尾款结清，成品出库，母版释放" });
      }
      if (act === "cancel") {
        if (["已完成", "已取消"].includes(order.status)) return send(res, 409, { error: "订单已结束" });
        order.status = "已取消";
        order.logs.push({ at: now, step: "取消", note: "订单取消，母版释放" });
      }
      await saveDb(db);
      return send(res, 200, order);
    }
    if (req.method === "GET" && url.pathname === "/api/inventory") return send(res, 200, db.inventory);
    if (req.method === "POST" && url.pathname === "/api/inventory/restock") {
      const input = await body(req);
      try { restock(db, input); } catch (error) { return send(res, 400, { error: error.message }); }
      await saveDb(db);
      return send(res, 200, db.inventory);
    }
    if (req.method === "GET" && url.pathname === "/api/ledger") {
      const accounts = db.orders.map(o => ({ orderId: o.id, masterCode: o.masterCode, status: o.status, ...orderAccount(db, o) }));
      return send(res, 200, { entries: db.ledger, accounts });
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法蓝晒底片整理室 listening on http://localhost:" + port));
