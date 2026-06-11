/* Tally Web — keyboard-first SPA over the Tally XML gateway */
"use strict";

/* ------------------------------------------------------------ helpers --- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const money = (n) => Number(n || 0).toLocaleString("en-IN", {minimumFractionDigits: 2});
const ymd = (iso) => (iso || "").replaceAll("-", "");
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
  const p = gmap[name.toLowerCase()];
  if (!p || ["", "primary"].includes(p.toLowerCase()) || p.toLowerCase() === name.toLowerCase()) return name;
  return topGroup(p, gmap, depth + 1);
}
function natureOf(top) {
  const t = (top || "").toLowerCase();
  if (INC_T.has(t)) return "income";
  if (EXP_T.has(t)) return "expense";
  if (LIAB_T.has(t)) return "liability";
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
    return {
      ledgers: await cnt("ledgers"), vouchers: await cnt("vouchers"),
      groups: await cnt("groups"), new_vouchers: await cnt("vouchers", "new"),
    };
  },

  async ledgers() {
    const rows = await fetchAll(() => sb.from("ledger_balances")
      .select("name,parent,closing").order("name"));
    return rows.map((r) => ({name: r.name, parent: r.parent || "", ...fdc(+r.closing)}));
  },

  async groups() {
    const rows = await fetchAll(() => sb.from("groups").select("name,parent").order("name"));
    return rows.length ? rows : DEFAULT_GROUPS.map((g) => ({name: g, parent: ""}));
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
    const agg = {};
    for (const [name, v] of Object.entries(cl)) {
      const key = v.parent || "(no group)";
      agg[key] = agg[key] || [0, 0];
      if (v.closing < -0.004) agg[key][0] += -v.closing;
      else if (v.closing > 0.004) agg[key][1] += v.closing;
    }
    return Object.keys(agg).sort().filter((k) => agg[k][0] || agg[k][1])
      .map((k) => ({name: k, debit: Math.round(agg[k][0] * 100) / 100,
                    credit: Math.round(agg[k][1] * 100) / 100}));
  },

  async naturedTotals(dto) {
    const cl = await dal.closings(dto);
    const grows = await fetchAll(() => sb.from("groups").select("name,parent"));
    const gmap = {};
    grows.forEach((g) => { gmap[g.name.toLowerCase()] = g.parent || ""; });
    const byTop = {};
    for (const v of Object.values(cl)) {
      if (Math.abs(v.closing) < 0.005) continue;
      const top = v.parent ? topGroup(v.parent, gmap) : "Suspense A/c";
      byTop[top] = (byTop[top] || 0) + v.closing;
    }
    return byTop;
  },

  async balanceSheet(dto) {
    const byTop = await dal.naturedTotals(dto);
    const liab = [], asset = [];
    let pnl = 0;
    for (const top of Object.keys(byTop).sort()) {
      const val = byTop[top], nat = natureOf(top);
      if (nat === "income" || nat === "expense") pnl += val;
      else if (nat === "liability") liab.push({name: top, ...fdc(val)});
      else asset.push({name: top, ...fdc(val)});
    }
    return [{name: "— LIABILITIES —", amount: 0, side: ""}, ...liab,
            {name: "Profit & Loss A/c", ...fdc(pnl)},
            {name: "— ASSETS —", amount: 0, side: ""}, ...asset];
  },

  async pnl(dto) {
    const byTop = await dal.naturedTotals(dto);
    const inc = [], exp = [];
    let net = 0;
    for (const top of Object.keys(byTop).sort()) {
      const val = byTop[top], nat = natureOf(top);
      if (nat === "income") { inc.push({name: top, ...fdc(val)}); net += val; }
      else if (nat === "expense") { exp.push({name: top, ...fdc(val)}); net += val; }
    }
    return [{name: "— INCOME —", amount: 0, side: ""}, ...inc,
            {name: "— EXPENSES —", amount: 0, side: ""}, ...exp,
            {name: net >= 0 ? "Net Profit" : "Net Loss", ...fdc(net)}];
  },

  async createLedger(b) {
    let opening = Math.abs(parseFloat(b.opening) || 0);
    if ((b.openingSide || "Dr") === "Dr") opening = -opening;
    const {error} = await sb.from("ledgers")
      .insert({name: b.name, parent: b.parent, opening});
    if (error) return {ok: false, lineerror: error.message};
    return {ok: true, created: 1};
  },

  async createVoucher(b) {
    const dr = b.rows.filter((r) => r.side === "Dr").reduce((s, r) => s + +r.amount, 0);
    const cr = b.rows.filter((r) => r.side === "Cr").reduce((s, r) => s + +r.amount, 0);
    if (Math.abs(dr - cr) > 0.005)
      return {ok: false, lineerror: `Voucher not balanced (Dr ${dr.toFixed(2)} / Cr ${cr.toFixed(2)})`};
    const {data, error} = await sb.from("vouchers").insert({
      date: b.date, vchtype: b.vchtype, number: b.number || "",
      party: b.rows[0].ledger, narration: b.narration || "", source: "new",
    }).select("id").single();
    if (error) return {ok: false, lineerror: error.message};
    const ents = b.rows.map((r) => ({
      vid: data.id, ledger: r.ledger,
      amount: r.side === "Dr" ? -Math.abs(+r.amount) : Math.abs(+r.amount),
    }));
    const {error: e2} = await sb.from("entries").insert(ents);
    if (e2) return {ok: false, lineerror: e2.message};
    // make sure ledgers exist for autocomplete next time
    for (const r of b.rows) {
      await sb.from("ledgers").upsert({name: r.ledger, parent: "", opening: 0},
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
    if (replace) await dal.resetData();
    const ft = (el, tag) => {
      const n = el.getElementsByTagName(tag)[0];
      return n && n.textContent ? n.textContent : "";
    };
    let tg = 0, tl = 0, tv = 0, company = "";
    const errors = [];
    for (const f of files) {
      try {
        progress(`Reading ${f.name}…`);
        let text = await f.text();
        text = text.replace(/&#(?:[0-8]|1[124-9]|2[0-9]|3[01]);/g, "")
                   .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
        const doc = new DOMParser().parseFromString(text, "text/xml");
        if (doc.getElementsByTagName("parsererror").length)
          throw new Error("not valid XML");
        company = company || ft(doc, "SVCURRENTCOMPANY") || ft(doc, "COMPANYNAME");

        const groups = [...doc.getElementsByTagName("GROUP")].map((g) => ({
          name: g.getAttribute("NAME") || ft(g, "NAME"),
          parent: ft(g, "PARENT"),
        })).filter((g) => g.name);
        const ledgers = [...doc.getElementsByTagName("LEDGER")].map((l) => ({
          name: l.getAttribute("NAME") || ft(l, "NAME"),
          parent: ft(l, "PARENT"),
          opening: pa(ft(l, "OPENINGBALANCE")),
        })).filter((l) => l.name);
        for (let i = 0; i < groups.length; i += 500) {
          const {error} = await sb.from("groups").upsert(groups.slice(i, i + 500),
            {onConflict: "name"});
          if (error) err(error);
        }
        for (let i = 0; i < ledgers.length; i += 500) {
          const {error} = await sb.from("ledgers").upsert(ledgers.slice(i, i + 500),
            {onConflict: "name"});
          if (error) err(error);
        }
        tg += groups.length; tl += ledgers.length;

        const vEls = [...doc.getElementsByTagName("VOUCHER")];
        const vrows = [], erows = [];
        for (const v of vEls) {
          const d = ft(v, "DATE");
          if (!/^\d{8}$/.test(d)) continue;
          const ents = [];
          for (const tag of ["ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST"]) {
            for (const le of v.getElementsByTagName(tag)) {
              const lname = ft(le, "LEDGERNAME");
              if (lname) ents.push({ledger: lname, amount: pa(ft(le, "AMOUNT"))});
            }
          }
          if (!ents.length) continue;
          vrows.push({date: d,
            vchtype: ft(v, "VOUCHERTYPENAME") || v.getAttribute("VCHTYPE") || "Journal",
            number: ft(v, "VOUCHERNUMBER"),
            party: ft(v, "PARTYLEDGERNAME") || ft(v, "PARTYNAME"),
            narration: ft(v, "NARRATION"), source: "import"});
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
      } catch (e) { errors.push(`${f.name}: ${e.message}`); }
    }
    if (company) localStorage.setItem("tw_company", company);
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
};

/* api() shim: routes the existing UI's calls to the Supabase data layer */
async function api(path, opts) {
  const [p, qs] = path.split("?");
  const q = Object.fromEntries(new URLSearchParams(qs || ""));
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
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
    case "/api/balance-sheet": return dal.balanceSheet(q.to);
    case "/api/pnl": return dal.pnl(q.to);
    case "/api/stock-summary": return [];
    case "/api/ledger": return dal.createLedger(body);
    case "/api/voucher": return dal.createVoucher(body);
    case "/api/voucher/delete": return dal.deleteVoucher(body.remoteid);
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
  const t = new Date();
  const fyStartYear = t.getMonth() >= 3 ? t.getFullYear() : t.getFullYear() - 1;
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
  if (e.target.id === "modal") closeModal();
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
  {label: "Ledger Vouchers", key: "L", run: () => push(ledVchScreen(""))},
  {label: "Trial Balance", key: "T", run: () => push(simpleReport("Trial Balance", "/api/trial-balance", trialTable))},
  {label: "Balance Sheet", key: "B", run: () => push(simpleReport("Balance Sheet", "/api/balance-sheet", twoColTable))},
  {label: "Profit & Loss A/c", key: "P", run: () => push(simpleReport("Profit & Loss A/c", "/api/pnl", twoColTable))},
  {label: "Cash Flow Statement", key: "F", run: () => push(cashFlowScreen())},
  {label: "Outstanding Aging", key: "A", run: () => push(agingScreen())},
  {label: "Stock Summary", key: "S", run: () => push(simpleReport("Stock Summary", "/api/stock-summary", stockTable))},
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

function reportBar(extraHTML = "") {
  return `<div class="rbar">
    <input type="date" class="rfrom" value="${S.period.from}">
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
        <td>${v.remoteid ? `<button class="btn danger" style="padding:2px 8px;font-size:11px"
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
      
      const amt = nce.amount;
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

function ledVchScreen(ledger) {
  const scr = {
    title: "Ledger Vouchers",
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = reportBar(
        `<input class="rled" list="ledDL" placeholder="Ledger…" style="width:220px" value="${esc(ledger)}">
         <datalist id="ledDL">${S.ledgers.map(l => `<option value="${esc(l.name)}">`).join("")}</datalist>
         <div class="search-box-wrap" style="margin-left: 10px;"><input class="rsearch" placeholder="Search vouchers…"></div>`
      );
      el.appendChild(d);
      
      const searchInput = d.querySelector(".rsearch");
      
      scr.refresh = () => wireReport(d, async () => {
        const led = d.querySelector(".rled").value.trim();
        if (!led) return `<div class="empty">Type a ledger name and press Load.</div>`;
        
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

function twoColTable(rows) {
  if (!rows.length) return `<div class="empty">Nothing returned.</div>`;
  return `<table><tr><th>Particulars</th><th style="text-align:right">Amount</th></tr>` +
    rows.map((r) => `<tr><td>${esc(r.name)}</td>
      <td class="num ${r.side === "Dr" ? "dr" : "cr"}">${r.amount ? money(r.amount) + " " + r.side : ""}</td>
    </tr>`).join("") + `</table>`;
}

function stockTable(rows) {
  if (!rows.length) return `<div class="empty">No stock items (or inventory not in use).</div>`;
  return `<table><tr><th>Item</th><th style="text-align:right">Quantity</th>
    <th style="text-align:right">Rate</th><th style="text-align:right">Value</th></tr>` +
    rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${esc(r.qty)}</td>
      <td class="num">${esc(r.rate)}</td><td class="num">${esc(r.amount)}</td></tr>`).join("") +
    `</table>`;
}

function simpleReport(title, url, tableFn) {
  const scr = {
    title,
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = reportBar();
      el.appendChild(d);
      scr.refresh = () => wireReport(d, async () =>
        tableFn(await api(`${url}?from=${ymd(S.period.from)}&to=${ymd(S.period.to)}`)));
      scr.refresh();
    },
  };
  return scr;
}

/* ---------------------------------------------------- chart of accounts --- */
function coaScreen() {
  const scr = {
    title: "Chart of Accounts — Ledgers",
    render(el) {
      const d = document.createElement("div");
      d.className = "report";
      d.innerHTML = `<div class="rbar">
          <div class="search-box-wrap" style="flex:none; width:280px;"><input class="f" placeholder="Filter ledgers…"></div>
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
  const t = $("screenTitle"), old = t.textContent;
  t.textContent = msg; t.style.background = "#1f6e44";
  setTimeout(() => { t.style.background = ""; render(); }, 1600);
}

/* -------------------------------------------------- ledger autocomplete --- */
let acBox = null;
function killAC() { if (acBox) { acBox.remove(); acBox = null; } }
function attachAC(input, scr) {
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
       Send the .xml files to this Mac (AirDrop / WhatsApp / Drive) and select them below.
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
     <div class="note">Your data is stored in your Supabase project and is private
       to this login (Row Level Security).</div>`,
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
      $("mYes").onclick = () => {
        localStorage.setItem("tw_company", $("cCompName").value.trim());
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
    if (e.key === "Escape") { closeModal(); e.preventDefault(); }
    else if (modalKeyHandler && modalKeyHandler(e)) e.preventDefault();
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
    if (flash) flashTitle(`✓ Reloaded ${led.length} ledgers from Tally`);
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
        if ($("aPin").value.trim() === pin) { sessionStorage.setItem("tw_auth","1"); closeModal(); }
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
    $("companyName").textContent = st.company || "Tally Web";
    $("conn").className = "conn " + (st.vouchers || st.ledgers ? "ok" : "bad");
    $("connText").textContent = st.vouchers || st.ledgers
      ? `cloud · ${st.ledgers} ledgers · ${st.vouchers} vch`
      : "no data loaded — press O";
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
