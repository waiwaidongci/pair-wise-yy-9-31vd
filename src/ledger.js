// 成本账本：库存备料、生产落账、收款登记与每单成本汇总
import { round2 } from "./orderCalc.js";

// 默认库存：首次升级旧数据文件时补上一份可用存量
export function defaultInventory() {
  return {
    chemicals: [{ batch: "B-0620", name: "蓝晒药液", stockMl: 1200, unitCost: 0.35 }],
    paper: [
      { size: "9x12cm", name: "水彩纸", stock: 60, unitCost: 1.2 },
      { size: "13x18cm", name: "水彩纸", stock: 50, unitCost: 1.8 },
      { size: "18x24cm", name: "水彩纸", stock: 40, unitCost: 2.5 },
      { size: "24x30cm", name: "水彩纸", stock: 25, unitCost: 3.6 },
    ],
  };
}

export function findChemical(db, batch) {
  return ((db.inventory && db.inventory.chemicals) || []).find(c => c.batch === batch) || null;
}
export function findPaper(db, size) {
  return ((db.inventory && db.inventory.paper) || []).find(p => p.size === size) || null;
}

// 备料检查：预计药液用量超过库存或缺少对应纸张时返回缺料原因，空数组表示可排产
export function materialShortage(db, order) {
  const shortage = [];
  const est = order.estimate || { chemicalMl: 0, paperSheets: 0 };
  const chem = findChemical(db, order.chemicalBatch);
  if (!chem) shortage.push(`缺少药液批次 ${order.chemicalBatch || "（未登记）"}`);
  else if (chem.stockMl < est.chemicalMl) shortage.push(`药液 ${chem.batch} 库存 ${chem.stockMl}ml，预计需 ${est.chemicalMl}ml`);
  const paper = findPaper(db, order.size);
  if (!paper) shortage.push(`缺少 ${order.size} 成品纸`);
  else if (paper.stock < est.paperSheets) shortage.push(`${paper.size} 纸库存 ${paper.stock} 张，预计需 ${est.paperSheets} 张`);
  return shortage;
}

export function postEntry(db, entry) {
  db.ledger ||= [];
  const row = { at: new Date().toISOString(), ...entry };
  db.ledger.push(row);
  return row;
}

// 生产落账：按实际用量扣库存，药液与纸张成本分别入账
export function postProductionCosts(db, order, actual) {
  const chem = findChemical(db, order.chemicalBatch);
  if (!chem) throw new Error(`缺少药液批次 ${order.chemicalBatch}`);
  if (chem.stockMl < actual.chemicalMl) throw new Error(`药液 ${chem.batch} 库存 ${chem.stockMl}ml 不足实际用量 ${actual.chemicalMl}ml`);
  const paper = findPaper(db, order.size);
  if (!paper) throw new Error(`缺少 ${order.size} 成品纸`);
  if (paper.stock < actual.paperSheets) throw new Error(`${paper.size} 纸库存 ${paper.stock} 张不足实际用量 ${actual.paperSheets} 张`);
  chem.stockMl = round2(chem.stockMl - actual.chemicalMl);
  paper.stock -= actual.paperSheets;
  postEntry(db, { orderId: order.id, kind: "药液成本", amount: round2(actual.chemicalMl * chem.unitCost), note: `${actual.chemicalMl}ml × ${chem.unitCost}元/ml（批次 ${chem.batch}）` });
  postEntry(db, { orderId: order.id, kind: "纸张成本", amount: round2(actual.paperSheets * paper.unitCost), note: `${actual.paperSheets}张 × ${paper.unitCost}元/张（${paper.size}）` });
}

// 收款入账：订金、尾款都记到订单账上
export function postPayment(db, order, { kind = "收款", amount }) {
  if (!(Number(amount) > 0)) throw new Error("收款金额必须大于 0");
  return postEntry(db, { orderId: order.id, kind: "收款", amount: round2(Number(amount)), note: kind });
}

// 每单账面：报价、已收、成本、待收尾款对照
export function orderAccount(db, order) {
  const rows = (db.ledger || []).filter(r => r.orderId === order.id);
  const cost = rows.filter(r => r.kind !== "收款").reduce((s, r) => s + r.amount, 0);
  const received = rows.filter(r => r.kind === "收款").reduce((s, r) => s + r.amount, 0);
  const total = order.quote ? order.quote.total : 0;
  return {
    total,
    received: round2(received),
    cost: round2(cost),
    balance: round2(total - received),
    margin: round2(received - cost),
  };
}

// 补料入库：只给已登记的药液批次或纸张尺寸补量
export function restock(db, { type, key, amount }) {
  const qty = Number(amount);
  if (!(qty > 0)) throw new Error("补料数量必须大于 0");
  if (type === "chemical") {
    const chem = findChemical(db, key);
    if (!chem) throw new Error("未找到药液批次 " + key);
    chem.stockMl = round2(chem.stockMl + qty);
    return chem;
  }
  if (type === "paper") {
    const paper = findPaper(db, key);
    if (!paper) throw new Error("未找到纸张 " + key);
    paper.stock += qty;
    return paper;
  }
  throw new Error("补料类型只能是 chemical 或 paper");
}
