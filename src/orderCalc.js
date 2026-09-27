// 订单计算：复制订单的报价、用料估算与状态规则（纯函数，不碰数据文件）

// 成品尺寸价目：每张单价（元）与每张预计药液用量（ml）
export const SIZES = {
  "9x12cm": { unitPrice: 8, chemicalMl: 12 },
  "13x18cm": { unitPrice: 15, chemicalMl: 20 },
  "18x24cm": { unitPrice: 25, chemicalMl: 30 },
  "24x30cm": { unitPrice: 40, chemicalMl: 50 },
};

export const ORDER_STAGES = ["待备料", "待制作", "复核", "待出库", "已完成", "已取消"];
// 占用母版的状态：同一母版同时只保留一张处于这些状态的订单；待备料不占母版
export const MASTER_HOLDING = ["待制作", "复核", "待出库"];
export const UNFINISHED = ["待备料", "待制作", "复核", "待出库"];

export const RUSH_RATE = 0.3;   // 加急费：按基础价加收三成，另计
export const REWORK_RATE = 0.2; // 返工费：每轮返工按基础价加收两成，另计
export const WASTE_LIMIT = 0.1; // 废片率上限一成，超过退回复核
export const SPARE_RATE = 0.1;  // 备料估算富余一成

export function round2(n) { return Math.round(n * 100) / 100; }

// 报价：基础价随尺寸和数量计算，加急与返工另计
export function quoteOrder({ size, qty, rush = false, reworkRounds = 0 }) {
  const spec = SIZES[size];
  if (!spec) throw new Error("不支持的成品尺寸：" + size);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error("数量必须是正整数");
  const base = round2(spec.unitPrice * qty);
  const rushFee = rush ? round2(base * RUSH_RATE) : 0;
  const reworkFee = round2(base * REWORK_RATE * reworkRounds);
  return { base, rushFee, reworkFee, total: round2(base + rushFee + reworkFee) };
}

// 用料估算：按尺寸单耗 × 数量，加一成富余
export function estimateMaterials({ size, qty }) {
  const spec = SIZES[size];
  if (!spec) throw new Error("不支持的成品尺寸：" + size);
  return {
    chemicalMl: Math.ceil(spec.chemicalMl * qty * (1 + SPARE_RATE)),
    paperSheets: Math.ceil(qty * (1 + SPARE_RATE)),
  };
}

export function wasteRate(finished, waste) {
  const total = Number(finished) + Number(waste);
  return total > 0 ? Number(waste) / total : 0;
}

export function isOverWasteLimit(finished, waste) {
  return wasteRate(finished, waste) > WASTE_LIMIT;
}

// 同一母版同时只保留一张未结束订单（待备料不占母版，不参与判断）
export function masterHoldingOrder(orders, masterCode, exceptId = null) {
  return (orders || []).find(o => o.masterCode === masterCode && o.id !== exceptId && MASTER_HOLDING.includes(o.status)) || null;
}
