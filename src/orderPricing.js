// 复制订单计算:尺寸价目、用料估算、备料检查与订单状态规则
export const SIZE_TABLE = {
  "18x24cm": { unitPrice: 60, chemMl: 40 },
  "24x30cm": { unitPrice: 90, chemMl: 60 },
  "30x40cm": { unitPrice: 140, chemMl: 95 }
};
export const RUSH_RATE = 0.3;   // 加急费按基础价三成另计
export const REWORK_RATE = 0.4; // 返工费按基础价四成另计(每次返工)
export const WASTE_LIMIT = 0.1; // 废片率一成为复核线

export const ORDER_STAGES = ["待备料", "待生产", "生产中", "待复核", "待出库", "已结清", "已取消"];
// 占用母版的未结束状态;待备料只占单不占母版
export const OPEN_STAGES = ["待生产", "生产中", "待复核", "待出库"];

export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function quote(size, quantity, rush) {
  const row = SIZE_TABLE[size];
  if (!row) throw new Error("未知成品尺寸:" + size);
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) throw new Error("数量需为正整数");
  const basePrice = round2(row.unitPrice * qty);
  const rushFee = rush ? round2(basePrice * RUSH_RATE) : 0;
  return { unitPrice: row.unitPrice, basePrice, rushFee, total: round2(basePrice + rushFee) };
}

export function estimateMaterials(size, quantity) {
  const row = SIZE_TABLE[size];
  if (!row) throw new Error("未知成品尺寸:" + size);
  return { chemMl: row.chemMl * Number(quantity), paperSheets: Number(quantity), paperSize: size };
}

export function reworkFee(basePrice) { return round2(basePrice * REWORK_RATE); }

export function wasteRate(good, waste) {
  const total = Number(good) + Number(waste);
  return total === 0 ? 0 : Number(waste) / total;
}

export function occupiesMaster(order) { return OPEN_STAGES.includes(order.status); }

// 同一母版同时只保留一张未结束订单(待备料不占母版)
export function masterBusy(db, masterCode, excludeId) {
  return db.orders.some(o => o.masterCode === masterCode && o.id !== excludeId && occupiesMaster(o));
}

// 备料检查:返回缺口描述数组,空数组表示料齐可开生产
export function findShortage(materials, estimate) {
  const gaps = [];
  const chem = materials.chemical;
  if (!chem || chem.stock < estimate.chemMl) {
    gaps.push("药液缺口 " + round2(estimate.chemMl - (chem ? chem.stock : 0)) + "ml");
  }
  const paper = materials.papers[estimate.paperSize];
  if (!paper) gaps.push("缺少 " + estimate.paperSize + " 对应纸张");
  else if (paper.stock < estimate.paperSheets) gaps.push(estimate.paperSize + " 纸张缺口 " + (estimate.paperSheets - paper.stock) + "张");
  return gaps;
}

// 开单/补料检查时预留预计用料
export function reserveMaterials(materials, estimate) {
  materials.chemical.stock = round2(materials.chemical.stock - estimate.chemMl);
  materials.papers[estimate.paperSize].stock -= estimate.paperSheets;
}

// 取消订单或按实际用量结算前退回预留
export function releaseMaterials(materials, estimate) {
  materials.chemical.stock = round2(materials.chemical.stock + estimate.chemMl);
  if (materials.papers[estimate.paperSize]) materials.papers[estimate.paperSize].stock += estimate.paperSheets;
}

// 生产填报后按实际用量扣减库存
export function consumeMaterials(materials, size, chemMl, paperSheets) {
  materials.chemical.stock = round2(Math.max(0, materials.chemical.stock - Number(chemMl)));
  const paper = materials.papers[size];
  if (paper) paper.stock = Math.max(0, paper.stock - Number(paperSheets));
}
