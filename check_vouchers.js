const url = "https://orsosssoxcyylncvgvnb.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yc29zc3NveGN5eWxuY3Zndm5iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNDAyODcsImV4cCI6MjA5NTgxNjI4N30.QtQoDQPYlRPYeaVOB5F9Z0IKRPNCwmBxkLMoRqD5nK4";

async function check() {
  let allLedgers = [];
  let from = 0;
  for (;;) {
    const res = await fetch(`${url}/rest/v1/ledgers?select=name,parent,opening&order=name&offset=${from}&limit=1000`, {
      headers: {
        "apikey": key,
        "Authorization": `Bearer ${key}`
      }
    });
    const data = await res.json();
    allLedgers = allLedgers.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  
  let allEntries = [];
  from = 0;
  for (;;) {
    const res = await fetch(`${url}/rest/v1/entries?select=ledger,amount&offset=${from}&limit=1000`, {
      headers: {
        "apikey": key,
        "Authorization": `Bearer ${key}`
      }
    });
    const data = await res.json();
    allEntries = allEntries.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  
  const sums = {};
  allEntries.forEach(e => {
    sums[e.ledger] = (sums[e.ledger] || 0) + parseFloat(e.amount || 0);
  });
  
  const grows = await fetch(`${url}/rest/v1/groups?select=name,parent`, {
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`
    }
  }).then(r => r.json());
  
  const gmap = {};
  grows.forEach((g) => { gmap[g.name.toLowerCase()] = g.parent || ""; });
  
  function topGroup(name, depth = 0) {
    if (!name || depth > 30) return name || "";
    const p = gmap[name.toLowerCase()];
    if (!p || ["", "primary"].includes(p.toLowerCase()) || p.toLowerCase() === name.toLowerCase()) return name;
    return topGroup(p, depth + 1);
  }
  
  const suspenseLedgers = [];
  allLedgers.forEach(l => {
    const top = l.parent ? topGroup(l.parent) : "Suspense A/c";
    if (top.toLowerCase() === "suspense a/c") {
      const closing = parseFloat(l.opening || 0) + (sums[l.name] || 0);
      suspenseLedgers.push({ name: l.name, parent: l.parent, closing });
    }
  });
  
  console.log("Total Suspense A/c Ledgers:", suspenseLedgers.length);
  suspenseLedgers.sort((a,b) => Math.abs(b.closing) - Math.abs(a.closing));
  console.log("Top Suspense Ledgers by closing balance:");
  console.log(suspenseLedgers.slice(0, 15));
}
check();
