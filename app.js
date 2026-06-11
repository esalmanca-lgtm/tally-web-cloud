/* Tally Web — keyboard-first SPA over the Tally XML gateway */
"use strict";

/* ------------------------------------------------------------ helpers --- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"\']/g,
  (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const norm = (s) => String(s ?? "").replaceAll("\xa0", " ").replace(/\s+/g, " ").trim();
const money = (n) => Number(n || 0).toLocaleString("en-IN", {minimumFractionDigits: 2});
const ymd = (iso) => (iso || "").replaceAll("-", "");
const isPLLedger = (name) => {
  const n = String(name ?? "").toLowerCase().replace(/\s+/g, "");
  return n === "profit&lossa/c" || n === "profit&lossaccount";
};
const subDaysYMD = (ymdStr, days = 1) => {
  if (!ymdStr || ymdStr.toLowerCase().includes("invalid")) return "";
  const cleanStr = (ymdStr || "").replaceAll("-", "");
  if (cleanStr.length !== 8) return "";
  const y = parseInt(cleanStr.slice(0, 4));
  const m = parseInt(cleanStr.slice(4, 6)) - 1;
  const d = parseInt(cleanStr.slice(6, 8));
  const date = new Date(y, m, d);
  date.setDate(date.getDate() - days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
};
const tdate = (iso) => { // 2026-06-11 -> 11-Jun-26
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", {day: "2-digit", month: "short", year: "2-digit"})
          .replaceAll(" ", "-");
};

/* ===================== Supabase data layer ===================== */
const sb = supabase.createClient(
  window.TALLY_CONFIG.SUPABASE_URL, window.TALLY_CONFIG.SUPABASE_ANON_KEY);

function pa(text) { // parse Tally amount: negative = Dr, positive = Cr
  if (text == null) return 0;
  const t = String(text).trim().replace(/,/g, "");
  if (!t) return 0;
  const m = t.match(/^(-?[\d.]+)\s*(Dr|Cr)?$/i);
  if (m) {
    let v = parseFloat(m[1]);
    if ((m[2] || "").toLowerCase() === "dr" && v > 0) v = -v;
    return v;
  }
  return parseFloat(t) || 0;
}
function fdc(v) {
  if (Math.abs(v) < 0.005) return {amount: 0, side: ""};
  return {amount: Math.round(Math.abs(v) * 100) / 100, side: v < 0 ? "Dr" : "Cr"};
}
const ex = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

async function fetchAll(builder) { // paginate past PostgREST's 1000-row limit
  let out = [], from = 0;
  for (;;) {
    const {data, error} = await builder().range(from, from + 999);
    if (error) throw new Error(error.message);
    out = out.concat(data || []);
    if (!data || data.length < 1000) return out;
    from += 1000;
  }
}
function err(e) { throw new Error(e.message || String(e)); }

const ASSET_T = new Set(["fixed assets","investments","current assets","misc. expenses (asset)","suspense a/c","bank accounts","cash-in-hand","stock-in-hand","sundry debtors","deposits (asset)","loans & advances (asset)"]);
const LIAB_T  = new Set(["capital account","loans (liability)","current liabilities","branch / divisions","reserves & surplus","bank od a/c","secured loans","unsecured loans","duties & taxes","provisions","sundry creditors"]);
const INC_T   = new Set(["sales accounts","direct incomes","indirect incomes","income (direct)","income (indirect)"]);
const EXP_T   = new Set(["purchase accounts","direct expenses","indirect expenses","expenses (direct)","expenses (indirect)"]);
function topGroup(name, gmap, depth = 0) {
  if (!name || depth > 30) return name || "";
  const item = gmap[name.toLowerCase()];
  const p = item && typeof item === "object" ? item.parent : item;
  if (!p || ["", "primary"].includes(p.toLowerCase()) || p.toLowerCase() === name.toLowerCase()) return name;
  return topGroup(p, gmap, depth + 1);
}
function natureOf(top) {
  if (!top) return "asset";
  const t = top.toLowerCase();
  if (window.S && window.S.groupNatures && window.S.groupNatures[t]) {
    return window.S.groupNatures[t];
  }
  if (INC_T.has(t)) return "income";
  if (EXP_T.has(t)) return "expense";
  if (LIAB_T.has(t)) return "liability";
  return "asset";
}
async function getGroupNatureMap() {
  const gmap = {};
  try {
    const grows = await fetchAll(() => sb.from("groups").select("name,parent,nature"));
    grows.forEach((g) => {
      gmap[g.name.toLowerCase()] = { parent: g.parent || "", nature: g.nature || "" };
    });
  } catch (e) {
    const grows = await fetchAll(() => sb.from("groups").select("name,parent"));
    grows.forEach((g) => {
      gmap[g.name.toLowerCase()] = { parent: g.parent || "", nature: "" };
    });
  }
  return gmap;
}
function natureOfGroup(groupName, gmap) {
  if (!groupName) return "asset";
  const nameLower = groupName.toLowerCase();
  const g = gmap[nameLower];
  if (g && g.nature) return g.nature;
  let parent = g ? g.parent : "";
  let depth = 0;
  while (parent && depth < 30) {
    const pg = gmap[parent.toLowerCase()];
    if (pg && pg.nature) return pg.nature;
    parent = pg ? pg.parent : "";
    depth++;
  }
  const n = nameLower;
  if (n.includes("capital") || n.includes("loan") || n.includes("liab") || n.includes("creditor") || n.includes("tax") || n.includes("provision") || n.includes("reserve")) return "liability";
  if (n.includes("asset") || n.includes("bank") || n.includes("cash") || n.includes("stock") || n.includes("debtor") || n.includes("deposit") || n.includes("advance") || n === "suspense a/c") return "asset";
  if (n.includes("sales") || n.includes("income") || n.includes("revenue")) return "income";
  if (n.includes("purchase") || n.includes("expense") || n.includes("cost") || n.includes("expenditure")) return "expense";
  if (INC_T.has(nameLower)) return "income";
  if (EXP_T.has(nameLower)) return "expense";
  if (LIAB_T.has(nameLower)) return "liability";
  return "asset";
}
const DEFAULT_GROUPS = ["Bank Accounts","Bank OD A/c","Branch / Divisions","Capital Account","Cash-in-Hand","Current Assets","Current Liabilities","Deposits (Asset)","Direct Expenses","Direct Incomes","Duties & Taxes","Fixed Assets","Indirect Expenses","Indirect Incomes","Investments","Loans & Advances (Asset)","Loans (Liability)","Misc. Expenses (ASSET)","Provisions","Purchase Accounts","Reserves & Surplus","Sales Accounts","Secured Loans","Stock-in-Hand","Sundry Creditors","Sundry Debtors","Suspense A/c","Unsecured Loans"];

const dal = {
  async status() {
    const cnt = async (t, extra) => {
      let q = sb.from(t).select("id", {count: "exact", head: true});
      if (extra) q = q.eq("source", extra);
      const {count, error} = await q;
      if (error) err(error);
      return count || 0;
    };
    const cntBlankParents = async () => {
      const {count, error} = await sb.from("ledgers")
        .select("name", {count: "exact", head: true})
        .eq("parent", "")
        .neq("name", "Profit & Loss A/c");
      if (error) return 0;
      return count || 0;
    };
    const [ledgers, vouchers, groups, new_vouchers, blank_parents] = await Promise.all([
      cnt("ledgers"), cnt("vouchers"), cnt("groups"), cnt("vouchers", "new"),
      cntBlankParents()
    ]);
    return {
      ledgers, vouchers, groups, new_vouchers, blank_parents
    };
  },

  async ledgers() {
    const rows = await fetchAll(() => sb.from("ledger_balances")
      .select("name,parent,closing").order("name"));
    return rows.map((r) => ({name: r.name, parent: r.parent || "", ...fdc(+r.closing)}));
  },

  async groups() {
    try {
      const rows = await fetchAll(() => sb.from("groups").select("name,parent,nature").order("name"));
      return rows.length ? rows : DEFAULT_GROUPS.map((g) => ({name: g, parent: "", nature: ""}));
    } catch (e) {
      const rows = await fetchAll(() => sb.from("groups").select("name,parent").order("name"));
      return rows.map((r) => ({name: r.name, parent: r.parent || "", nature: ""}));
    }
  },

  shapeVouchers(rows) {
    return rows.map((v) => {
      let totalDr = 0;
      const entries = (v.entries || []).map((e) => {
        if (+e.amount < 0) totalDr += -e.amount;
        return {ledger: e.ledger, ...fdc(+e.amount)};
      });
      const d = v.date;
      return {
        date: `${d.slice(6, 8)}-${d.slice(4, 6)}-${d.slice(0, 4)}`,
        type: v.vchtype, number: v.number || "", party: v.party || "",
        narration: v.narration || "", amount: Math.round(totalDr * 100) / 100,
        entries, remoteid: `local:${v.id}`, vchkey: "-", vchtype: v.vchtype,
        isnew: v.source === "new",
      };
    });
  },

  async daybook(dfrom, dto) {
    const rows = await fetchAll(() => sb.from("vouchers")
      .select("*, entries(ledger,amount)")
      .gte("date", dfrom || "00000000").lte("date", dto || "99999999")
      .order("date").order("id"));
    return dal.shapeVouchers(rows);
  },

  async salesRegister(dfrom, dto) {
    const rows = await fetchAll(() => sb.from("vouchers")
      .select("*, entries(ledger,amount)")
      .eq("vchtype", "Sales")
      .gte("date", dfrom || "00000000").lte("date", dto || "99999999")
      .order("date").order("id"));
    return dal.shapeVouchers(rows);
  },

  async purchaseRegister(dfrom, dto) {
    const rows = await fetchAll(() => sb.from("vouchers")
      .select("*, entries(ledger,amount)")
      .eq("vchtype", "Purchase")
      .gte("date", dfrom || "00000000").lte("date", dto || "99999999")
      .order("date").order("id"));
    return dal.shapeVouchers(rows);
  },

  async ledgerVouchers(ledger, dfrom, dto) {
    const ids = await fetchAll(() => sb.from("entries").select("vid").eq("ledger", ledger));
    const vids = [...new Set(ids.map((r) => r.vid))];
    if (!vids.length) return [];
    let rows = [];
    for (let i = 0; i < vids.length; i += 200) {
      rows = rows.concat(await fetchAll(() => sb.from("vouchers")
        .select("*, entries(ledger,amount)").in("id", vids.slice(i, i + 200))
        .gte("date", dfrom || "00000000").lte("date", dto || "99999999")
        .order("date").order("id")));
    }
    return dal.shapeVouchers(rows);
  },

  async closings(dto) { // ledger -> {parent, closing}; optional as-on date
    const leds = await fetchAll(() => sb.from("ledgers").select("name,parent,opening"));
    let ents;
    if (dto) {
      ents = await fetchAll(() => sb.from("entries")
        .select("ledger,amount,vouchers!inner(date)").lte("vouchers.date", dto));
    } else {
      ents = await fetchAll(() => sb.from("entries").select("ledger,amount"));
    }
    const sums = {};
    ents.forEach((e) => { sums[e.ledger] = (sums[e.ledger] || 0) + (+e.amount); });
    const out = {};
    leds.forEach((l) => {
      out[l.name] = {parent: l.parent || "", closing: (+l.opening || 0) + (sums[l.name] || 0)};
    });
    return out;
  },

  async trialBalance(dto) {
    const cl = await dal.closings(dto);
    const grows = await fetchAll(() => sb.from("groups").select("name,parent"));
    const gmap = {};
    grows.forEach((g) => { gmap[g.name.toLowerCase()] = g.parent || ""; });
    const agg = {};
    for (const [name, v] of Object.entries(cl)) {
      const top = v.parent ? topGroup(v.parent, gmap) : (name.toLowerCase() === "profit & loss a/c" ? "Profit & Loss A/c" : "Suspense A/c");
      agg[top] = agg[top] || [0, 0];
      if (v.closing < -0.004) agg[top][0] += -v.closing;
      else if (v.closing > 0.004) agg[top][1] += v.closing;
    }
    return Object.keys(agg).sort().filter((k) => agg[k][0] || agg[k][1])
      .map((k) => ({name: k, debit: Math.round(agg[k][0] * 100) / 100,
                    credit: Math.round(agg[k][1] * 100) / 100}));
  },

  async columnarTrialBalance(dfrom, dto) {
    const grows = await fetchAll(() => sb.from("groups").select("name,parent"));
    const leds = await fetchAll(() => sb.from("ledgers").select("name,parent,opening"));
    
    const prevDate = subDaysYMD(ymd(dfrom), 1);
    const openCl = await dal.closings(prevDate);
    const ents = await fetchAll(() => sb.from("entries")
      .select("ledger,amount,vouchers!inner(date)")
      .gte("vouchers.date", ymd(dfrom))
      .lte("vouchers.date", ymd(dto)));
    
    const ledFlows = {};
    ents.forEach(e => {
      if (!ledFlows[e.ledger]) ledFlows[e.ledger] = { debitFlow: 0, creditFlow: 0 };
      const amt = parseFloat(e.amount || 0);
      if (amt < 0) ledFlows[e.ledger].debitFlow += Math.abs(amt);
      else ledFlows[e.ledger].creditFlow += Math.abs(amt);
    });
    
    const rawLedgers = leds.map(l => {
      const openVal = openCl[l.name] ? openCl[l.name].closing : (+l.opening || 0);
      const flows = ledFlows[l.name] || { debitFlow: 0, creditFlow: 0 };
      const closeVal = openVal + (flows.creditFlow - flows.debitFlow);
      
      return {
        name: l.name,
        parent: l.parent || "",
        isLedger: true,
        openDr: openVal < 0 ? Math.abs(openVal) : 0,
        openCr: openVal > 0 ? openVal : 0,
        debit: flows.debitFlow,
        credit: flows.creditFlow,
        closeDr: closeVal < 0 ? Math.abs(closeVal) : 0,
        closeCr: closeVal > 0 ? closeVal : 0
      };
    });
    
    return {
      groups: grows,
      ledgers: rawLedgers
    };
  },

  async naturedTotals(dto) {
    const cl = await dal.closings(dto);
    const gmap = await getGroupNatureMap();
    const byTop = {};
    for (const [name, v] of Object.entries(cl)) {
      if (Math.abs(v.closing) < 0.005) continue;
      if (isPLLedger(name)) continue;
      const top = v.parent ? topGroup(v.parent, gmap) : "Suspense A/c";
      byTop[top] = (byTop[top] || 0) + v.closing;
    }
    return byTop;
  },

  async balanceSheet(dto) {
    const cl = await dal.closings(dto);
    const gmap = await getGroupNatureMap();
    
    let plOpening = 0;
    const plKey = Object.keys(cl).find(isPLLedger);
    if (plKey) {
      plOpening = cl[plKey].closing;
    }
    
    const byTop = {};
    for (const [name, v] of Object.entries(cl)) {
      if (Math.abs(v.closing) < 0.005) continue;
      if (isPLLedger(name)) continue;
      const top = v.parent ? topGroup(v.parent, gmap) : "Suspense A/c";
      byTop[top] = (byTop[top] || 0) + v.closing;
    }
    
    let currentPnl = 0;
    for (const [top, val] of Object.entries(byTop)) {
      const nat = natureOfGroup(top, gmap);
      if (nat === "income" || nat === "expense") {
        currentPnl += val;
      }
    }
    
    const totalPnl = plOpening + currentPnl;
    
    const liab = [], asset = [];
    for (const [top, val] of Object.entries(byTop)) {
      const nat = natureOfGroup(top, gmap);
      if (nat === "income" || nat === "expense") continue;
      if (nat === "liability") {
        liab.push({name: top, ...fdc(val)});
      } else {
        asset.push({name: top, ...fdc(val)});
      }
    }
    
    if (Math.abs(totalPnl) >= 0.005) {
      liab.push({name: "Profit & Loss A/c", ...fdc(totalPnl)});
    }
    
    const totalLiabVal = liab.reduce((s, r) => s + (r.side === "Cr" ? r.amount : -r.amount), 0);
    const totalAssetVal = asset.reduce((s, r) => s + (r.side === "Dr" ? r.amount : -r.amount), 0);
    
    const diff = totalLiabVal - totalAssetVal;
    if (Math.abs(diff) > 0.005) {
      if (diff > 0) {
        asset.push({name: "Difference in Opening Balances", amount: Math.round(Math.abs(diff) * 100) / 100, side: "Dr"});
      } else {
        liab.push({name: "Difference in Opening Balances", amount: Math.round(Math.abs(diff) * 100) / 100, side: "Cr"});
      }
    }
    
    const finalLiabTotal = liab.reduce((s, r) => s + (r.side === "Cr" ? r.amount : -r.amount), 0);
    const finalAssetTotal = asset.reduce((s, r) => s + (r.side === "Dr" ? r.amount : -r.amount), 0);
    
    const sortedLiab = liab.filter(r => r.name !== "Profit & Loss A/c" && r.name !== "Difference in Opening Balances")
      .sort((a,b) => a.name.localeCompare(b.name));
    const plRow = liab.find(r => r.name === "Profit & Loss A/c");
    const diffLiabRow = liab.find(r => r.name === "Difference in Opening Balances");
    if (plRow) sortedLiab.push(plRow);
    if (diffLiabRow) sortedLiab.push(diffLiabRow);

    const sortedAsset = asset.filter(r => r.name !== "Difference in Opening Balances")
      .sort((a,b) => a.name.localeCompare(b.name));
    const diffAssetRow = asset.find(r => r.name === "Difference in Opening Balances");
    if (diffAssetRow) sortedAsset.push(diffAssetRow);
    
    return {
      type: "balanceSheet",
      liabilities: sortedLiab,
      assets: sortedAsset,
      liabTotal: Math.round(Math.abs(finalLiabTotal) * 100) / 100,
      assetTotal: Math.round(Math.abs(finalAssetTotal) * 100) / 100
    };
  },

  async periodNaturedTotals(dfrom, dto) {
    const gmap = await getGroupNatureMap();
    const leds = await fetchAll(() => sb.from("ledgers").select("name,parent,opening"));
    
    const ents = await fetchAll(() => sb.from("entries")
      .select("ledger,amount,vouchers!inner(date)")
      .gte("vouchers.date", ymd(dfrom))
      .lte("vouchers.date", ymd(dto)));
    
    const sums = {};
    ents.forEach(e => { sums[e.ledger] = (sums[e.ledger] || 0) + (+e.amount); });
    
    const fromY = parseInt(dfrom.slice(0, 4));
    const fromM = parseInt(dfrom.slice(4, 6));
    const fyStartYear = fromM >= 4 ? fromY : fromY - 1;
    const fyStartDateStr = `${fyStartYear}0401`;
    
    const includeOpening = ymd(dfrom) <= fyStartDateStr;
    
    const byTop = {};
    for (const l of leds) {
      if (isPLLedger(l.name)) continue;
      const top = l.parent ? topGroup(l.parent, gmap) : "Suspense A/c";
      let val = sums[l.name] || 0;
      const nat = natureOfGroup(top, gmap);
      if (nat === "income" || nat === "expense") {
        if (includeOpening) {
          val += (+l.opening || 0);
        }
      }
      if (Math.abs(val) < 0.005) continue;
      byTop[top] = (byTop[top] || 0) + val;
    }
    return byTop;
  },

  async pnl(dfrom, dto) {
    const byTop = await dal.periodNaturedTotals(dfrom, dto);
    
    const prevDate = subDaysYMD(ymd(dfrom), 1);
    const clFrom = await dal.closings(prevDate);
    const clTo = await dal.closings(dto);
    
    const gmap = await getGroupNatureMap();
    
    let openingStock = 0, closingStock = 0;
    for (const [name, v] of Object.entries(clFrom)) {
      if (isPLLedger(name)) continue;
      const top = v.parent ? topGroup(v.parent, gmap) : "Suspense A/c";
      if (top.toLowerCase() === "stock-in-hand") {
        openingStock += -v.closing;
      }
    }
    for (const [name, v] of Object.entries(clTo)) {
      if (isPLLedger(name)) continue;
      const top = v.parent ? topGroup(v.parent, gmap) : "Suspense A/c";
      if (top.toLowerCase() === "stock-in-hand") {
        closingStock += -v.closing;
      }
    }
    
    let sales = 0, purchases = 0, directExp = 0, directInc = 0, indirectExp = 0, indirectInc = 0;
    const tradingExpItems = [];
    const tradingIncItems = [];
    const pnlExpItems = [];
    const pnlIncItems = [];
    
    for (const [top, val] of Object.entries(byTop)) {
      const t = top.toLowerCase();
      if (t === "stock-in-hand" || t === "suspense a/c") continue;
      
      const nat = natureOfGroup(top, gmap);
      const isDirect = t.includes("direct") || t.includes("purchase") || t.includes("sales");
      
      if (nat === "income") {
        if (isDirect) {
          directInc += val;
          tradingIncItems.push({name: top, ...fdc(val)});
        } else {
          indirectInc += val;
          pnlIncItems.push({name: top, ...fdc(val)});
        }
      } else if (nat === "expense") {
        if (isDirect) {
          directExp += val;
          tradingExpItems.push({name: top, ...fdc(val)});
        } else {
          indirectExp += val;
          pnlExpItems.push({name: top, ...fdc(val)});
        }
      }
    }
    
    tradingExpItems.sort((a,b) => a.name.localeCompare(b.name));
    tradingIncItems.sort((a,b) => a.name.localeCompare(b.name));
    pnlExpItems.sort((a,b) => a.name.localeCompare(b.name));
    pnlIncItems.sort((a,b) => a.name.localeCompare(b.name));
    
    if (openingStock) {
      tradingExpItems.unshift({name: "Opening Stock", ...fdc(-openingStock)});
    }
    if (closingStock) {
      tradingIncItems.push({name: "Closing Stock", ...fdc(closingStock)});
    }
    
    const creditTradingSum = (directInc) + closingStock;
    const debitTradingSum = (directExp) + openingStock;
    
    const grossProfit = creditTradingSum + debitTradingSum;
    
    const tradingLeft = [...tradingExpItems];
    const tradingRight = [...tradingIncItems];
    
    let gpVal = 0, glVal = 0;
    if (grossProfit >= 0) {
      gpVal = grossProfit;
      tradingLeft.push({name: "Gross Profit c/o", ...fdc(-grossProfit)});
    } else {
      glVal = -grossProfit;
      tradingRight.push({name: "Gross Loss c/o", ...fdc(grossProfit)});
    }
    
    const tradingTotal = Math.max(
      tradingLeft.reduce((s, r) => s + (r.side === "Dr" ? r.amount : -r.amount), 0),
      tradingRight.reduce((s, r) => s + (r.side === "Cr" ? r.amount : -r.amount), 0)
    );
    
    const pnlLeft = [...pnlExpItems];
    const pnlRight = [...pnlIncItems];
    
    if (grossProfit >= 0) {
      pnlRight.unshift({name: "Gross Profit b/d", ...fdc(grossProfit)});
    } else {
      pnlLeft.unshift({name: "Gross Loss b/d", ...fdc(-grossProfit)});
    }
    
    const netProfit = grossProfit + indirectInc + indirectExp;
    
    if (netProfit >= 0) {
      pnlLeft.push({name: "Net Profit", ...fdc(-netProfit)});
    } else {
      pnlRight.push({name: "Net Loss", ...fdc(netProfit)});
    }
    
    const pnlTotal = Math.max(
      pnlLeft.reduce((s, r) => s + (r.side === "Dr" ? r.amount : -r.amount), 0),
      pnlRight.reduce((s, r) => s + (r.side === "Cr" ? r.amount : -r.amount), 0)
    );
    
    return {
      type: "pnl",
      tradingLeft,
      tradingRight,
      pnlLeft,
      pnlRight,
      tradingTotal: Math.round(Math.abs(tradingTotal) * 100) / 100,
      pnlTotal: Math.round(Math.abs(pnlTotal) * 100) / 100
    };
  },

  async createLedger(b) {
    let opening = Math.abs(parseFloat(b.opening) || 0);
    if ((b.openingSide || "Dr") === "Dr") opening = -opening;
    const {error} = await sb.from("ledgers")
      .insert({name: norm(b.name), parent: norm(b.parent), opening});
    if (error) return {ok: false, lineerror: error.message};
    return {ok: true, created: 1};
  },

  async createVoucher(b) {
    const dr = b.rows.filter((r) => r.side === "Dr").reduce((s, r) => s + +r.amount, 0);
    const cr = b.rows.filter((r) => r.side === "Cr").reduce((s, r) => s + +r.amount, 0);
    if (Math.abs(dr - cr) > 0.005)
      return {ok: false, lineerror: `Voucher not balanced (Dr ${dr.toFixed(2)} / Cr ${cr.toFixed(2)})`};
      
    // Enforce cash/bank guard-rails
    const grows = await fetchAll(() => sb.from("groups").select("name,parent"));
    const gmap = {};
    grows.forEach((g) => { gmap[g.name.toLowerCase()] = g.parent || ""; });
    
    const leds = await fetchAll(() => sb.from("ledgers").select("name,parent"));
    const ledParent = {};
    leds.forEach((l) => { ledParent[l.name.toLowerCase()] = l.parent || ""; });
    
    const isCashBank = (ledgerName) => {
      const parent = ledParent[ledgerName.toLowerCase()];
      if (!parent) return false;
      const top = topGroup(parent, gmap).toLowerCase();
      return ["bank accounts", "cash-in-hand", "bank od a/c"].includes(top);
    };

    if (b.vchtype === "Contra") {
      const nonCB = b.rows.find(r => !isCashBank(r.ledger));
      if (nonCB) {
        return {ok: false, lineerror: `Contra voucher requires Cash/Bank accounts on both sides. '${nonCB.ledger}' is not a Cash/Bank account.`};
      }
    } else if (b.vchtype === "Payment") {
      const crRows = b.rows.filter(r => r.side === "Cr");
      const nonCBCr = crRows.find(r => !isCashBank(r.ledger));
      if (nonCBCr) {
        return {ok: false, lineerror: `Payment voucher must credit a Cash/Bank account. '${nonCBCr.ledger}' is not a Cash/Bank account.`};
      }
    } else if (b.vchtype === "Receipt") {
      const drRows = b.rows.filter(r => r.side === "Dr");
      const nonCBDr = drRows.find(r => !isCashBank(r.ledger));
      if (nonCBDr) {
        return {ok: false, lineerror: `Receipt voucher must debit a Cash/Bank account. '${nonCBDr.ledger}' is not a Cash/Bank account.`};
      }
    }

    // Determine smart party based on type
    let party = b.rows[0].ledger;
    if (b.vchtype === "Payment") {
      const crCB = b.rows.find(r => r.side === "Cr" && isCashBank(r.ledger));
      if (crCB) party = crCB.ledger;
    } else if (b.vchtype === "Receipt") {
      const drCB = b.rows.find(r => r.side === "Dr" && isCashBank(r.ledger));
      if (drCB) party = drCB.ledger;
    } else if (b.vchtype === "Contra") {
      const crCB = b.rows.find(r => r.side === "Cr" && isCashBank(r.ledger));
      if (crCB) party = crCB.ledger;
    } else if (b.vchtype === "Sales") {
      const drRow = b.rows.find(r => r.side === "Dr");
      if (drRow) party = drRow.ledger;
    } else if (b.vchtype === "Purchase") {
      const crRow = b.rows.find(r => r.side === "Cr");
      if (crRow) party = crRow.ledger;
    }
    party = norm(party);

    const {data, error} = await sb.from("vouchers").insert({
      date: b.date, vchtype: b.vchtype, number: b.number || "",
      party, narration: b.narration || "", source: "new",
    }).select("id").single();
    if (error) return {ok: false, lineerror: error.message};
    
    const ents = b.rows.map((r) => ({
      vid: data.id, ledger: norm(r.ledger),
      amount: r.side === "Dr" ? -Math.abs(+r.amount) : Math.abs(+r.amount),
    }));
    const {error: e2} = await sb.from("entries").insert(ents);
    if (e2) return {ok: false, lineerror: e2.message};
    
    // make sure ledgers exist for autocomplete next time
    for (const r of b.rows) {
      await sb.from("ledgers").upsert({name: norm(r.ledger), parent: "", opening: 0},
        {onConflict: "name", ignoreDuplicates: true});
    }
    return {ok: true, created: 1};
  },

  async deleteVoucher(remoteid) {
    const id = +remoteid.split(":")[1];
    const {error} = await sb.from("vouchers").delete().eq("id", id);
    if (error) return {ok: false, lineerror: error.message};
    return {ok: true, deleted: 1};
  },

  async resetData() {
    for (const t of ["vouchers", "ledgers", "groups"]) {
      const {error} = await sb.from(t).delete().gte("id", 0);
      if (error) return {ok: false, lineerror: error.message};
    }
    return {ok: true};
  },

  /* -------- client-side Tally XML import -------- */
  async importFiles(files, replace, progress) {
    const parsedFiles = [];
    const ft = (el, tag) => {
      const n = el.getElementsByTagName(tag)[0];
      return n && n.textContent ? n.textContent : "";
    };
    
    // 1. Read and validate all files first
    for (const f of files) {
      progress(`Reading and validating ${f.name}…`);
      let text = await f.text();
      text = text.replace(/&#(?:[0-8]|1[124-9]|2[0-9]|3[01]);/g, "")
                 .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
      const doc = new DOMParser().parseFromString(text, "text/xml");
      if (doc.getElementsByTagName("parsererror").length) {
        throw new Error(`${f.name} is not a valid XML file.`);
      }
      parsedFiles.push({ file: f, doc });
    }
    
    // 2. Perform reset if requested
    if (replace) {
      progress("Clearing database…");
      await dal.resetData();
    }
    
    let tg = 0, tl = 0, tv = 0, company = "";
    const errors = [];
    
    // 3. Fetch existing keys if merging
    let existingKeys = new Set();
    if (!replace) {
      try {
        progress("Checking existing data to prevent duplicates…");
        const existing = await fetchAll(() => sb.from("vouchers").select("date,vchtype,number,party,narration"));
        existing.forEach(v => {
          existingKeys.add(`${v.date}|${v.vchtype}|${v.number || ""}|${v.party || ""}|${v.narration || ""}`);
        });
      } catch (e) {
        // config table/database might be empty
      }
    }
    
    // 4. Process the validated documents
    for (const { file, doc } of parsedFiles) {
      try {
        progress(`Processing ${file.name}…`);
        company = company || ft(doc, "SVCURRENTCOMPANY") || ft(doc, "COMPANYNAME");
        
        const rawGroups = [...doc.getElementsByTagName("GROUP")].map((g) => {
          const name = norm(g.getAttribute("NAME") || ft(g, "NAME"));
          const parent = norm(ft(g, "PARENT"));
          let basicType = ft(g, "BASICGROUPTYPE") || ft(g, "PRIMARYGROUP");
          basicType = basicType ? basicType.trim().toLowerCase() : "";
          return { name, parent, basicType };
        }).filter((g) => g.name);

        const gmap = {};
        rawGroups.forEach(g => { gmap[g.name.toLowerCase()] = g; });

        const guessNatureFromName = (name) => {
          const n = name.toLowerCase();
          if (n.includes("capital") || n.includes("loan") || n.includes("liab") || n.includes("creditor") || n.includes("tax") || n.includes("provision") || n.includes("reserve")) return "liability";
          if (n.includes("asset") || n.includes("bank") || n.includes("cash") || n.includes("stock") || n.includes("debtor") || n.includes("deposit") || n.includes("advance")) return "asset";
          if (n.includes("sales") || n.includes("income") || n.includes("revenue")) return "income";
          if (n.includes("purchase") || n.includes("expense") || n.includes("cost") || n.includes("expenditure")) return "expense";
          return "asset";
        };

        const resolveNature = (gName) => {
          const nameLower = gName.toLowerCase();
          if (INC_T.has(nameLower)) return "income";
          if (EXP_T.has(nameLower)) return "expense";
          if (LIAB_T.has(nameLower)) return "liability";
          if (ASSET_T.has(nameLower)) return "asset";
          
          const g = gmap[nameLower];
          if (!g) return guessNatureFromName(gName);
          
          if (g.basicType) {
            const bt = g.basicType;
            if (bt.includes("liab")) return "liability";
            if (bt.includes("asset")) return "asset";
            if (bt.includes("inc") || bt.includes("sales")) return "income";
            if (bt.includes("exp") || bt.includes("purch")) return "expense";
          }
          
          if (g.parent && g.parent.toLowerCase() !== nameLower && g.parent.toLowerCase() !== "primary") {
            return resolveNature(g.parent);
          }
          
          return guessNatureFromName(gName);
        };

        const groups = rawGroups.map(g => ({
          name: g.name,
          parent: g.parent,
          nature: resolveNature(g.name)
        }));
        
        const ledgers = [...doc.getElementsByTagName("LEDGER")].map((l) => ({
          name: norm(l.getAttribute("NAME") || ft(l, "NAME")),
          parent: norm(ft(l, "PARENT")),
          opening: pa(ft(l, "OPENINGBALANCE")),
        })).filter((l) => l.name);
        
        for (let i = 0; i < groups.length; i += 500) {
          const chunk = groups.slice(i, i + 500);
          const {error} = await sb.from("groups").upsert(chunk, {onConflict: "name"});
          if (error) {
            // Fallback retry without nature in case column doesn't exist yet
            const fallbackChunk = chunk.map(({name, parent}) => ({name, parent}));
            const {error: e2} = await sb.from("groups").upsert(fallbackChunk, {onConflict: "name"});
            if (e2) err(e2);
          }
        }
        for (let i = 0; i < ledgers.length; i += 500) {
          const {error} = await sb.from("ledgers").upsert(ledgers.slice(i, i + 500), {onConflict: "name"});
          if (error) err(error);
        }
        tg += groups.length; tl += ledgers.length;
        
        const vEls = [...doc.getElementsByTagName("VOUCHER")];
        const vrows = [], erows = [];
        
        for (const v of vEls) {
          const d = ft(v, "DATE");
          if (!/^\d{8}$/.test(d)) continue;
          
          // E2. Filter out optional, cancelled, and post-dated
          const isOptional = ft(v, "ISOPTIONAL") === "Yes";
          const isCancelled = ft(v, "ISCANCELLED") === "Yes";
          const isPostDated = ft(v, "ISPOSTDATED") === "Yes";
          if (isOptional || isCancelled || isPostDated) continue;

          const vchtype = ft(v, "VOUCHERTYPENAME") || v.getAttribute("VCHTYPE") || "Journal";
          const vno = ft(v, "VOUCHERNUMBER");
          const party = norm(ft(v, "PARTYLEDGERNAME") || ft(v, "PARTYNAME"));
          const narration = ft(v, "NARRATION");
          
          const fingerprint = `${d}|${vchtype}|${vno || ""}|${party || ""}|${narration || ""}`;
          if (!replace && existingKeys.has(fingerprint)) {
            continue; // Skip duplicate voucher
          }
          
          // E1. Parse all LEDGERNAME nodes recursively
          const ents = [];
          const ledgerNameTags = v.getElementsByTagName("LEDGERNAME");
          for (const lNameTag of ledgerNameTags) {
            const leNode = lNameTag.parentNode;
            const lname = norm(lNameTag.textContent);
            if (lname && leNode) {
              const amtText = ft(leNode, "AMOUNT");
              ents.push({ledger: lname, amount: pa(amtText)});
            }
          }
          if (!ents.length) continue;

          // E3. Per-voucher balancing checks
          let vsum = 0;
          ents.forEach(e => { vsum += e.amount; });
          if (Math.abs(vsum) > 0.05) {
            errors.push(`Voucher #${vno || "(no number)"} on ${d} is out of balance by ${vsum.toFixed(2)}.`);
            continue;
          }
          
          vrows.push({
            date: d,
            vchtype,
            number: vno,
            party,
            narration,
            source: "import"
          });
          erows.push(ents);
        }
        
        for (let i = 0; i < vrows.length; i += 200) {
          progress(`Saving vouchers ${Math.min(i + 200, vrows.length)} / ${vrows.length}…`);
          const chunk = vrows.slice(i, i + 200);
          const {data, error} = await sb.from("vouchers").insert(chunk).select("id");
          if (error) err(error);
          
          const ents = [];
          data.forEach((row, j) =>
            erows[i + j].forEach((e) => ents.push({vid: row.id, ...e})));
          
          for (let k = 0; k < ents.length; k += 500) {
            const {error: e2} = await sb.from("entries").insert(ents.slice(k, k + 500));
            if (e2) err(e2);
          }
        }
        tv += vrows.length;
        
        // ledgers referenced only in vouchers
        const known = new Set(ledgers.map((l) => l.name));
        const missing = [...new Set(erows.flat().map((e) => e.ledger))]
          .filter((n) => !known.has(n)).map((n) => ({name: n, parent: "", opening: 0}));
        for (let i = 0; i < missing.length; i += 500) {
          await sb.from("ledgers").upsert(missing.slice(i, i + 500),
            {onConflict: "name", ignoreDuplicates: true});
        }
      } catch (e) {
        errors.push(`${file.name}: ${e.message}`);
      }
    }
    
    if (company) {
      localStorage.setItem("tw_company", company);
      try {
        await sb.from("config").upsert({key: "company_name", value: company});
      } catch (e) {
        // config table doesn't exist yet
      }
    }
    return {ok: !errors.length || (tg + tl + tv) > 0,
            groups: tg, ledgers: tl, vouchers: tv, errors};
  },

  /* -------- export new vouchers as Tally import XML -------- */
  async exportNewXML() {
    const rows = await fetchAll(() => sb.from("vouchers")
      .select("*, entries(ledger,amount)").eq("source", "new").order("date").order("id"));
    let msgs = "";
    for (const v of rows) {
      let entries = "";
      for (const e of v.entries) {
        entries += `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${ex(e.ledger)}</LEDGERNAME>` +
          `<ISDEEMEDPOSITIVE>${+e.amount < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>` +
          `<AMOUNT>${(+e.amount).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
      }
      msgs += `<VOUCHER VCHTYPE="${ex(v.vchtype)}" ACTION="Create">` +
        `<DATE>${v.date}</DATE><EFFECTIVEDATE>${v.date}</EFFECTIVEDATE>` +
        `<VOUCHERTYPENAME>${ex(v.vchtype)}</VOUCHERTYPENAME>` +
        (v.number ? `<VOUCHERNUMBER>${ex(v.number)}</VOUCHERNUMBER>` : "") +
        `<PARTYLEDGERNAME>${ex(v.party)}</PARTYLEDGERNAME>` +
        `<NARRATION>${ex(v.narration || "")}</NARRATION>` +
        `<ISINVOICE>No</ISINVOICE>${entries}</VOUCHER>`;
    }
    return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
      `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>` +
      `<STATICVARIABLES></STATICVARIABLES></REQUESTDESC><REQUESTDATA>` +
      `<TALLYMESSAGE xmlns:UDF="TallyUDF">${msgs}</TALLYMESSAGE>` +
      `</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  },

  async markNewVouchersExported() {
    const {error} = await sb.from("vouchers")
      .update({source: "import"})
      .eq("source", "new");
    if (error) return {ok: false, lineerror: error.message};
    return {ok: true};
  },
};

/* api() shim: routes the existing UI's calls to the Supabase data layer */
async function api(path, opts) {
  const [p, qs] = path.split("?");
  const q = Object.fromEntries(new URLSearchParams(qs || ""));
  const body = opts && opts.body ? JSON.parse(opts.body) : null;

  // PIN Gate
  const pin = (window.TALLY_CONFIG.APP_PIN || "").toString().trim();
  const allowed = ["/api/config", "/api/ping", "/api/data-status"];
  if (pin && sessionStorage.getItem("tw_auth") !== "1" && !allowed.includes(p)) {
    throw new Error("Unauthorized: Application is locked");
  }

  switch (p) {
    case "/api/config": return {mode: "cloud"};
    case "/api/ping": return {ok: true, message: "cloud"};
    case "/api/data-status": return {mode: "cloud",
      company: localStorage.getItem("tw_company") || "", ...(await dal.status())};
    case "/api/companies": return [{name: localStorage.getItem("tw_company") || "", from: ""}];
    case "/api/ledgers": return dal.ledgers();
    case "/api/groups": return dal.groups();
    case "/api/daybook": return dal.daybook(q.from, q.to);
    case "/api/ledger-vouchers": return dal.ledgerVouchers(q.ledger, q.from, q.to);
    case "/api/trial-balance": return dal.trialBalance(q.to);
    case "/api/columnar-trial-balance": return dal.columnarTrialBalance(q.from, q.to);
    case "/api/sales-register": return dal.salesRegister(q.from, q.to);
    case "/api/purchase-register": return dal.purchaseRegister(q.from, q.to);
    case "/api/balance-sheet": return dal.balanceSheet(q.to);
    case "/api/pnl": return dal.pnl(q.from, q.to);
    case "/api/stock-summary": return [];
    case "/api/ledger": return dal.createLedger(body);
    case "/api/voucher": return dal.createVoucher(body);
    case "/api/voucher/delete": return dal.deleteVoucher(body.remoteid);
    case "/api/voucher/mark-exported": return dal.markNewVouchersExported();
    case "/api/reset-data": return dal.resetData();
    default: throw new Error("Unknown route " + p);
  }
}

/* -------------------------------------------------------------- state --- */
const S = {
  cfg: {}, ledgers: [], groups: [], vchTypes: [],
  period: {from: "", to: ""}, vdate: "",
  stack: [],
};
(function initDates() {
  const t = new Date(Date.now() + 19800000); // Shift UTC to Indian Standard Time (+5:30)
  const fyStartYear = t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1;
  const iso = (d) => d.toISOString().slice(0, 10);
  S.period.from = `${fyStartYear}-04-01`;
  S.period.to = iso(t);
  S.vdate = iso(t);
})();

function periodLabel() {
  $("periodLabel").textContent = `${tdate(S.period.from)} to ${tdate(S.period.to)}`;
}

/* --------------------------------------------------- screen framework --- */
function render() {
  const scr = S.stack[S.stack.length - 1];
  $("screenTitle").textContent = scr.title;
  const el = $("screen");
  el.innerHTML = "";
  scr.render(el);
}
function push(screen) { S.stack.push(screen); render(); }
function pop() {
  if (S.stack.length > 1) { S.stack.pop(); render(); }
}
function replaceTop(screen) { S.stack[S.stack.length - 1] = screen; render(); }

/* --------------------------------------------------------------- modal --- */
let modalKeyHandler = null;
function openModal(title, bodyHTML, actions, onOpen, onKey) {
  $("modalBox").innerHTML =
    `<div class="mt">${esc(title)}</div><div class="mb">${bodyHTML}</div>
     <div class="ma">${actions}</div>`;
  $("modal").classList.remove("hidden");
  modalKeyHandler = onKey || null;
  if (onOpen) onOpen();
}
function closeModal() {
  $("modal").classList.add("hidden");
  $("modalBox").innerHTML = "";
  modalKeyHandler = null;
}
$("modal").addEventListener("mousedown", (e) => {
  if (e.target.id === "modal") {
    const pin = (window.TALLY_CONFIG.APP_PIN || "").toString().trim();
    if (pin && sessionStorage.getItem("tw_auth") !== "1") {
      return; // prevent click-outside bypass when locked
    }
    closeModal();
  }
});

/* --------------------------------------------------------------- theme --- */
function initTheme() {
  const theme = localStorage.getItem("tw_theme") || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  setTheme(theme);
  const toggle = document.getElementById("themeToggle");
  if (toggle) {
    toggle.onclick = () => {
      const cur = document.body.classList.contains("light-theme") ? "dark" : "light";
      setTheme(cur);
    };
  }
}
function setTheme(theme) {
  if (theme === "light") {
    document.body.classList.add("light-theme");
    document.body.classList.remove("dark-theme");
    const text = document.getElementById("themeText");
    if (text) text.textContent = "Light";
    localStorage.setItem("tw_theme", "light");
  } else {
    document.body.classList.add("dark-theme");
    document.body.classList.remove("light-theme");
    const text = document.getElementById("themeText");
    if (text) text.textContent = "Dark";
    localStorage.setItem("tw_theme", "dark");
  }
}

/* ----------------------------------------------------------- dashboard --- */
function dashboardScreen() {
  return {
    title: "Dashboard Summary",
    render(el) {
      const div = document.createElement("div");
      div.className = "dashboard";
      div.innerHTML = `
        <div class="metrics-row">
          <div class="metric-card m-cash" style="cursor: pointer;" id="cardCash">
            <span class="metric-label">Cash & Bank</span>
            <span class="metric-value" id="dashCash">Loading…</span>
          </div>
          <div class="metric-card m-debtors" style="cursor: pointer;" id="cardDebtors">
            <span class="metric-label">Receivables (Debtors)</span>
            <span class="metric-value" id="dashDebtors">Loading…</span>
          </div>
          <div class="metric-card m-creditors" style="cursor: pointer;" id="cardCreditors">
            <span class="metric-label">Payables (Creditors)</span>
            <span class="metric-value" id="dashCreditors">Loading…</span>
          </div>
          <div class="metric-card m-profit" style="cursor: pointer;" id="cardProfit">
            <span class="metric-label">Net Profit / (Loss)</span>
            <span class="metric-value" id="dashProfit">Loading…</span>
          </div>
        </div>
        
        <div class="charts-grid" style="margin-top: 20px;">
          <div class="chart-card">
            <span class="chart-card-title">Monthly Income & Expenses</span>
            <div class="chart-wrapper">
              <canvas id="chartIncomeExpense"></canvas>
            </div>
          </div>
          <div class="chart-card">
            <span class="chart-card-title">Assets Distribution</span>
            <div class="chart-wrapper">
              <canvas id="chartAssetsLiabilities"></canvas>
            </div>
          </div>
        </div>
        
        <div class="charts-grid" style="margin-top: 20px;">
          <div class="chart-card">
            <span class="chart-card-title">Top Expense Groups</span>
            <div class="chart-wrapper">
              <canvas id="chartTopExpenses"></canvas>
            </div>
          </div>
          <div class="chart-card">
            <span class="chart-card-title">Monthly Net Profit Trend</span>
            <div class="chart-wrapper">
              <canvas id="chartProfitTrend"></canvas>
            </div>
          </div>
        </div>
      `;
      el.appendChild(div);
      
      // Wire up card clicks to open relevant reports
      $("cardCash").onclick = () => push(ledVchScreen("Cash"));
      $("cardDebtors").onclick = () => push(coaScreen());
      $("cardCreditors").onclick = () => push(coaScreen());
      $("cardProfit").onclick = () => push(simpleReport("Profit & Loss A/c", "/api/pnl", twoColTable));
      
      loadDashboardData();
    }
  };
}

async function loadDashboardData() {
  try {
    const status = await api("/api/data-status");
    if (!status.ledgers && !status.vouchers) {
      document.querySelectorAll(".metric-value").forEach(el => el.textContent = "—");
      return;
    }
    
    const [closings, dbVouchers] = await Promise.all([
      dal.closings(),
      api(`/api/daybook?from=${ymd(S.period.from)}&to=${ymd(S.period.to)}`)
    ]);
    
    const gmap = {};
    S.groups.forEach((g) => { gmap[g.name.toLowerCase()] = g.parent || ""; });
    
    let cashBank = 0;
    let debtors = 0;
    let creditors = 0;
    let netProfit = 0;
    
    for (const [name, l] of Object.entries(closings)) {
      const top = l.parent ? topGroup(l.parent, gmap) : "";
      const topL = top.toLowerCase();
      const nat = natureOf(top);
      
      if (topL === "bank accounts" || topL === "cash-in-hand") {
        cashBank += -l.closing;
      } else if (topL === "sundry debtors") {
        debtors += -l.closing;
      } else if (topL === "sundry creditors") {
        creditors += l.closing;
      }
      
      if (nat === "income" || nat === "expense") {
        netProfit += l.closing;
      }
    }
    
    const cashEl = $("dashCash");
    if (cashEl) cashEl.innerHTML = `${cashBank < 0 ? "-" : ""}${money(Math.abs(cashBank))} <span style="font-size:12px; font-weight:normal; color:var(--muted);">${cashBank >= 0 ? "Dr" : "Cr"}</span>`;
    
    const debtEl = $("dashDebtors");
    if (debtEl) debtEl.textContent = money(Math.max(0, debtors));
    
    const credEl = $("dashCreditors");
    if (credEl) credEl.textContent = money(Math.max(0, creditors));
    
    const profEl = $("dashProfit");
    if (profEl) profEl.innerHTML = `<span class="${netProfit >= 0 ? 'cr' : 'dr'}">${money(Math.abs(netProfit))} ${netProfit >= 0 ? 'Profit' : 'Loss'}</span>`;
    
    // Monthly aggregations
    const monthlyData = {};
    dbVouchers.forEach(v => {
      const parts = v.date.split('-');
      if (parts.length < 3) return;
      const yyyymm = parts[2] + '-' + parts[1];
      
      if (!monthlyData[yyyymm]) {
        monthlyData[yyyymm] = { income: 0, expense: 0 };
      }
      
      v.entries.forEach(e => {
        const ledInfo = closings[e.ledger] || { parent: "" };
        const top = ledInfo.parent ? topGroup(ledInfo.parent, gmap) : "";
        const nat = natureOf(top);
        
        if (nat === "income") {
          monthlyData[yyyymm].income += e.amount;
        } else if (nat === "expense") {
          monthlyData[yyyymm].expense += -e.amount;
        }
      });
    });
    
    const sortedMonths = Object.keys(monthlyData).sort();
    if (!sortedMonths.length) return;
    
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const labels = sortedMonths.map(m => {
      const [y, mm] = m.split("-");
      return monthNames[parseInt(mm) - 1] + " " + y.slice(2);
    });
    
    const incomes = sortedMonths.map(m => Math.max(0, Math.round(monthlyData[m].income * 100) / 100));
    const expenses = sortedMonths.map(m => Math.max(0, Math.round(monthlyData[m].expense * 100) / 100));
    const netProfits = sortedMonths.map(m => Math.round((monthlyData[m].income - monthlyData[m].expense) * 100) / 100);
    
    const expensesByGroup = {};
    for (const [name, l] of Object.entries(closings)) {
      const top = l.parent ? topGroup(l.parent, gmap) : "";
      const nat = natureOf(top);
      if (nat === "expense" && l.closing !== 0) {
        expensesByGroup[l.parent || "Expenses"] = (expensesByGroup[l.parent || "Expenses"] || 0) + (-l.closing);
      }
    }
    const topExpenses = Object.entries(expensesByGroup)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const expLabels = topExpenses.map(e => e[0]);
    const expData = topExpenses.map(e => Math.max(0, Math.round(e[1])));
    
    let fixedAssets = 0, currentAssets = 0, investments = 0, cashBankVal = 0, debtorsVal = 0, otherAssets = 0;
    for (const [name, l] of Object.entries(closings)) {
      const top = l.parent ? topGroup(l.parent, gmap) : "";
      const topL = top.toLowerCase();
      const nat = natureOf(top);
      if (nat === "asset") {
        const bal = -l.closing;
        if (topL === "fixed assets") fixedAssets += bal;
        else if (topL === "investments") investments += bal;
        else if (topL === "bank accounts" || topL === "cash-in-hand") cashBankVal += bal;
        else if (topL === "sundry debtors") debtorsVal += bal;
        else if (["current assets", "stock-in-hand", "deposits (asset)", "loans & advances (asset)"].includes(topL)) currentAssets += bal;
        else otherAssets += bal;
      }
    }
    
    if (typeof Chart === "undefined") {
      console.warn("Chart.js not loaded yet");
      return;
    }
    
    const isLight = document.body.classList.contains("light-theme");
    const textColor = isLight ? "#102a43" : "#f0f2f5";
    const gridColor = isLight ? "#d9e2ec" : "#222e35";
    
    new Chart($("chartIncomeExpense"), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          { label: "Income", data: incomes, backgroundColor: "#10b981", borderRadius: 4 },
          { label: "Expense", data: expenses, backgroundColor: "#ef4444", borderRadius: 4 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { ticks: { color: textColor }, grid: { color: gridColor } },
          x: { ticks: { color: textColor }, grid: { display: false } }
        },
        plugins: {
          legend: { labels: { color: textColor } }
        }
      }
    });
    
    new Chart($("chartAssetsLiabilities"), {
      type: "doughnut",
      data: {
        labels: ["Fixed Assets", "Investments", "Cash & Bank", "Sundry Debtors", "Other Current Assets"],
        datasets: [{
          data: [fixedAssets, investments, cashBankVal, debtorsVal, currentAssets + otherAssets].map(v => Math.max(0, Math.round(v))),
          backgroundColor: ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#6b7280"],
          borderWidth: isLight ? 1 : 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { color: textColor } }
        }
      }
    });
    
    new Chart($("chartTopExpenses"), {
      type: "pie",
      data: {
        labels: expLabels.length ? expLabels : ["No Expenses"],
        datasets: [{
          data: expData.length ? expData : [1],
          backgroundColor: ["#ef4444", "#f97316", "#f59e0b", "#ec4899", "#8b5cf6", "#6b7280"],
          borderWidth: isLight ? 1 : 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { color: textColor } }
        }
      }
    });
    
    new Chart($("chartProfitTrend"), {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "Net Profit / Loss",
          data: netProfits,
          borderColor: isLight ? "#d97706" : "#ffd24d",
          backgroundColor: isLight ? "rgba(217, 119, 6, 0.1)" : "rgba(255, 210, 77, 0.1)",
          fill: true,
          tension: 0.3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { ticks: { color: textColor }, grid: { color: gridColor } },
          x: { ticks: { color: textColor }, grid: { display: false } }
        },
        plugins: {
          legend: { labels: { color: textColor } }
        }
      }
    });
    
  } catch (err) {
    console.error("Dashboard error:", err);
  }
}

/* ------------------------------------------------------------- gateway --- */
const GW_ITEMS = [
  {section: "Dashboard"},
  {label: "Dashboard Summary", key: "G", run: () => push(dashboardScreen())},
  {section: "Data"},
  {label: "Load Tally Data (XML export)", key: "O", run: () => importModal()},
  {label: "Export New Vouchers → Tally", key: "E", run: () => exportNew()},
  {section: "Masters"},
  {label: "Create Ledger", key: "C", run: () => ledgerModal()},
  {label: "Chart of Accounts", key: "H", run: () => push(coaScreen())},
  {section: "Transactions"},
  {label: "Voucher Entry", key: "V", run: () => push(voucherScreen("Payment"))},
  {section: "Display — Reports"},
  {label: "Day Book", key: "D", run: () => push(daybookScreen())},
  {label: "Columnar Day Book", key: "J", run: () => push(columnarDaybookScreen())},
  {label: "Ledger Vouchers", key: "L", run: () => push(ledVchScreen(""))},
  {label: "Trial Balance", key: "T", run: () => push(simpleReport("Trial Balance", "/api/columnar-trial-balance", columnarTrialTable))},
  {label: "Balance Sheet", key: "B", run: () => push(simpleReport("Balance Sheet", "/api/balance-sheet", balanceSheetTable, true))},
  {label: "Profit & Loss A/c", key: "P", run: () => push(simpleReport("Profit & Loss A/c", "/api/pnl", pnlTable))},
  {label: "Sales Register", key: "R", run: () => push(salesRegisterScreen())},
  {label: "Purchase Register", key: "U", run: () => push(purchaseRegisterScreen())},
  {label: "Cash Flow Statement", key: "F", run: () => push(cashFlowScreen())},
  {label: "Outstanding Aging", key: "A", run: () => push(agingScreen())},
  {section: "Utilities"},
  {label: "Account & Data", key: "F12", run: () => settingsModal()},
];

function gatewayScreen() {
  let sel = GW_ITEMS.findIndex((i) => i.label);
  return {
    title: "Gateway of Tally",
    render(el) {
      const div = document.createElement("div");
      div.className = "gateway";
      div.innerHTML = GW_ITEMS.map((it, idx) => it.section
        ? `<div class="gw-section">${esc(it.section)}</div>`
        : `<div class="gw-item ${idx === sel ? "sel" : ""}" data-i="${idx}">
             <span>${esc(it.label)}</span><span class="k">${esc(it.key)}</span></div>`
      ).join("");
      el.appendChild(div);
      div.querySelectorAll(".gw-item").forEach((n) => {
        n.onclick = () => GW_ITEMS[+n.dataset.i].run();
        n.onmousemove = () => { sel = +n.dataset.i; paint(); };
      });
      function paint() {
        div.querySelectorAll(".gw-item").forEach((n) =>
          n.classList.toggle("sel", +n.dataset.i === sel));
      }
      this.paint = paint;
    },
    onKey(e) {
      const items = GW_ITEMS.map((it, i) => ({it, i})).filter(x => x.it.label);
      const pos = items.findIndex(x => x.i === sel);
      if (e.key === "ArrowDown") { sel = items[(pos + 1) % items.length].i; this.paint(); }
      else if (e.key === "ArrowUp") { sel = items[(pos - 1 + items.length) % items.length].i; this.paint(); }
      else if (e.key === "Enter") GW_ITEMS[sel].run();
      else {
        const hit = items.find(x => x.it.key.toLowerCase() === e.key.toLowerCase());
        if (hit) hit.it.run();
        else return false;
      }
      return true;
    },
  };
}

/* ------------------------------------------------------------- reports --- */
function downloadCSV(filename, table) {
  if (!table) return;
  let csv = [];
  const rows = table.querySelectorAll("tr");
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].style.display === "none") continue;
    let row = [];
    const cols = rows[i].querySelectorAll("td, th");
    for (let j = 0; j < cols.length; j++) {
      let text = cols[j].textContent.trim();
      text = text.replace(/"/g, '""');
      row.push(`"${text}"`);
    }
    csv.push(row.join(","));
  }
  const csvString = csv.join("\n");
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function reportBar(extraHTML = "", hideFrom = false) {
  return `<div class="rbar">
    <input type="date" class="rfrom" value="${S.period.from}" ${hideFrom ? 'style="display:none;"' : ""}>
    <input type="date" class="rto" value="${S.period.to}">
    ${extraHTML}
    <button class="btn reload">Load</button>
    <button class="btn outline csv-btn" style="margin-left: auto;">CSV</button>
    <button class="btn outline print-btn">Print</button>
  </div><div class="rout"><div class="empty">Loading…</div></div>`;
}

function wireReport(el, loader) {
  const load = async () => {
    S.period.from = el.querySelector(".rfrom").value;
    S.period.to = el.querySelector(".rto").value;
    periodLabel();
    const out = el.querySelector(".rout");
    out.innerHTML = `<div class="empty">Loading…</div>`;
    try { out.innerHTML = await loader(); wirePostRender(out); }
    catch (e) { out.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
  };
  el.querySelector(".reload").onclick = load;
  
  const printBtn = el.querySelector(".print-btn");
  if (printBtn) printBtn.onclick = () => window.print();
  
  const csvBtn = el.querySelector(".csv-btn");
  if (csvBtn) {
    csvBtn.onclick = () => {
      const topScreen = S.stack[S.stack.length - 1];
      const title = (topScreen.title || "Report").replaceAll(" ", "_");
      downloadCSV(title, el.querySelector("table"));
    };
  }
  
  load();
}

function wirePostRender(out) {
  out.querySelectorAll("[data-toggle]").forEach((n) => {
    n.onclick = () => {
      const t = document.getElementById(n.dataset.toggle);
      if (t) t.style.display = t.style.display === "none" ? "table-row" : "none";
    };
  });
  out.querySelectorAll("[data-del]").forEach((n) => {
    n.onclick = async (e) => {
      e.stopPropagation();
      const d = JSON.parse(n.dataset.del);
      const where = (d.remoteid || "").startsWith("local:") ? "from local data" : "inside Tally";
      if (!confirm(`Delete ${d.vchtype} voucher${d.number ? " #" + d.number : ""} ${where}?`)) return;
      const res = await api("/api/voucher/delete", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify(d),
      });
      alert(res.ok ? "Deleted." : "Failed: " + (res.lineerror || "unknown error"));
      const top = S.stack[S.stack.length - 1];
      if (res.ok && top.refresh) top.refresh();
    };
  });
  out.querySelectorAll("[data-openledger]").forEach((n) => {
    n.onclick = () => push(ledVchScreen(n.dataset.openledger));
  });
  out.querySelectorAll("[data-opengroup]").forEach((n) => {
    n.onclick = () => push(coaScreen(n.dataset.opengroup));
  });
}

function voucherTable(rows) {
  if (!rows.length) return `<div class="empty">No vouchers in this period.</div>`;
  return `<table><tr><th>Date</th><th>Particulars</th><th>Vch Type</th>
    <th>Vch No.</th><th style="text-align:right">Amount</th><th></th></tr>` +
    rows.map((v, i) => `
      <tr class="row" data-toggle="ent-${i}">
        <td class="num">${esc(v.date)}</td>
        <td>${esc(v.party || v.narration || "")}</td>
        <td><span class="pill">${esc(v.type)}</span>${v.isnew ? ` <span class="pill" style="background:#ffe08a;border-color:#e8c25a">NEW</span>` : ""}</td>
        <td class="num">${esc(v.number)}</td>
        <td class="num">${money(v.amount)}</td>
        <td>${v.isnew ? `<button class="btn danger" style="padding:2px 8px;font-size:11px"
              data-del='${esc(JSON.stringify({remoteid: v.remoteid, vchkey: v.vchkey, vchtype: v.vchtype, number: v.number}))}'>Del</button>` : ""}</td>
      </tr>
      <tr id="ent-${i}" style="display:none"><td colspan="6" class="entries">
        ${v.entries.map((en) => `<div><span>${esc(en.ledger)}</span>
          <span class="${en.side === "Dr" ? "dr" : "cr"}">${money(en.amount)} ${en.side}</span></div>`).join("")}
        ${v.narration ? `<div style="margin-top:6px;justify-content:flex-start">⤷ ${esc(v.narration)}</div>` : ""}
      </td></tr>`).join("") + `</table>`;
}

/* -------------------------------------------------------- cash flow screen --- */
async function getCashFlowData(dfrom, dto) {
  const closings = await dal.closings(ymd(dto));
  let openCash = 0;
  let closeCash = 0;
  
  const gmap = {};
  S.groups.forEach((g) => { gmap[g.name.toLowerCase()] = g.parent || ""; });
  
  const isCashLedger = (name) => {
    const l = closings[name];
    if (!l) return false;
    const top = l.parent ? topGroup(l.parent, gmap).toLowerCase() : "";
    return top === "bank accounts" || top === "cash-in-hand";
  };

  const prevDate = new Date(new Date(dfrom) - 86400000).toISOString().slice(0,10);
  const openClosings = await dal.closings(ymd(prevDate));
  
  for (const [name, l] of Object.entries(openClosings)) {
    if (isCashLedger(name)) openCash += -l.closing;
  }
  for (const [name, l] of Object.entries(closings)) {
    if (isCashLedger(name)) closeCash += -l.closing;
  }
  
  const dbVouchers = await api(`/api/daybook?from=${ymd(dfrom)}&to=${ymd(dto)}`);
  
  let opIn = 0, opOut = 0;
  let invIn = 0, invOut = 0;
  let finIn = 0, finOut = 0;
  
  const details = {
    operating: {},
    investing: {},
    financing: {}
  };
  
  dbVouchers.forEach(v => {
    const cashEntries = v.entries.filter(e => isCashLedger(e.ledger));
    if (!cashEntries.length) return;
    
    const nonCashEntries = v.entries.filter(e => !isCashLedger(e.ledger));
    nonCashEntries.forEach(nce => {
      const lInfo = closings[nce.ledger] || { parent: "" };
      const top = lInfo.parent ? topGroup(lInfo.parent, gmap) : "";
      const topL = top.toLowerCase();
      const nat = natureOf(top);
      
      const amt = nce.side === "Cr" ? nce.amount : -nce.amount;
      const absAmt = Math.abs(amt);
      
      let cat = "operating";
      let desc = nce.ledger;
      
      if (topL === "fixed assets" || topL === "investments") {
        cat = "investing";
      } else if (topL === "capital account" || topL === "loans (liability)" || topL === "secured loans" || topL === "unsecured loans") {
        cat = "financing";
      } else {
        cat = "operating";
        if (topL === "sundry debtors") desc = "Receipts from Debtors";
        else if (topL === "sundry creditors") desc = "Payments to Creditors";
        else if (nat === "income") desc = `Income: ${top}`;
        else if (nat === "expense") desc = `Expenses: ${top}`;
      }
      
      if (!details[cat][desc]) details[cat][desc] = 0;
      details[cat][desc] += amt;
      
      if (cat === "operating") {
        if (amt > 0) opIn += absAmt; else opOut += absAmt;
      } else if (cat === "investing") {
        if (amt > 0) invIn += absAmt; else invOut += absAmt;
      } else if (cat === "financing") {
        if (amt > 0) finIn += absAmt; else finOut += absAmt;
      }
    });
  });
  
  return {
    openCash, closeCash,
    opIn, opOut,
    invIn, invOut,
    finIn, finOut,
    details
  };
}

function renderCashFlowTable(data) {
  const opNet = data.opIn - data.opOut;
  const invNet = data.invIn - data.invOut;
  const finNet = data.finIn - data.finOut;
  const netChange = opNet + invNet + finNet;
  
  const rowList = (catObj) => {
    return Object.entries(catObj).map(([desc, bal]) => {
      if (Math.abs(bal) < 0.01) return "";
      return `<tr>
        <td style="padding-left:30px; color:var(--muted);">${esc(desc)}</td>
        <td class="num ${bal >= 0 ? "cr" : "dr"}">${money(Math.abs(bal))} ${bal >= 0 ? "Inflow" : "Outflow"}</td>
      </tr>`;
    }).join("");
  };
  
  return `
    <table>
      <thead>
        <tr><th>Particulars</th><th style="text-align:right">Amount</th></tr>
      </thead>
      <tbody>
        <tr class="fw-bold" style="background:var(--paper-alt);">
          <td>A. Cash Flow from Operating Activities</td>
          <td class="num ${opNet >= 0 ? "cr" : "dr"}">${money(Math.abs(opNet))} ${opNet >= 0 ? "Inflow" : "Outflow"}</td>
        </tr>
        ${rowList(data.details.operating)}
        
        <tr class="fw-bold" style="background:var(--paper-alt);">
          <td>B. Cash Flow from Investing Activities</td>
          <td class="num ${invNet >= 0 ? "cr" : "dr"}">${money(Math.abs(invNet))} ${invNet >= 0 ? "Inflow" : "Outflow"}</td>
        </tr>
        ${rowList(data.details.investing)}
        
        <tr class="fw-bold" style="background:var(--paper-alt);">
          <td>C. Cash Flow from Financing Activities</td>
          <td class="num ${finNet >= 0 ? "cr" : "dr"}">${money(Math.abs(finNet))} ${finNet >= 0 ? "Inflow" : "Outflow"}</td>
        </tr>
        ${rowList(data.details.financing)}
        
        <tr class="total">
          <td>Net Increase / (Decrease) in Cash & Bank (A + B + C)</td>
          <td class="num ${netChange >= 0 ? "cr" : "dr"}">${money(Math.abs(netChange))} ${netChange >= 0 ? "Dr" : "Cr"}</td>
        </tr>
        <tr class="fw-bold">
          <td>Opening Cash & Bank Balance</td>
          <td class="num">${money(data.openCash)} Dr</td>
        </tr>
        <tr class="fw-bold" style="border-top: 2px solid var(--muted); border-bottom: 2px double var(--muted);">
          <td>Closing Cash & Bank Balance</td>
          <td class="num">${money(data.closeCash)} Dr</td>
        </tr>
      </tbody>
    </table>
  `;
}

function cashFlowScreen() {
  const scr = {
    title: "Cash Flow Statement",
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = reportBar();
      el.appendChild(d);
      scr.refresh = () => wireReport(d, async () => {
        const data = await getCashFlowData(S.period.from, S.period.to);
        return renderCashFlowTable(data);
      });
      scr.refresh();
    }
  };
  return scr;
}

/* ------------------------------------------------------------ aging screen --- */
function agingScreen() {
  const scr = {
    title: "Outstanding Receivables & Payables",
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = `
        <div class="rbar">
          <select class="type-filter">
            <option value="all">Show All</option>
            <option value="debtors">Debtors Only (Receivables)</option>
            <option value="creditors">Creditors Only (Payables)</option>
          </select>
          <div class="search-box-wrap">
            <input class="aging-search" placeholder="Search party name…">
          </div>
          <button class="btn outline csv-btn" style="margin-left: auto;">CSV</button>
          <button class="btn outline print-btn">Print</button>
        </div>
        <div class="rout"><div class="empty">Loading…</div></div>
      `;
      el.appendChild(d);
      
      d.querySelector(".print-btn").onclick = () => window.print();
      d.querySelector(".csv-btn").onclick = () => {
        downloadCSV("Outstanding_Aging", d.querySelector("table"));
      };
      
      const filterSelect = d.querySelector(".type-filter");
      const searchInput = d.querySelector(".aging-search");
      
      const load = async () => {
        const out = d.querySelector(".rout");
        out.innerHTML = `<div class="empty">Loading…</div>`;
        try {
          const closings = await dal.closings(ymd(S.period.to));
          
          const gmap = {};
          S.groups.forEach((g) => { gmap[g.name.toLowerCase()] = g.parent || ""; });
          
          const list = [];
          for (const [name, l] of Object.entries(closings)) {
            const top = l.parent ? topGroup(l.parent, gmap).toLowerCase() : "";
            if (top === "sundry debtors" || top === "sundry creditors") {
              const bal = l.closing;
              if (Math.abs(bal) < 0.01) continue;
              list.push({
                name,
                group: top === "sundry debtors" ? "Sundry Debtors" : "Sundry Creditors",
                amount: Math.abs(bal),
                side: bal < 0 ? "Dr" : "Cr"
              });
            }
          }
          
          list.sort((a, b) => b.amount - a.amount);
          
          const paint = () => {
            const filter = filterSelect.value;
            const search = searchInput.value.toLowerCase();
            
            const filtered = list.filter(item => {
              if (filter === "debtors" && item.group !== "Sundry Debtors") return false;
              if (filter === "creditors" && item.group !== "Sundry Creditors") return false;
              if (search && !item.name.toLowerCase().includes(search)) return false;
              return true;
            });
            
            out.innerHTML = filtered.length ? `
              <table>
                <thead>
                  <tr>
                    <th>Party Name</th>
                    <th>Group</th>
                    <th style="text-align:right">Outstanding Amount</th>
                    <th style="text-align:center">Warning Limit</th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered.map(item => {
                    const isWarning = item.amount > 50000;
                    return `
                      <tr class="row" data-openledger="${esc(item.name)}">
                        <td>${esc(item.name)}</td>
                        <td><span class="pill">${esc(item.group)}</span></td>
                        <td class="num ${item.side === "Dr" ? "dr" : "cr"}">${money(item.amount)} ${item.side}</td>
                        <td class="text-center">${isWarning ? `<span style="background:rgba(239, 68, 68, 0.15); color:var(--dr); padding:2px 8px; border-radius:12px; font-size:11px; font-weight:bold;">⚠️ High (>50k)</span>` : `<span style="color:var(--cr);">✓ Normal</span>`}</td>
                      </tr>
                    `;
                  }).join("")}
                </tbody>
              </table>
            ` : `<div class="empty">No outstanding balances match filters.</div>`;
            
            wirePostRender(out);
          };
          
          filterSelect.onchange = paint;
          searchInput.oninput = paint;
          paint();
          
        } catch (e) {
          out.innerHTML = `<div class="errbox">${esc(e.message)}</div>`;
        }
      };
      
      load();
    }
  };
  return scr;
}

function daybookScreen() {
  const scr = {
    title: "Day Book",
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = reportBar(
        `<div class="search-box-wrap"><input class="rsearch" placeholder="Search vouchers…"></div>`
      );
      el.appendChild(d);
      
      const searchInput = d.querySelector(".rsearch");
      
      scr.refresh = () => wireReport(d, async () => {
        const vouchers = await api(`/api/daybook?from=${ymd(S.period.from)}&to=${ymd(S.period.to)}`);
        
        const paint = () => {
          const query = searchInput.value.toLowerCase().trim();
          const filtered = vouchers.filter(v => {
            if (!query) return true;
            return (v.party || "").toLowerCase().includes(query) ||
                   (v.narration || "").toLowerCase().includes(query) ||
                   (v.type || "").toLowerCase().includes(query) ||
                   (v.number || "").toLowerCase().includes(query) ||
                   v.entries.some(e => e.ledger.toLowerCase().includes(query));
          });
          
          const out = d.querySelector(".rout");
          out.innerHTML = voucherTable(filtered);
          wirePostRender(out);
        };
        
        searchInput.oninput = paint;
        setTimeout(paint, 0);
        
        return voucherTable(vouchers);
      });
      scr.refresh();
    },
  };
  return scr;
}

function columnarLedgerTable(rows, ledgerName, openingVal) {
  let running = openingVal;
  const headerHtml = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Particulars</th>
          <th>Vch Type</th>
          <th>Vch No.</th>
          <th style="text-align:right">Debit</th>
          <th style="text-align:right">Credit</th>
          <th style="text-align:right">Running Balance</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr style="font-weight:600; background:var(--paper-alt);">
          <td colspan="4">Opening Balance</td>
          <td></td>
          <td></td>
          <td class="num ${running < 0 ? "dr" : "cr"}">${money(Math.abs(running))} ${running < 0 ? "Dr" : running > 0 ? "Cr" : ""}</td>
          <td></td>
        </tr>
  `;
  
  let bodyHtml = "";
  rows.forEach((v, i) => {
    const matchingEntries = v.entries.filter(e => e.ledger === ledgerName);
    if (!matchingEntries.length) return;
    
    let netAmt = 0;
    matchingEntries.forEach(e => {
      if (e.side === "Dr") netAmt -= e.amount;
      else netAmt += e.amount;
    });
    
    const isDr = netAmt < 0;
    const absAmt = Math.abs(netAmt);
    
    running += netAmt;
    
    const otherLedgers = v.entries.filter(e => e.ledger !== ledgerName).map(e => e.ledger);
    const prefix = isDr ? "To " : "By ";
    const particularsText = otherLedgers.length ? prefix + otherLedgers.join(", ") : prefix + "Self";
    
    bodyHtml += `
      <tr class="row" data-toggle="ent-${i}">
        <td class="num">${esc(v.date)}</td>
        <td>
          <div style="font-weight:600;">${esc(particularsText)}</div>
          ${v.narration ? `<div style="font-size:11.5px; color:var(--muted); margin-top:2px;">⤷ ${esc(v.narration)}</div>` : ""}
        </td>
        <td><span class="pill">${esc(v.type)}</span>${v.isnew ? ` <span class="pill" style="background:#ffe08a;border-color:#e8c25a">NEW</span>` : ""}</td>
        <td class="num">${esc(v.number)}</td>
        <td class="num dr">${isDr ? money(absAmt) : ""}</td>
        <td class="num cr">${!isDr ? money(absAmt) : ""}</td>
        <td class="num ${running < 0 ? "dr" : "cr"}">${money(Math.abs(running))} ${running < 0 ? "Dr" : running > 0 ? "Cr" : ""}</td>
        <td>
          ${v.isnew ? `<button class="btn danger" style="padding:2px 8px;font-size:11px"
                data-del='${esc(JSON.stringify({remoteid: v.remoteid, vchkey: v.vchkey, vchtype: v.vchtype, number: v.number}))}'>Del</button>` : ""}
        </td>
      </tr>
      <tr id="ent-${i}" style="display:none"><td colspan="8" class="entries">
        ${v.entries.map((en) => `<div><span>${esc(en.ledger)}</span>
          <span class="${en.side === "Dr" ? "dr" : "cr"}">${money(en.amount)} ${en.side}</span></div>`).join("")}
      </td></tr>
    `;
  });
  
  const footerHtml = `
      <tr class="total">
        <td colspan="4">Closing Balance</td>
        <td></td>
        <td></td>
        <td class="num ${running < 0 ? "dr" : "cr"}">${money(Math.abs(running))} ${running < 0 ? "Dr" : running > 0 ? "Cr" : ""}</td>
        <td></td>
      </tr>
    </tbody>
    </table>
  `;
  
  return headerHtml + bodyHtml + footerHtml;
}

function ledVchScreen(ledger) {
  const scr = {
    title: "Ledger Vouchers",
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = reportBar(
        `<input class="rled" list="ledDL" placeholder="Ledger…" style="width:220px" value="${esc(ledger)}">
         <div class="search-box-wrap" style="margin-left: 10px;"><input class="rsearch" placeholder="Search vouchers…"></div>`
      );
      el.appendChild(d);
      
      const searchInput = d.querySelector(".rsearch");
      
      scr.refresh = () => wireReport(d, async () => {
        const led = d.querySelector(".rled").value.trim();
        if (!led) return `<div class="empty">Type a ledger name and press Load.</div>`;
        
        const prevDate = new Date(new Date(S.period.from) - 86400000).toISOString().slice(0, 10);
        const openClosings = await dal.closings(ymd(prevDate));
        const plLedger = openClosings[led];
        const openingVal = plLedger ? plLedger.closing : 0;
        
        const vouchers = await api(`/api/ledger-vouchers?ledger=${encodeURIComponent(led)}&from=${ymd(S.period.from)}&to=${ymd(S.period.to)}`);
        
        const paint = () => {
          const query = searchInput.value.toLowerCase().trim();
          const filtered = vouchers.filter(v => {
            if (!query) return true;
            return (v.party || "").toLowerCase().includes(query) ||
                   (v.narration || "").toLowerCase().includes(query) ||
                   (v.type || "").toLowerCase().includes(query) ||
                   (v.number || "").toLowerCase().includes(query) ||
                   v.entries.some(e => e.ledger.toLowerCase().includes(query));
          });
          
          const out = d.querySelector(".rout");
          out.innerHTML = columnarLedgerTable(filtered, led, openingVal);
          wirePostRender(out);
        };
        
        searchInput.oninput = paint;
        setTimeout(paint, 0);
        
        return columnarLedgerTable(vouchers, led, openingVal);
      });
      scr.refresh();
    },
  };
  return scr;
}

function trialTable(rows) {
  if (!rows.length) return `<div class="empty">Nothing returned.</div>`;
  let dr = 0, cr = 0;
  rows.forEach((r) => { dr += r.debit; cr += r.credit; });
  return `<table><tr><th>Particulars</th><th style="text-align:right">Debit</th>
    <th style="text-align:right">Credit</th></tr>` +
    rows.map((r) => `<tr><td>${esc(r.name)}</td>
      <td class="num dr">${r.debit ? money(r.debit) : ""}</td>
      <td class="num cr">${r.credit ? money(r.credit) : ""}</td></tr>`).join("") +
    `<tr class="total"><td>Total</td><td class="num dr">${money(dr)}</td>
     <td class="num cr">${money(cr)}</td></tr></table>`;
}

function columnarTrialTable(data) {
  if (!data || !data.ledgers) return `<div class="empty">Nothing returned.</div>`;
  const { groups, ledgers } = data;
  
  const nodes = {};
  groups.forEach(g => {
    nodes[g.name.toLowerCase()] = {
      name: g.name,
      parent: g.parent || "",
      isLedger: false,
      children: [],
      openDr: 0, openCr: 0,
      debit: 0, credit: 0,
      closeDr: 0, closeCr: 0
    };
  });
  
  const roots = [];
  const addNode = (node) => {
    const parentName = node.parent;
    if (parentName && parentName.toLowerCase() !== "primary") {
      const parentNode = nodes[parentName.toLowerCase()];
      if (parentNode) {
        parentNode.children.push(node);
        return;
      }
    }
    roots.push(node);
  };
  
  let suspenseNode = nodes["suspense a/c"];
  if (!suspenseNode) {
    suspenseNode = {
      name: "Suspense A/c",
      parent: "",
      isLedger: false,
      children: [],
      openDr: 0, openCr: 0,
      debit: 0, credit: 0,
      closeDr: 0, closeCr: 0
    };
    nodes["suspense a/c"] = suspenseNode;
    roots.push(suspenseNode);
  }
  
  ledgers.forEach(l => {
    const isPL = isPLLedger(l.name);
    let parent = l.parent;
    if (!parent && !isPL) {
      parent = "Suspense A/c";
    }
    const node = {
      name: l.name,
      parent,
      isLedger: true,
      children: [],
      openDr: l.openDr, openCr: l.openCr,
      debit: l.debit, credit: l.credit,
      closeDr: l.closeDr, closeCr: l.closeCr
    };
    if (isPL) {
      roots.push(node);
    } else {
      addNode(node);
    }
  });
  
  groups.forEach(g => {
    const node = nodes[g.name.toLowerCase()];
    addNode(node);
  });
  
  const sumBalances = (node) => {
    if (node.isLedger) return {
      openDr: node.openDr, openCr: node.openCr,
      debit: node.debit, credit: node.credit,
      closeDr: node.closeDr, closeCr: node.closeCr
    };
    
    let openDr = 0, openCr = 0, debit = 0, credit = 0, closeDr = 0, closeCr = 0;
    node.children.forEach(child => {
      const childBal = sumBalances(child);
      openDr += childBal.openDr;
      openCr += childBal.openCr;
      debit += childBal.debit;
      credit += childBal.credit;
      closeDr += childBal.closeDr;
      closeCr += childBal.closeCr;
    });
    
    const netOpen = openCr - openDr;
    node.openDr = netOpen < 0 ? Math.abs(netOpen) : 0;
    node.openCr = netOpen > 0 ? netOpen : 0;
    
    node.debit = debit;
    node.credit = credit;
    
    const netClose = closeCr - closeDr;
    node.closeDr = netClose < 0 ? Math.abs(netClose) : 0;
    node.closeCr = netClose > 0 ? netClose : 0;
    
    return {
      openDr: node.openDr, openCr: node.openCr,
      debit: node.debit, credit: node.credit,
      closeDr: node.closeDr, closeCr: node.closeCr
    };
  };
  
  roots.forEach(sumBalances);
  
  const rowsList = [];
  const flatten = (node, depth = 0) => {
    const hasBalance = node.openDr || node.openCr || node.debit || node.credit || node.closeDr || node.closeCr;
    if (!hasBalance) return;
    
    rowsList.push({
      name: node.name,
      isLedger: node.isLedger,
      parent: node.parent,
      depth,
      openDr: node.openDr, openCr: node.openCr,
      debit: node.debit, credit: node.credit,
      closeDr: node.closeDr, closeCr: node.closeCr
    });
    
    node.children.sort((a, b) => {
      if (a.isLedger !== b.isLedger) return a.isLedger ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(child => flatten(child, depth + 1));
  };
  
  roots.sort((a,b) => a.name.localeCompare(b.name)).forEach(root => flatten(root, 0));
  
  let totOpenDr = 0, totOpenCr = 0, totDr = 0, totCr = 0, totCloseDr = 0, totCloseCr = 0;
  ledgers.forEach(l => {
    totOpenDr += l.openDr;
    totOpenCr += l.openCr;
    totDr += l.debit;
    totCr += l.credit;
    totCloseDr += l.closeDr;
    totCloseCr += l.closeCr;
  });
  
  const openDiff = totOpenCr - totOpenDr;
  const closeDiff = totCloseCr - totCloseDr;
  
  if (Math.abs(openDiff) > 0.05) {
    if (openDiff < 0) {
      totOpenCr += Math.abs(openDiff);
    } else {
      totOpenDr += Math.abs(openDiff);
    }
  }
  if (Math.abs(closeDiff) > 0.05) {
    if (closeDiff < 0) {
      totCloseCr += Math.abs(closeDiff);
    } else {
      totCloseDr += Math.abs(closeDiff);
    }
  }
  
  let idCounter = 0;
  const trsHtml = rowsList.map(r => {
    const isGroup = !r.isLedger;
    const parentClass = r.parent ? `child-of-${esc(r.parent.toLowerCase().replaceAll(" ", "-"))}` : "";
    const nodeClass = isGroup ? `group-${esc(r.name.toLowerCase().replaceAll(" ", "-"))}` : "";
    const rowId = `tb-row-${idCounter++}`;
    
    let clickAttr = "";
    if (r.isLedger) {
      clickAttr = `data-openledger="${esc(r.name)}"`;
    } else {
      clickAttr = `data-opengroup="${esc(r.name)}"`;
    }
    
    const toggleIcon = isGroup ? `<span class="toggle-node" style="cursor: pointer; margin-right: 6px; user-select: none;">▼</span>` : `<span style="display:inline-block; width:14px; margin-right: 6px;"></span>`;
    
    return `
      <tr class="row ${parentClass} ${nodeClass}" id="${rowId}" ${clickAttr} data-depth="${r.depth}" data-name="${esc(r.name.toLowerCase())}" data-collapsed="false" style="transition: all var(--transition-fast);">
        <td style="padding-left: ${r.depth * 16 + 8}px;">
          ${toggleIcon}${esc(r.name)}
        </td>
        <td class="num dr">${r.openDr ? money(r.openDr) : ""}</td>
        <td class="num cr">${r.openCr ? money(r.openCr) : ""}</td>
        <td class="num dr">${r.debit ? money(r.debit) : ""}</td>
        <td class="num cr">${r.credit ? money(r.credit) : ""}</td>
        <td class="num dr">${r.closeDr ? money(r.closeDr) : ""}</td>
        <td class="num cr">${r.closeCr ? money(r.closeCr) : ""}</td>
      </tr>
    `;
  }).join("");
  
  if (!window.trialBalanceWired) {
    window.trialBalanceWired = true;
    document.addEventListener("click", (e) => {
      const toggle = e.target.closest(".toggle-node");
      if (toggle) {
        const row = toggle.closest("tr");
        if (row) {
          e.stopPropagation();
          const name = row.dataset.name;
          const isCollapsed = row.dataset.collapsed === "true";
          row.dataset.collapsed = isCollapsed ? "false" : "true";
          toggle.textContent = isCollapsed ? "▼" : "▶";
          
          const tbody = row.closest("tbody");
          const allRows = Array.from(tbody.querySelectorAll("tr.row"));
          
          const setChildVisibility = (parentName, visible) => {
            allRows.forEach(r => {
              if (r.classList.contains(`child-of-${parentName.replaceAll(" ", "-")}`)) {
                r.style.display = visible ? "" : "none";
                if (!visible) {
                  r.dataset.collapsed = "true";
                  const childToggle = r.querySelector(".toggle-node");
                  if (childToggle) childToggle.textContent = "▶";
                  setChildVisibility(r.dataset.name, false);
                }
              }
            });
          };
          setChildVisibility(name, isCollapsed);
        }
      }
    });
  }

  const controlsHtml = `
    <div class="rbar" style="margin-bottom: 12px; gap: 8px;">
      <button class="btn outline" onclick="(() => {
        document.querySelectorAll('tr.row').forEach(r => { r.style.display = ''; r.dataset.collapsed = 'false'; const t = r.querySelector('.toggle-node'); if (t) t.textContent = '▼'; });
      })()">Expand All</button>
      <button class="btn outline" onclick="(() => {
        document.querySelectorAll('tr.row').forEach(r => {
          const depth = parseInt(r.dataset.depth || '0');
          if (depth > 0) { r.style.display = 'none'; }
          r.dataset.collapsed = 'true';
          const t = r.querySelector('.toggle-node');
          if (t) t.textContent = '▶';
        });
      })()">Collapse All</button>
    </div>
  `;
  
  let diffOpenRowHtml = "";
  let diffCloseRowHtml = "";
  
  if (Math.abs(openDiff) > 0.05) {
    diffOpenRowHtml = `
      <tr style="color: var(--accent); font-style: italic;">
        <td style="padding-left: 8px;">Difference in Opening Balances</td>
        <td class="num dr">${openDiff < 0 ? money(Math.abs(openDiff)) : ""}</td>
        <td class="num cr">${openDiff > 0 ? money(openDiff) : ""}</td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
      </tr>
    `;
  }
  if (Math.abs(closeDiff) > 0.05) {
    diffCloseRowHtml = `
      <tr style="color: var(--accent); font-style: italic;">
        <td style="padding-left: 8px;">Difference in Closing Balances</td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
        <td class="num dr">${closeDiff < 0 ? money(Math.abs(closeDiff)) : ""}</td>
        <td class="num cr">${closeDiff > 0 ? money(closeDiff) : ""}</td>
      </tr>
    `;
  }
  
  return controlsHtml + `
    <table>
      <thead>
        <tr>
          <th rowspan="2">Particulars</th>
          <th colspan="2" style="text-align:center; border-bottom: 1px solid var(--line);">Opening Balance</th>
          <th colspan="2" style="text-align:center; border-bottom: 1px solid var(--line);">Transactions</th>
          <th colspan="2" style="text-align:center; border-bottom: 1px solid var(--line);">Closing Balance</th>
        </tr>
        <tr>
          <th style="text-align:right">Debit</th>
          <th style="text-align:right">Credit</th>
          <th style="text-align:right">Debit</th>
          <th style="text-align:right">Credit</th>
          <th style="text-align:right">Debit</th>
          <th style="text-align:right">Credit</th>
        </tr>
      </thead>
      <tbody>
        ${trsHtml}
        ${diffOpenRowHtml}
        ${diffCloseRowHtml}
        <tr class="total">
          <td>Total</td>
          <td class="num dr">${totOpenDr ? money(totOpenDr) : ""}</td>
          <td class="num cr">${totOpenCr ? money(totOpenCr) : ""}</td>
          <td class="num dr">${totDr ? money(totDr) : ""}</td>
          <td class="num cr">${totCr ? money(totCr) : ""}</td>
          <td class="num dr">${totCloseDr ? money(totCloseDr) : ""}</td>
          <td class="num cr">${totCloseCr ? money(totCloseCr) : ""}</td>
        </tr>
      </tbody>
    </table>
  `;
}

function renderRegisterTable(vouchers, type) {
  if (!vouchers.length) return `<div class="empty">No entries in this period.</div>`;
  const isGstLedger = (name) => /(gst|tax|cgst|sgst|igst|vat)/i.test(name);
  
  let totalTaxable = 0;
  let totalGst = 0;
  let totalGross = 0;
  
  const parsed = vouchers.map((v) => {
    let partyAmt = 0;
    let gstAmt = 0;
    let taxableAmt = 0;
    
    v.entries.forEach(e => {
      if (v.party && e.ledger === v.party) {
        partyAmt += e.amount;
      }
    });
    
    v.entries.forEach(e => {
      if (v.party && e.ledger === v.party) {
        return;
      }
      
      const targetSide = type === "Sales" ? "Cr" : "Dr";
      const isTarget = e.side === targetSide;
      const amt = isTarget ? e.amount : -e.amount;
      
      if (isGstLedger(e.ledger)) {
        gstAmt += amt;
      } else {
        taxableAmt += amt;
      }
    });
    
    if (partyAmt === 0) {
      gstAmt = 0;
      taxableAmt = 0;
      v.entries.forEach(e => {
        const partySide = type === "Sales" ? "Dr" : "Cr";
        if (e.side === partySide) {
          partyAmt += e.amount;
        } else {
          if (isGstLedger(e.ledger)) {
            gstAmt += e.amount;
          } else {
            taxableAmt += e.amount;
          }
        }
      });
    }
    
    const gross = partyAmt || v.amount;
    totalTaxable += taxableAmt;
    totalGst += gstAmt;
    totalGross += gross;
    
    return {
      date: v.date,
      number: v.number,
      party: v.party || v.narration || "",
      taxable: taxableAmt,
      gst: gstAmt,
      gross,
      v
    };
  });
  
  return `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>${type === "Sales" ? "Invoice No." : "Bill No."}</th>
          <th>${type === "Sales" ? "Customer Name" : "Supplier Name"}</th>
          <th style="text-align:right">Taxable Value</th>
          <th style="text-align:right">GST Amount</th>
          <th style="text-align:right">Gross Value</th>
        </tr>
      </thead>
      <tbody>
        ${parsed.map((p, i) => `
          <tr class="row" data-openledger="${esc(p.party)}">
            <td class="num">${esc(p.date)}</td>
            <td class="num">${esc(p.number)}</td>
            <td>${esc(p.party)}</td>
            <td class="num">${p.taxable ? money(p.taxable) : "0.00"}</td>
            <td class="num">${p.gst ? money(p.gst) : "0.00"}</td>
            <td class="num" style="font-weight:600;">${money(p.gross)}</td>
          </tr>
        `).join("")}
        <tr class="total">
          <td colspan="3">Total</td>
          <td class="num">${money(totalTaxable)}</td>
          <td class="num">${money(totalGst)}</td>
          <td class="num">${money(totalGross)}</td>
        </tr>
      </tbody>
    </table>
  `;
}

function salesRegisterScreen() {
  const scr = {
    title: "Sales Register",
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = reportBar(
        `<div class="search-box-wrap"><input class="rsearch" placeholder="Search sales…"></div>`
      );
      el.appendChild(d);
      const searchInput = d.querySelector(".rsearch");
      
      scr.refresh = () => wireReport(d, async () => {
        const vouchers = await api(`/api/sales-register?from=${ymd(S.period.from)}&to=${ymd(S.period.to)}`);
        
        const paint = () => {
          const query = searchInput.value.toLowerCase().trim();
          const filtered = vouchers.filter(v => {
            if (!query) return true;
            return (v.party || "").toLowerCase().includes(query) ||
                   (v.narration || "").toLowerCase().includes(query) ||
                   (v.number || "").toLowerCase().includes(query) ||
                   v.entries.some(e => e.ledger.toLowerCase().includes(query));
          });
          
          const out = d.querySelector(".rout");
          out.innerHTML = renderRegisterTable(filtered, "Sales");
          wirePostRender(out);
        };
        
        searchInput.oninput = paint;
        setTimeout(paint, 0);
        
        return renderRegisterTable(vouchers, "Sales");
      });
      scr.refresh();
    }
  };
  return scr;
}

function purchaseRegisterScreen() {
  const scr = {
    title: "Purchase Register",
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = reportBar(
        `<div class="search-box-wrap"><input class="rsearch" placeholder="Search purchases…"></div>`
      );
      el.appendChild(d);
      const searchInput = d.querySelector(".rsearch");
      
      scr.refresh = () => wireReport(d, async () => {
        const vouchers = await api(`/api/purchase-register?from=${ymd(S.period.from)}&to=${ymd(S.period.to)}`);
        
        const paint = () => {
          const query = searchInput.value.toLowerCase().trim();
          const filtered = vouchers.filter(v => {
            if (!query) return true;
            return (v.party || "").toLowerCase().includes(query) ||
                   (v.narration || "").toLowerCase().includes(query) ||
                   (v.number || "").toLowerCase().includes(query) ||
                   v.entries.some(e => e.ledger.toLowerCase().includes(query));
          });
          
          const out = d.querySelector(".rout");
          out.innerHTML = renderRegisterTable(filtered, "Purchase");
          wirePostRender(out);
        };
        
        searchInput.oninput = paint;
        setTimeout(paint, 0);
        
        return renderRegisterTable(vouchers, "Purchase");
      });
      scr.refresh();
    }
  };
  return scr;
}

function columnarDaybookScreen() {
  const scr = {
    title: "Columnar Day Book",
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = reportBar(
        `<div class="search-box-wrap"><input class="rsearch" placeholder="Search vouchers…"></div>`
      );
      el.appendChild(d);
      const searchInput = d.querySelector(".rsearch");
      
      scr.refresh = () => wireReport(d, async () => {
        const vouchers = await api(`/api/daybook?from=${ymd(S.period.from)}&to=${ymd(S.period.to)}`);
        
        const paint = () => {
          const query = searchInput.value.toLowerCase().trim();
          const filtered = vouchers.filter(v => {
            if (!query) return true;
            return (v.party || "").toLowerCase().includes(query) ||
                   (v.narration || "").toLowerCase().includes(query) ||
                   (v.type || "").toLowerCase().includes(query) ||
                   (v.number || "").toLowerCase().includes(query) ||
                   v.entries.some(e => e.ledger.toLowerCase().includes(query));
          });
          
          const out = d.querySelector(".rout");
          out.innerHTML = renderColumnarDaybookTable(filtered);
          wirePostRender(out);
        };
        
        searchInput.oninput = paint;
        setTimeout(paint, 0);
        
        return renderColumnarDaybookTable(vouchers);
      });
      scr.refresh();
    }
  };
  return scr;
}

function renderColumnarDaybookTable(vouchers) {
  if (!vouchers.length) return `<div class="empty">No vouchers in this period.</div>`;
  
  const counts = {};
  vouchers.forEach(v => {
    v.entries.forEach(e => {
      if (e.ledger) {
        counts[e.ledger] = (counts[e.ledger] || 0) + 1;
      }
    });
  });
  
  const topLedgers = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(entry => entry[0]);
  
  const colTotals = {};
  topLedgers.forEach(l => { colTotals[l] = { dr: 0, cr: 0 }; });
  colTotals["others"] = { dr: 0, cr: 0 };
  let grandGross = 0;
  
  const rowsHtml = vouchers.map((v, idx) => {
    grandGross += v.amount;
    
    const colVals = {};
    topLedgers.forEach(l => { colVals[l] = 0; });
    let othersVal = 0;
    
    v.entries.forEach(e => {
      const amt = e.side === "Dr" ? -e.amount : e.amount;
      if (topLedgers.includes(e.ledger)) {
        colVals[e.ledger] += amt;
      } else {
        othersVal += amt;
      }
    });
    
    topLedgers.forEach(l => {
      const val = colVals[l];
      if (val < 0) colTotals[l].dr += Math.abs(val);
      else colTotals[l].cr += val;
    });
    if (othersVal < 0) colTotals["others"].dr += Math.abs(othersVal);
    else colTotals["others"].cr += othersVal;
    
    const formatCell = (val) => {
      if (Math.abs(val) < 0.005) return "";
      const side = val < 0 ? "Dr" : "Cr";
      return `<span class="${side === "Dr" ? "dr" : "cr"}">${money(Math.abs(val))} ${side}</span>`;
    };
    
    return `
      <tr class="row" data-toggle="colent-${idx}">
        <td class="num">${esc(v.date)}</td>
        <td><span class="pill">${esc(v.type)}</span></td>
        <td class="num">${esc(v.number)}</td>
        <td>${esc(v.party || v.narration || "")}</td>
        <td class="num" style="font-weight:600;">${money(v.amount)}</td>
        ${topLedgers.map(l => `<td class="num">${formatCell(colVals[l])}</td>`).join("")}
        <td class="num">${formatCell(othersVal)}</td>
      </tr>
      <tr id="colent-${idx}" style="display:none"><td colspan="${6 + topLedgers.length}" class="entries">
        ${v.entries.map((en) => `<div><span>${esc(en.ledger)}</span>
          <span class="${en.side === "Dr" ? "dr" : "cr"}">${money(en.amount)} ${en.side}</span></div>`).join("")}
        ${v.narration ? `<div style="margin-top:6px;justify-content:flex-start">⤷ ${esc(v.narration)}</div>` : ""}
      </td></tr>
    `;
  }).join("");
  
  const formatTotalCell = (tot) => {
    const net = tot.cr - tot.dr;
    if (Math.abs(net) < 0.005) return "";
    const side = net < 0 ? "Dr" : "Cr";
    return `<span class="${side === "Dr" ? "dr" : "cr"}">${money(Math.abs(net))} ${side}</span>`;
  };
  
  return `
    <table style="font-size:11px;">
      <thead>
        <tr>
          <th>Date</th>
          <th>Type</th>
          <th>No.</th>
          <th>Particulars</th>
          <th style="text-align:right">Gross</th>
          ${topLedgers.map(l => `<th style="text-align:right; max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(l)}">${esc(l)}</th>`).join("")}
          <th style="text-align:right">Others</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
        <tr class="total">
          <td colspan="4">Total</td>
          <td class="num">${money(grandGross)}</td>
          ${topLedgers.map(l => `<td class="num">${formatTotalCell(colTotals[l])}</td>`).join("")}
          <td class="num">${formatTotalCell(colTotals["others"])}</td>
        </tr>
      </tbody>
    </table>
  `;
}

function balanceSheetTable(data) {
  if (!data) return `<div class="empty">Nothing returned.</div>`;
  const renderRows = (list) => {
    return list.map(r => {
      const isPnlLedger = isPLLedger(r.name);
      const isDiff = r.name.toLowerCase() === "difference in opening balances";
      let clickAttr = "";
      if (isPnlLedger) {
        clickAttr = `data-openledger="${esc(r.name)}"`;
      } else if (!isDiff) {
        clickAttr = `data-opengroup="${esc(r.name)}"`;
      }
      const amtStr = r.amount ? money(r.amount) + " " + r.side : "";
      return `<tr class="row" ${clickAttr}>
        <td>${esc(r.name)}</td>
        <td class="num ${r.side === "Dr" ? "dr" : "cr"}">${amtStr}</td>
      </tr>`;
    }).join("");
  };
  return `
    <div class="bs-container" style="display: flex; gap: 20px; width: 100%; flex-wrap: wrap;">
      <div class="bs-column" style="flex: 1; min-width: 300px;">
        <table>
          <thead>
            <tr style="background: var(--paper-alt); font-weight: 600;">
              <th>Liabilities</th>
              <th style="text-align: right">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(data.liabilities)}
            <tr style="font-weight: 600; background: var(--paper-alt); border-top: 2px solid var(--line);">
              <td>Total</td>
              <td class="num cr" style="text-align: right">${money(data.liabTotal)} Cr</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="bs-column" style="flex: 1; min-width: 300px;">
        <table>
          <thead>
            <tr style="background: var(--paper-alt); font-weight: 600;">
              <th>Assets</th>
              <th style="text-align: right">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(data.assets)}
            <tr style="font-weight: 600; background: var(--paper-alt); border-top: 2px solid var(--line);">
              <td>Total</td>
              <td class="num dr" style="text-align: right">${money(data.assetTotal)} Dr</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function pnlTable(data) {
  if (!data) return `<div class="empty">Nothing returned.</div>`;
  const renderRows = (list) => {
    return list.map(r => {
      const isGpGl = r.name.startsWith("Gross Profit") || r.name.startsWith("Gross Loss") || r.name.startsWith("Net Profit") || r.name.startsWith("Net Loss") || r.name === "Opening Stock" || r.name === "Closing Stock";
      let clickAttr = "";
      if (!isGpGl) {
        clickAttr = `data-opengroup="${esc(r.name)}"`;
      }
      const amtStr = r.amount ? money(r.amount) + " " + r.side : "";
      return `<tr class="row" ${clickAttr}>
        <td>${esc(r.name)}</td>
        <td class="num ${r.side === "Dr" ? "dr" : "cr"}">${amtStr}</td>
      </tr>`;
    }).join("");
  };
  return `
    <div style="font-weight: 600; margin-bottom: 8px; font-size: 14px; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 4px;">Trading Account</div>
    <div class="bs-container" style="display: flex; gap: 20px; width: 100%; flex-wrap: wrap; margin-bottom: 24px;">
      <div class="bs-column" style="flex: 1; min-width: 300px;">
        <table>
          <thead>
            <tr style="background: var(--paper-alt); font-weight: 600;">
              <th>Expenses</th>
              <th style="text-align: right">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(data.tradingLeft)}
            <tr style="font-weight: 600; background: var(--paper-alt); border-top: 2px solid var(--line);">
              <td>Total</td>
              <td class="num dr" style="text-align: right">${money(data.tradingTotal)} Dr</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="bs-column" style="flex: 1; min-width: 300px;">
        <table>
          <thead>
            <tr style="background: var(--paper-alt); font-weight: 600;">
              <th>Incomes</th>
              <th style="text-align: right">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(data.tradingRight)}
            <tr style="font-weight: 600; background: var(--paper-alt); border-top: 2px solid var(--line);">
              <td>Total</td>
              <td class="num cr" style="text-align: right">${money(data.tradingTotal)} Cr</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    
    <div style="font-weight: 600; margin-bottom: 8px; font-size: 14px; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 4px;">Profit & Loss Account</div>
    <div class="bs-container" style="display: flex; gap: 20px; width: 100%; flex-wrap: wrap;">
      <div class="bs-column" style="flex: 1; min-width: 300px;">
        <table>
          <thead>
            <tr style="background: var(--paper-alt); font-weight: 600;">
              <th>Expenses</th>
              <th style="text-align: right">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(data.pnlLeft)}
            <tr style="font-weight: 600; background: var(--paper-alt); border-top: 2px solid var(--line);">
              <td>Total</td>
              <td class="num dr" style="text-align: right">${money(data.pnlTotal)} Dr</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="bs-column" style="flex: 1; min-width: 300px;">
        <table>
          <thead>
            <tr style="background: var(--paper-alt); font-weight: 600;">
              <th>Incomes</th>
              <th style="text-align: right">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(data.pnlRight)}
            <tr style="font-weight: 600; background: var(--paper-alt); border-top: 2px solid var(--line);">
              <td>Total</td>
              <td class="num cr" style="text-align: right">${money(data.pnlTotal)} Cr</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function twoColTable(rows) {
  if (!rows.length) return `<div class="empty">Nothing returned.</div>`;
  return `<table><tr><th>Particulars</th><th style="text-align:right">Amount</th></tr>` +
    rows.map((r) => {
      const isHeader = r.name.startsWith("—") && r.name.endsWith("—");
      if (isHeader) {
        return `<tr style="font-weight:600; background:var(--paper-alt);"><td colspan="2">${esc(r.name)}</td></tr>`;
      }
      const isPnlLedger = isPLLedger(r.name);
      const isNetProfitLoss = r.name.toLowerCase() === "net profit" || r.name.toLowerCase() === "net loss";
      let clickAttr = "";
      if (isPnlLedger) {
        clickAttr = `data-openledger="${esc(r.name)}"`;
      } else if (!isNetProfitLoss) {
        clickAttr = `data-opengroup="${esc(r.name)}"`;
      }
      return `<tr class="row" ${clickAttr}><td>${esc(r.name)}</td>
        <td class="num ${r.side === "Dr" ? "dr" : "cr"}">${r.amount ? money(r.amount) + " " + r.side : ""}</td>
      </tr>`;
    }).join("") + `</table>`;
}

function simpleReport(title, url, tableFn, hideFrom = false) {
  const scr = {
    title,
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = reportBar("", hideFrom);
      el.appendChild(d);
      scr.refresh = () => wireReport(d, async () =>
        tableFn(await api(`${url}?from=${ymd(S.period.from)}&to=${ymd(S.period.to)}`)));
      scr.refresh();
    },
  };
  return scr;
}

/* ---------------------------------------------------- chart of accounts --- */
function coaScreen(presetFilter = "") {
  const scr = {
    title: "Chart of Accounts — Ledgers",
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = `<div class="rbar">
          <div class="search-box-wrap" style="flex:none; width:280px;"><input class="f" placeholder="Filter ledgers…" value="${esc(presetFilter)}"></div>
          <button class="btn reload">Refresh</button>
          <button class="btn gold newled">+ New Ledger (Alt+C)</button>
          <span class="bal-hint cnt"></span></div>
        <div class="rout"></div>`;
      el.appendChild(d);
      const paint = () => {
        const q = d.querySelector(".f").value.toLowerCase();
        const rows = S.ledgers.filter((l) => !q || l.name.toLowerCase().includes(q)
          || (l.parent || "").toLowerCase().includes(q));
        d.querySelector(".cnt").textContent = `${rows.length} / ${S.ledgers.length}`;
        d.querySelector(".rout").innerHTML = rows.length
          ? `<table><tr><th>Ledger</th><th>Under</th><th style="text-align:right">Closing Balance</th></tr>` +
            rows.map((l) => `<tr class="row" data-openledger="${esc(l.name)}">
              <td>${esc(l.name)}</td><td><span class="pill">${esc(l.parent)}</span></td>
              <td class="num ${l.side === "Dr" ? "dr" : "cr"}">${l.amount ? money(l.amount) + " " + l.side : "—"}</td>
            </tr>`).join("") + `</table>`
          : `<div class="empty">No ledgers match.</div>`;
        wirePostRender(d.querySelector(".rout"));
      };
      d.querySelector(".f").oninput = paint;
      d.querySelector(".reload").onclick = async () => { await loadMasters(); paint(); };
      d.querySelector(".newled").onclick = () => ledgerModal(paint);
      paint();
    },
  };
  return scr;
}

/* ------------------------------------------------------- voucher entry --- */
function blankRow(side) { return {side, ledger: "", amount: ""}; }

function voucherScreen(vtype) {
  const defaults = {Contra: ["Dr", "Cr"], Payment: ["Dr", "Cr"], Receipt: ["Cr", "Dr"],
                    Journal: ["Dr", "Cr"], Sales: ["Dr", "Cr"], Purchase: ["Cr", "Dr"]};
  const scr = {
    title: `Accounting Voucher Creation — ${vtype}`,
    vtype,
    rows: [blankRow((defaults[vtype] || ["Dr"])[0]), blankRow((defaults[vtype] || ["Dr", "Cr"])[1] || "Cr")],
    narration: "", number: "",
    render(el) {
      const d = document.createElement("div");
      d.className = "vch";
      d.innerHTML = `
        <div class="vch-head">
          <div><div class="vtype">${esc(vtype)}</div></div>
          <div><label>No. (blank = auto)</label><input class="vno" style="width:110px" value="${esc(scr.number)}"></div>
          <div><label>Date (F2)</label><input type="date" class="vdate" value="${S.vdate}"></div>
          <div style="margin-left:auto"><label>&nbsp;</label>
            <button class="btn gold accept">Accept (Ctrl+A)</button></div>
        </div>
        <div class="vch-body">
          <table class="vch-grid"><thead>
            <tr><th style="width:80px">Dr/Cr</th><th>Particulars</th>
            <th style="width:160px;text-align:right">Debit</th>
            <th style="width:160px;text-align:right">Credit</th></tr></thead>
            <tbody class="vrows"></tbody></table>
          <div class="note">Enter moves ahead · type <b>d</b>/<b>c</b> in the first column ·
            Alt+C in the ledger field creates a new ledger · the first line is taken as the party ledger.</div>
        </div>
        <div class="vch-foot">
          <textarea class="vnar" placeholder="Narration…">${esc(scr.narration)}</textarea>
          <div><div>Dr <span class="tot tdr">0.00</span></div>
               <div>Cr <span class="tot tcr">0.00</span></div></div>
          <div class="diff"></div>
        </div>`;
      el.appendChild(d);
      scr.el = d;
      d.querySelector(".vdate").onchange = (e) => { S.vdate = e.target.value; };
      d.querySelector(".vno").oninput = (e) => { scr.number = e.target.value; };
      d.querySelector(".vnar").oninput = (e) => { scr.narration = e.target.value; };
      d.querySelector(".accept").onclick = () => scr.accept();
      scr.paintRows();
    },

    paintRows() {
      const tb = scr.el.querySelector(".vrows");
      tb.innerHTML = scr.rows.map((r, i) => {
        const led = S.ledgers.find((l) => l.name === r.ledger);
        const bal = led && led.amount ? `${money(led.amount)} ${led.side}` : "";
        return `<tr data-i="${i}">
          <td><select class="drcr-sel" data-i="${i}">
            <option ${r.side === "Dr" ? "selected" : ""}>Dr</option>
            <option ${r.side === "Cr" ? "selected" : ""}>Cr</option></select></td>
          <td style="position:relative">
            <input class="led" data-i="${i}" value="${esc(r.ledger)}" placeholder="Ledger name…"
              autocomplete="off"><span class="bal-hint">${esc(bal)}</span></td>
          <td><input class="amt damt" data-i="${i}" inputmode="decimal"
              value="${r.side === "Dr" ? esc(r.amount) : ""}" ${r.side === "Cr" ? "disabled" : ""}></td>
          <td><input class="amt camt" data-i="${i}" inputmode="decimal"
              value="${r.side === "Cr" ? esc(r.amount) : ""}" ${r.side === "Dr" ? "disabled" : ""}></td>
        </tr>`;
      }).join("");

      tb.querySelectorAll(".drcr-sel").forEach((n) => {
        n.onchange = () => { scr.rows[+n.dataset.i].side = n.value; scr.paintRows(); scr.totals(); };
        n.onkeydown = (e) => {
          if (e.key.toLowerCase() === "d") { n.value = "Dr"; n.onchange(); e.preventDefault(); }
          if (e.key.toLowerCase() === "c") { n.value = "Cr"; n.onchange(); e.preventDefault(); }
        };
      });
      tb.querySelectorAll(".led").forEach((n) => attachAC(n, scr));
      tb.querySelectorAll(".amt").forEach((n) => {
        n.oninput = () => { scr.rows[+n.dataset.i].amount = n.value; scr.totals(); };
        n.onkeydown = (e) => {
          if (e.key === "Enter") { e.preventDefault(); scr.nextFromAmount(+n.dataset.i); }
        };
      });
      scr.totals();
    },

    nextFromAmount(i) {
      const r = scr.rows[i];
      if (i === scr.rows.length - 1 && r.ledger && parseFloat(r.amount) > 0) {
        const {dr, cr} = scr.sums();
        const diff = +(dr - cr).toFixed(2);
        const nextSide = diff > 0 ? "Cr" : "Dr";
        const row = blankRow(nextSide);
        if (Math.abs(diff) > 0.004) row.amount = Math.abs(diff).toFixed(2);
        scr.rows.push(row);
        scr.paintRows();
        const led = scr.el.querySelectorAll(".led");
        led[led.length - 1].focus();
      } else if (Math.abs(scr.sums().dr - scr.sums().cr) < 0.005 && scr.sums().dr > 0) {
        scr.accept();
      }
    },

    sums() {
      let dr = 0, cr = 0;
      scr.rows.forEach((r) => {
        const a = parseFloat(r.amount) || 0;
        if (r.side === "Dr") dr += a; else cr += a;
      });
      return {dr, cr};
    },

    totals() {
      const {dr, cr} = scr.sums();
      scr.el.querySelector(".tdr").textContent = money(dr);
      scr.el.querySelector(".tcr").textContent = money(cr);
      const diff = +(dr - cr).toFixed(2);
      scr.el.querySelector(".diff").innerHTML = Math.abs(diff) < 0.005 && dr > 0
        ? `<span class="ok">✓ balanced</span>`
        : `<span class="bad">diff ${money(Math.abs(diff))}</span>`;
    },

    accept() {
      const rows = scr.rows.filter((r) => r.ledger && parseFloat(r.amount) > 0);
      const {dr, cr} = scr.sums();
      if (!rows.length || Math.abs(dr - cr) > 0.005) {
        alert("Voucher is not balanced."); return;
      }
      const lines = rows.map((r) =>
        `<div style="display:flex;justify-content:space-between">
           <span>${esc(r.ledger)}</span>
           <span class="${r.side === "Dr" ? "dr" : "cr"}">${money(r.amount)} ${r.side}</span></div>`).join("");
      openModal(`Accept ${vtype} voucher?`,
        `<div style="font-family:var(--mono);font-size:12.5px">${lines}</div>
         <div class="note">Date ${tdate(S.vdate)} · this will be created inside Tally.</div>`,
        `<button class="btn" id="mNo">No (Esc)</button>
         <button class="btn gold" id="mYes">Yes (Y / Enter)</button>`,
        () => {
          $("mNo").onclick = closeModal;
          $("mYes").onclick = () => scr.post(rows);
        },
        (e) => {
          if (e.key === "Enter" || e.key.toLowerCase() === "y") { scr.post(rows); return true; }
          return false;
        });
    },

    async post(rows) {
      closeModal();
      try {
        const res = await api("/api/voucher", {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            vchtype: vtype, date: ymd(S.vdate), number: scr.number,
            narration: scr.narration,
            rows: rows.map((r) => ({ledger: r.ledger, side: r.side, amount: parseFloat(r.amount)})),
          }),
        });
        if (res.ok) {
          loadMasters();
          replaceTop(voucherScreen(vtype));
          flashTitle(`✓ ${vtype} voucher created in Tally`);
        } else {
          alert("Tally rejected the voucher:\n" + (res.lineerror || "unknown error"));
        }
      } catch (e) { alert("Error: " + e.message); }
    },

    onKey(e) {
      if (e.ctrlKey && e.key.toLowerCase() === "a") { e.preventDefault(); scr.accept(); return true; }
      return false;
    },
  };
  return scr;
}

function flashTitle(msg) {
  const t = $("screenTitle");
  t.textContent = msg; t.style.background = "#1f6e44";
  setTimeout(() => { t.style.background = ""; render(); }, 1600);
}

/* -------------------------------------------------- ledger autocomplete --- */
let acBox = null;
function killAC() { if (acBox) { acBox.remove(); acBox = null; } }
function attachAC(input, scr) {
  if (!window.acListenersWired) {
    window.acListenersWired = true;
    window.addEventListener("scroll", killAC, { capture: true, passive: true });
    window.addEventListener("resize", killAC, { passive: true });
  }
  let sel = 0, list = [];
  const paint = () => {
    if (!acBox) return;
    acBox.innerHTML = list.map((l, i) =>
      `<div class="${i === sel ? "sel" : ""}" data-i="${i}">
         <span>${esc(l.name)}</span>
         <span class="b">${esc(l.parent)}${l.amount ? " · " + money(l.amount) + " " + l.side : ""}</span>
       </div>`).join("") || `<div class="b" style="padding:8px 12px">No match — Alt+C to create</div>`;
    acBox.querySelectorAll("div[data-i]").forEach((n) => {
      n.onmousedown = (e) => { e.preventDefault(); choose(+n.dataset.i); };
    });
  };
  const open = () => {
    killAC();
    acBox = document.createElement("div");
    acBox.className = "ac";
    const r = input.getBoundingClientRect();
    acBox.style.left = r.left + "px";
    acBox.style.top = (r.bottom + 2) + "px";
    document.body.appendChild(acBox);
    filter();
  };
  const filter = () => {
    const q = input.value.toLowerCase();
    list = S.ledgers.filter((l) => l.name.toLowerCase().includes(q)).slice(0, 12);
    sel = 0; paint();
  };
  const choose = (i) => {
    if (!list[i]) return;
    input.value = list[i].name;
    scr.rows[+input.dataset.i].ledger = list[i].name;
    killAC(); scr.paintRows();
    const amts = scr.el.querySelectorAll(`tr[data-i="${input.dataset.i}"] .amt:not([disabled])`);
    if (amts[0]) amts[0].focus();
  };
  input.onfocus = open;
  input.oninput = () => { scr.rows[+input.dataset.i].ledger = input.value; if (!acBox) open(); else filter(); };
  input.onblur = () => setTimeout(killAC, 150);
  input.onkeydown = (e) => {
    if (e.altKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      ledgerModal(() => {}, input.value, (name) => {
        input.value = name; scr.rows[+input.dataset.i].ledger = name; scr.paintRows();
      });
      return;
    }
    if (!acBox) return;
    if (e.key === "ArrowDown") { sel = Math.min(sel + 1, list.length - 1); paint(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
    else if (e.key === "Escape") { killAC(); e.stopPropagation(); }
  };
}

/* ------------------------------------------------------- ledger modal --- */
function ledgerModal(after, presetName = "", onCreated = null) {
  const groups = S.groups.length ? S.groups :
    [{name: "Sundry Debtors"}, {name: "Sundry Creditors"}, {name: "Bank Accounts"},
     {name: "Cash-in-Hand"}, {name: "Indirect Expenses"}, {name: "Sales Accounts"}];
  openModal("Ledger Creation",
    `<label>Name</label><input id="lcName" value="${esc(presetName)}">
     <label>Under (group)</label>
     <select id="lcGroup">${groups.map((g) => `<option>${esc(g.name)}</option>`).join("")}</select>
     <label>Opening balance (optional)</label>
     <div style="display:flex;gap:8px">
       <input id="lcOpen" inputmode="decimal" placeholder="0.00" style="flex:1">
       <select id="lcSide" style="width:80px"><option>Dr</option><option>Cr</option></select>
     </div>`,
    `<button class="btn" id="mNo">Cancel</button>
     <button class="btn gold" id="mYes">Create in Tally</button>`,
    () => {
      $("lcName").focus();
      $("mNo").onclick = closeModal;
      $("mYes").onclick = async () => {
        const name = $("lcName").value.trim();
        if (!name) return alert("Name is required");
        const res = await api("/api/ledger", {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({name, parent: $("lcGroup").value,
            opening: $("lcOpen").value || 0, openingSide: $("lcSide").value}),
        });
        if (res.ok) {
          closeModal();
          await loadMasters();
          if (onCreated) onCreated(name);
          if (after) after();
        } else alert("Tally rejected it:\n" + (res.lineerror || "unknown error"));
      };
    });
}

/* --------------------------------------------------------- xml console --- */

/* ------------------------------------------------------ load tally data --- */
function importModal(firstRun = false) {
  openModal("Load Tally Data",
    `<div class="note" style="margin-top:0">
       Export from Tally on any PC (one time), then load the files here:<br>
       <b>Masters</b> — Gateway of Tally → Alt+E → Masters → Format <b>XML</b> → All Masters<br>
       <b>Transactions</b> — Gateway of Tally → Alt+E → Transactions → Format <b>XML</b>,
       period = full year (or Day Book → Alt+E)<br>
       Send the .xml files to this device (via AirDrop, WhatsApp, Google Drive, etc.) and select them below.
     </div>
     <label>Tally XML export files (you can select both at once)</label>
     <input type="file" id="impFiles" multiple accept=".xml,text/xml">
     <label style="display:flex;align-items:center;gap:8px;margin-top:12px">
       <input type="checkbox" id="impReplace" style="width:auto" ${firstRun ? "" : "checked"}>
       Replace existing data (untick to merge/append)</label>
     <div id="impMsg" class="note"></div>`,
    `<button class="btn" id="mNo">Close</button>
     <button class="btn gold" id="mYes">Load Data</button>`,
    () => {
      $("mNo").onclick = closeModal;
      $("mYes").onclick = async () => {
        const files = $("impFiles").files;
        if (!files.length) return alert("Choose at least one XML file");
        const progress = (m) => { $("impMsg").textContent = m; };
        progress("Loading… (large files can take a minute)");
        try {
          const j = await dal.importFiles([...files], $("impReplace").checked, progress);
          if (j.ok) {
            $("impMsg").innerHTML =
              `✓ Loaded <b>${j.ledgers}</b> ledgers, <b>${j.groups}</b> groups,
               <b>${j.vouchers}</b> vouchers.` +
              (j.errors.length ? `<br>Warnings: ${esc(j.errors.join("; "))}` : "");
            await loadMasters();
            boot();
          } else {
            $("impMsg").textContent = "Failed: " + (j.errors || []).join("; ");
          }
        } catch (e) { $("impMsg").textContent = "Error: " + e.message; }
      };
    });
}

async function exportNew() {
  const st = await api("/api/data-status");
  if (!st.new_vouchers) {
    alert("No new vouchers to export yet. Vouchers you create here appear in this export.");
    return;
  }
  if (confirm(`Download Tally import XML with ${st.new_vouchers} new voucher(s)?\n` +
      `On the Tally PC: Gateway of Tally → Alt+O (Import) → Transactions → choose this file.`)) {
    const xml = await dal.exportNewXML();
    const blob = new Blob([xml], {type: "application/xml"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tallyweb-new-vouchers-${new Date().toISOString().slice(0, 10)}.xml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

/* ---------------------------------------------------- settings / dates --- */
async function settingsModal() {
  const st = await api("/api/data-status");
  openModal("Data & Settings",
    `<div class="note" style="margin-top:0">
       <b>${esc(st.company || "No company loaded")}</b><br>
       <b>${st.ledgers}</b> ledgers · <b>${st.vouchers}</b> vouchers
       · <b>${st.new_vouchers}</b> new (not yet exported)</div>
     <label>Company name (shown in the top bar)</label>
     <input id="cCompName" value="${esc(st.company || "")}">
     <div class="rbar" style="margin-top:14px">
       <button class="btn" id="cImport">Load Tally data…</button>
       <button class="btn" id="cExport">Export new vouchers</button>
       <button class="btn danger" id="cReset">Clear all data</button>
     </div>
     <div class="note">Your data is stored in your Supabase project. Access can be secured by setting an APP_PIN in config.js.</div>`,
    `<button class="btn danger" id="cLock">Lock app</button>
     <button class="btn" id="mNo">Close</button>
     <button class="btn gold" id="mYes">Save</button>`,
    () => {
      $("mNo").onclick = closeModal;
      $("cImport").onclick = () => { closeModal(); importModal(); };
      $("cExport").onclick = () => { closeModal(); exportNew(); };
      $("cReset").onclick = async () => {
        if (!confirm("Delete ALL Tally data? (New vouchers not yet exported will be lost)")) return;
        await dal.resetData();
        closeModal(); boot();
      };
      $("cLock").onclick = () => {
        sessionStorage.removeItem("tw_auth");
        closeModal(); boot();
      };
      $("mYes").onclick = async () => {
        const name = $("cCompName").value.trim();
        localStorage.setItem("tw_company", name);
        try {
          await sb.from("config").upsert({key: "company_name", value: name});
        } catch (e) {}
        closeModal(); boot();
      };
    });
}

function dateModal() {
  openModal("Voucher Date (F2)",
    `<label>Date</label><input type="date" id="dV" value="${S.vdate}">`,
    `<button class="btn" id="mNo">Cancel</button><button class="btn gold" id="mYes">Set</button>`,
    () => {
      $("dV").focus();
      $("mNo").onclick = closeModal;
      $("mYes").onclick = () => { S.vdate = $("dV").value; closeModal(); render(); };
    });
}

function periodModal() {
  openModal("Change Period (Alt+F2)",
    `<label>From</label><input type="date" id="pF" value="${S.period.from}">
     <label>To</label><input type="date" id="pT" value="${S.period.to}">`,
    `<button class="btn" id="mNo">Cancel</button><button class="btn gold" id="mYes">Set</button>`,
    () => {
      $("mNo").onclick = closeModal;
      $("mYes").onclick = () => {
        S.period.from = $("pF").value; S.period.to = $("pT").value;
        closeModal(); periodLabel(); render();
      };
    });
}

/* ------------------------------------------------------------ keyboard --- */
document.addEventListener("keydown", (e) => {
  if (!$("modal").classList.contains("hidden")) {
    if (modalKeyHandler && modalKeyHandler(e)) { e.preventDefault(); return; }
    if (e.key === "Escape") { closeModal(); e.preventDefault(); }
    return;
  }
  const fkeys = {F4: "Contra", F5: "Payment", F6: "Receipt", F7: "Journal", F8: "Sales", F9: "Purchase"};
  if (e.key === "F2" && e.altKey) { e.preventDefault(); periodModal(); return; }
  if (e.key === "F2") { e.preventDefault(); dateModal(); return; }
  if (fkeys[e.key]) { e.preventDefault(); push(voucherScreen(fkeys[e.key])); return; }
  if (e.key === "F10") { e.preventDefault(); push(dashboardScreen()); return; }
  if (e.key === "F11") { e.preventDefault(); loadMasters(true); return; }
  if (e.key === "F12") { e.preventDefault(); settingsModal(); return; }
  if (e.key === "Escape") {
    if (acBox) { killAC(); return; }
    pop(); return;
  }
  const scr = S.stack[S.stack.length - 1];
  const inField = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
  if (scr.onKey && (!inField || (e.ctrlKey || e.metaKey))) {
    if (scr.onKey(e)) e.preventDefault();
  }
});

$("periodLabel").onclick = periodModal;
document.querySelectorAll("#btnbar button").forEach((b) => {
  b.onclick = () => {
    const a = b.dataset.act;
    if (a === "date") dateModal();
    else if (a === "period") periodModal();
    else if (a === "refresh") loadMasters(true);
    else if (a === "settings") settingsModal();
    else if (a === "dashboard") push(dashboardScreen());
    else if (a.startsWith("vch:")) push(voucherScreen(a.slice(4)));
  };
});

/* ----------------------------------------------------------------- boot --- */
async function loadMasters(flash) {
  try {
    const [led, grp] = await Promise.all([api("/api/ledgers"), api("/api/groups")]);
    S.ledgers = led; S.groups = grp;
    S.groupNatures = {};
    grp.forEach(g => {
      S.groupNatures[g.name.toLowerCase()] = g.nature || "";
    });
    const dl = $("ledDL");
    if (dl) dl.innerHTML = led.map(l => `<option value="${esc(l.name)}">`).join("");
    if (flash) flashTitle(`✓ Reloaded ${led.length} ledgers from database`);
  } catch (e) { /* shown via conn status */ }
}

function authScreen() {
  const pin = (window.TALLY_CONFIG.APP_PIN || "").toString().trim();
  if (!pin) { closeModal(); return; } // no PIN set — open directly
  openModal("Tally Web",
    `<div class="note" style="margin-top:0;text-align:center;font-size:15px">Enter PIN</div>
     <input id="aPin" type="password" inputmode="numeric" maxlength="10"
        style="text-align:center;font-size:22px;letter-spacing:8px;margin-top:8px">
     <div id="aMsg" class="note" style="color:var(--dr)"></div>`,
    `<button class="btn gold" id="aIn" style="width:100%">Open →</button>`,
    () => {
      $("aPin").focus();
      const go = () => {
        if ($("aPin").value.trim() === pin) { sessionStorage.setItem("tw_auth","1"); closeModal(); boot(); }
        else { $("aMsg").textContent = "Wrong PIN"; $("aPin").value = ""; $("aPin").focus(); }
      };
      $("aIn").onclick = go;
      $("aPin").onkeydown = (e) => { if (e.key === "Enter") go(); };
    },
    (e) => { if (e.key === "Escape") return true; return false; });
}

async function boot() {
  initTheme();
  periodLabel();
  // PIN check
  const pin = (window.TALLY_CONFIG.APP_PIN || "").toString().trim();
  if (pin && sessionStorage.getItem("tw_auth") !== "1") {
    $("companyName").textContent = "—";
    $("conn").className = "conn bad";
    $("connText").textContent = "locked";
    if (S.stack.length === 0) push(gatewayScreen());
    authScreen();
    return;
  }
  S.cfg = {mode: "cloud"};
  let st = null;
  try {
    st = await api("/api/data-status");
    
    let companyName = st.company;
    if (!companyName) {
      try {
        const {data} = await sb.from("config").select("value").eq("key", "company_name").maybeSingle();
        if (data && data.value) {
          companyName = data.value;
          localStorage.setItem("tw_company", companyName);
        }
      } catch (e) {}
    }
    $("companyName").textContent = companyName || "Tally Web";
    
    $("conn").className = "conn " + (st.vouchers || st.ledgers ? "ok" : "bad");
    let connMsg = st.vouchers || st.ledgers
      ? `cloud · ${st.ledgers} ledgers · ${st.vouchers} vch`
      : "no data loaded — press O";
    if (st.blank_parents > 0) {
      connMsg += ` · ⚠️ ${st.blank_parents} unmapped (Suspense)`;
    }
    $("connText").textContent = connMsg;
    
    await loadMasters();
    if (!st.ledgers && !st.vouchers && S.stack.length <= 1) {
      setTimeout(() => importModal(true), 300);
    }
  } catch (e) {
    $("conn").className = "conn bad";
    $("connText").textContent = "error: " + e.message;
  }
  if (S.stack.length === 0) {
    push(gatewayScreen());
    if (st && (st.vouchers || st.ledgers)) {
      push(dashboardScreen());
    }
  } else render();
}
boot();
