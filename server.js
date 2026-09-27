import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WASTE_LIMIT, quote, estimateMaterials, reworkFee, wasteRate,
  findShortage, reserveMaterials, releaseMaterials, consumeMaterials, masterBusy, round2
} from "./src/orderPricing.js";
import { appendEntry, entriesFor, accountFor } from "./src/costLedger.js";
import { orderDeskPage } from "./src/orderDeskPage.js";

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
  ]
};
const fields = [["code","底片编号","text"],["plateSize","玻璃板尺寸","text"],["chemicalBatch","药液批次","text"],["exposure","曝光时间","text"],["waterSource","冲洗水源","text"],["box","存放盒位","text"]];
const stages = ["待曝光","冲洗中","待入盒","已交付"];
const statLabels = ["待曝光","冲洗中","待入盒","已交付"];
const extraFields = [["step","步骤"],["developStatus","显影状态"],["defect","缺陷类型"],["repair","修补记录"],["note","备注"]];

function defaultMaterials() {
  return {
    chemical: { name: "蓝晒药液", unit: "ml", stock: 2000, unitCost: 0.8 },
    papers: {
      "18x24cm": { stock: 50, unitCost: 6 },
      "24x30cm": { stock: 30, unitCost: 9 },
      "30x40cm": { stock: 0, unitCost: 14 }
    }
  };
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.items ||= [];
  db.orders ||= [];
  db.ledger ||= [];
  db.materials ||= defaultMaterials();
  return db;
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

// ===== 复制订单结算台辅助 =====
function findOrder(db, id) { return db.orders.find(o => o.id === id); }
function orderLog(order, step, note) {
  order.logs ||= [];
  order.logs.push({ at: new Date().toISOString(), step, note });
}
function orderView(db, order) {
  return {
    ...order,
    account: accountFor(db, order),
    shortage: order.status === "待备料" ? findShortage(db.materials, order.estimate) : []
  };
}
// 待备料订单在料齐且母版空闲时转为待生产并预留用料
function tryPromote(db, order, note) {
  if (order.status !== "待备料") return false;
  if (findShortage(db.materials, order.estimate).length) return false;
  if (masterBusy(db, order.masterCode, order.id)) return false;
  reserveMaterials(db.materials, order.estimate);
  order.reserved = true;
  order.status = "待生产";
  orderLog(order, "备料", note);
  return true;
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
    .nav { display:flex; gap:14px; align-items:center; } .nav a { color:var(--accent); font-weight:700; text-decoration:none; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法蓝晒底片整理室</h1><div class="meta">底片任务、工艺步骤、缺陷和入盒交付</div></div><div class="nav"><a href="/orders">复制订单结算台</a><button id="reload">刷新</button></div></header>
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
    if (req.method === "GET" && url.pathname === "/orders") return html(res, orderDeskPage());
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
    // ===== 复制订单结算台 =====
    if (req.method === "GET" && url.pathname === "/api/orders") {
      return send(res, 200, db.orders.map(o => orderView(db, o)));
    }
    if (req.method === "POST" && url.pathname === "/api/orders/quote") {
      const input = await body(req);
      try {
        const q = quote(input.size, Number(input.quantity), !!input.rush);
        const estimate = estimateMaterials(input.size, Number(input.quantity));
        return send(res, 200, { ...q, estimate, shortage: findShortage(db.materials, estimate) });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/orders") {
      const input = await body(req);
      const master = db.items.find(x => x.code === input.masterCode || x.id === input.masterCode);
      if (!master) return send(res, 404, { error: "母版不存在:" + input.masterCode });
      const masterCode = master.code || master.id;
      let pricing, estimate;
      try {
        pricing = quote(input.size, Number(input.quantity), !!input.rush);
        estimate = estimateMaterials(input.size, Number(input.quantity));
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      if (masterBusy(db, masterCode, null)) return send(res, 409, { error: "同一母版已有未结束订单" });
      const order = {
        id: "DUP-" + Date.now(),
        masterCode,
        size: input.size,
        quantity: Number(input.quantity),
        rush: !!input.rush,
        pricing: { unitPrice: pricing.unitPrice, basePrice: pricing.basePrice, rushFee: pricing.rushFee },
        estimate,
        reserved: false,
        rounds: [],
        goodTotal: 0,
        wasteTotal: 0,
        reworkCount: 0,
        retained: false,
        status: "待备料",
        createdAt: new Date().toISOString(),
        logs: []
      };
      const gaps = findShortage(db.materials, estimate);
      if (gaps.length) {
        orderLog(order, "开单", "备料不足(" + gaps.join(";") + "),停在待备料,母版暂不占用");
      } else {
        reserveMaterials(db.materials, estimate);
        order.reserved = true;
        order.status = "待生产";
        orderLog(order, "开单", "备料充足,预留用料并占用母版");
      }
      if (order.rush) appendEntry(db, order.id, "加急费", "加急订单另计", pricing.rushFee);
      db.orders.unshift(order);
      await saveDb(db);
      return send(res, 201, orderView(db, order));
    }
    const orderAction = url.pathname.match(/^\/api\/orders\/([^/]+)\/(recheck|production|review|payments|settle|cancel)$/);
    if (orderAction && req.method === "POST") {
      const order = findOrder(db, orderAction[1]);
      if (!order) return send(res, 404, { error: "order_not_found" });
      const act = orderAction[2];
      if (act === "recheck") {
        if (order.status !== "待备料") return send(res, 409, { error: "仅待备料订单需要重新备料检查" });
        const gaps = findShortage(db.materials, order.estimate);
        if (gaps.length) {
          orderLog(order, "备料", "仍缺料:" + gaps.join(";"));
          await saveDb(db);
          return send(res, 200, orderView(db, order));
        }
        if (!tryPromote(db, order, "备料补齐,占用母版")) {
          return send(res, 409, { error: "母版已被其他未结束订单占用" });
        }
        await saveDb(db);
        return send(res, 200, orderView(db, order));
      }
      if (act === "production") {
        if (!["待生产", "生产中"].includes(order.status)) return send(res, 409, { error: "当前状态不可填报生产" });
        const input = await body(req);
        const good = Number(input.good), waste = Number(input.waste);
        const chemUsed = Number(input.chemUsed), paperUsed = Number(input.paperUsed);
        if (![good, waste, chemUsed, paperUsed].every(n => Number.isFinite(n) && n >= 0)) {
          return send(res, 400, { error: "成品、废片与实际用量需为非负数字" });
        }
        if (good + waste < 1) return send(res, 400, { error: "成品与废片不能同时为0" });
        if (order.reserved) { releaseMaterials(db.materials, order.estimate); order.reserved = false; }
        consumeMaterials(db.materials, order.size, chemUsed, paperUsed);
        order.rounds ||= [];
        order.rounds.push({ at: new Date().toISOString(), good, waste, chemUsed, paperUsed });
        order.goodTotal = (order.goodTotal || 0) + good;
        order.wasteTotal = (order.wasteTotal || 0) + waste;
        const chemCost = round2(chemUsed * db.materials.chemical.unitCost);
        const paper = db.materials.papers[order.size];
        const paperCost = round2(paperUsed * (paper ? paper.unitCost : 0));
        appendEntry(db, order.id, "药液成本", "实际用药 " + chemUsed + "ml", chemCost);
        appendEntry(db, order.id, "纸张成本", "实际用纸 " + paperUsed + "张", paperCost);
        const rate = wasteRate(good, waste);
        const pct = (rate * 100).toFixed(1) + "%";
        if (rate > WASTE_LIMIT) {
          order.status = "待复核";
          orderLog(order, "生产", "成品" + good + " 废片" + waste + "(废片率" + pct + "超一成),退回复核");
        } else {
          order.status = "待出库";
          order.retained = true;
          orderLog(order, "生产", "成品" + good + " 废片" + waste + "(废片率" + pct + "),成品留存待尾款");
        }
        await saveDb(db);
        return send(res, 201, orderView(db, order));
      }
      if (act === "review") {
        if (order.status !== "待复核") return send(res, 409, { error: "仅待复核订单可复核" });
        const input = await body(req);
        if (input.decision === "返工") {
          order.reworkCount = (order.reworkCount || 0) + 1;
          const fee = reworkFee(order.pricing.basePrice);
          appendEntry(db, order.id, "返工费", "复核退回返工(第" + order.reworkCount + "次)", fee);
          order.status = "生产中";
          orderLog(order, "复核", "退回返工,返工费" + fee + "元另计");
        } else if (input.decision === "通过") {
          order.status = "待出库";
          order.retained = true;
          orderLog(order, "复核", "复核通过,成品留存待尾款");
        } else {
          return send(res, 400, { error: "decision 需为 通过 或 返工" });
        }
        await saveDb(db);
        return send(res, 200, orderView(db, order));
      }
      if (act === "payments") {
        if (["已结清", "已取消"].includes(order.status)) return send(res, 409, { error: "订单已结束,不可收款" });
        const input = await body(req);
        const amount = Number(input.amount);
        if (!Number.isFinite(amount) || amount <= 0) return send(res, 400, { error: "收款金额需为正数" });
        appendEntry(db, order.id, "收款", input.label || "尾款", amount);
        orderLog(order, "收款", (input.label || "尾款") + " " + amount + "元");
        await saveDb(db);
        return send(res, 201, orderView(db, order));
      }
      if (act === "settle") {
        if (order.status !== "待出库") return send(res, 409, { error: "订单未到待出库,不能结清" });
        const account = accountFor(db, order);
        if (account.due > 0) return send(res, 409, { error: "尾款未结清,还差" + account.due + "元" });
        order.status = "已结清";
        order.retained = false;
        orderLog(order, "结清", "尾款结清,成品出库,母版释放");
        await saveDb(db);
        return send(res, 200, orderView(db, order));
      }
      if (act === "cancel") {
        if (["已结清", "已取消"].includes(order.status)) return send(res, 409, { error: "订单已结束" });
        if (order.reserved) { releaseMaterials(db.materials, order.estimate); order.reserved = false; }
        order.status = "已取消";
        order.retained = false;
        orderLog(order, "取消", "订单取消,释放母版与备料");
        await saveDb(db);
        return send(res, 200, orderView(db, order));
      }
    }
    if (req.method === "GET" && url.pathname === "/api/materials") return send(res, 200, db.materials);
    if (req.method === "POST" && url.pathname === "/api/materials/replenish") {
      const input = await body(req);
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return send(res, 400, { error: "补充数量需为正数" });
      if (input.kind === "chemical") {
        db.materials.chemical.stock = round2(db.materials.chemical.stock + amount);
      } else if (input.kind === "paper") {
        const paper = db.materials.papers[input.size];
        if (!paper) return send(res, 404, { error: "无此尺寸纸张:" + input.size });
        paper.stock += Math.round(amount);
      } else {
        return send(res, 400, { error: "kind 需为 chemical 或 paper" });
      }
      // 补料后按开单先后自动重检待备料订单
      const waiting = db.orders.filter(o => o.status === "待备料").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const o of waiting) tryPromote(db, o, "补料后备料齐,占用母版");
      await saveDb(db);
      return send(res, 200, db.materials);
    }
    if (req.method === "GET" && url.pathname === "/api/ledger") {
      const orderId = url.searchParams.get("orderId");
      const entries = orderId ? entriesFor(db, orderId) : db.ledger;
      return send(res, 200, entries.slice().reverse());
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法蓝晒底片整理室 listening on http://localhost:" + port));
