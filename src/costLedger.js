// 复制订单成本账本:药液/纸张实际成本、加急与返工费用、收款流水
let seq = 0;
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function appendEntry(db, orderId, kind, label, amount, extra = {}) {
  const entry = {
    id: "L" + Date.now() + "-" + (seq += 1),
    orderId,
    kind,
    label,
    amount: round2(amount),
    at: new Date().toISOString(),
    ...extra
  };
  db.ledger.push(entry);
  return entry;
}

export function entriesFor(db, orderId) {
  return db.ledger.filter(e => e.orderId === orderId);
}

// 单订单账面:应收 = 基础价 + 加急费 + 返工费;成本 = 药液 + 纸张;尾款 = 应收 - 已收
export function accountFor(db, order) {
  const entries = entriesFor(db, order.id);
  const sum = kind => round2(entries.filter(e => e.kind === kind).reduce((n, e) => n + e.amount, 0));
  const chemCost = sum("药液成本");
  const paperCost = sum("纸张成本");
  const reworkFeeTotal = sum("返工费");
  const paid = sum("收款");
  const base = order.pricing.basePrice;
  const rushFee = order.pricing.rushFee;
  const total = round2(base + rushFee + reworkFeeTotal);
  return {
    base,
    rushFee,
    reworkFee: reworkFeeTotal,
    total,
    chemCost,
    paperCost,
    costTotal: round2(chemCost + paperCost),
    paid,
    due: round2(total - paid)
  };
}
