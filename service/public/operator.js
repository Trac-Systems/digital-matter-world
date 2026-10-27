import { presentation } from '/web/console/js/api.js';
async function refresh() { const out = document.getElementById('status'); try { const r = await fetch('/operator/status'); if (!r.ok) throw Error('Status unavailable'); out.textContent = JSON.stringify(presentation(await r.json()), null, 2); } catch (e) { out.textContent = e.message; } }
refresh(); setInterval(refresh, 10000);
