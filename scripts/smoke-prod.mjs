#!/usr/bin/env node




const apiBase = (process.argv[2] || process.env.NIE_SLA_API_BASE || process.env.NSTATUS_API_BASE || 'https://api.example.com').replace(/\/+$/, '');
const siteBase = (process.argv[3] || process.env.NIE_SLA_SITE_BASE || process.env.NSTATUS_SITE_BASE || process.env.NSTATUS_PAGES_BASE || apiBase).replace(/\/+$/, '');

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, text, json };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const results = [];
function pass(name) { results.push(['PASS', name]); console.log('  PASS', name); }
function fail(name, err) { results.push(['FAIL', name, String(err)]); console.error('  FAIL', name, err); }

async function main() {
  console.log('Smoke API:', apiBase);
  console.log('Smoke Site:', siteBase);

  try {
    const { res, json } = await get(apiBase + '/api/health');
    assert(res.ok && json?.ok, 'health not ok');
    pass('health');
  } catch (e) { fail('health', e.message || e); }

  try {
    const { res, json } = await get(apiBase + '/api/status?lite=1');
    assert(res.ok && json?.ok, 'status not ok');
    assert(Array.isArray(json.targets), 'status targets missing');
    pass('status lite targets=' + json.targets.length);
  } catch (e) { fail('status', e.message || e); }

  try {
    const { res, json } = await get(apiBase + '/api/agent/metrics?agent_id=vps&hours=168&max_points=0');
    assert(res.ok && json?.ok, 'metrics not ok');

    let points = 0;
    if (Array.isArray(json.history)) points = json.history.length;
    else if (json.series?.dt) points = json.series.dt.length;
    assert(points <= 4000, 'metrics points not capped: ' + points);
    pass('metrics cap points=' + points);
  } catch (e) { fail('metrics-cap', e.message || e); }

  try {
    const { res } = await get(siteBase + '/');
    assert(res.ok, 'site status ' + res.status);
    pass('site home');
  } catch (e) { fail('site', e.message || e); }

  try {
    const { res, text } = await get(siteBase + '/__nie_sla_smoke__/missing-page');
    assert(res.status === 404, 'unknown route status ' + res.status);
    assert(/^text\/html(?:;|$)/i.test(res.headers.get('content-type') || ''), 'unknown route is not HTML');
    assert(/<title>页面不存在 - NIE-SLA<\/title>/.test(text), 'unknown route is missing the branded 404 page');
    assert(/class="not-found-code">404<\/div>/.test(text), 'unknown route is missing the visible 404 code');
    pass('site branded 404');
  } catch (e) { fail('site-404', e.message || e); }

  try {
    const { res, text } = await get(siteBase + '/config.js');
    assert(res.ok, 'config.js missing');
    assert(!/apiFromUrl|params\.get\(['"]api['"]\)/.test(text), 'config.js still allows ?api= override');
    pass('config no api override');
  } catch (e) { fail('config', e.message || e); }

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\nResults:', results.length - failed.length, 'passed,', failed.length, 'failed');
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
