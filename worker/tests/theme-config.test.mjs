import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { getPublicTheme, getThemeConfig, updateThemeConfig, updateTheme, uploadTheme } from '../src/themes.js';

function d1(){ const m=new Map(); return { prepare(q){ return { bind(...a){ return { first: async()=>{ const k=a[0]; return m.has(k)?{value:m.get(k)}:null; }, run: async()=>{ m.set(a[0], a[1]); return {success:true}; }, all: async()=>({results:[]}) }; } } } }; }
function r2(){ const s=new Map(); return { put: async(k,v)=>s.set(k,v), get: async(k)=> s.has(k)?{body:s.get(k)}:null, list: async(o)=>({objects:[...s.keys()].filter(k=>k.startsWith(o.prefix)).map(k=>({key:k}))}), delete: async(ks)=>{ for(const k of (Array.isArray(ks)?ks:[ks])) s.delete(k); } }; }
const env={ DB: d1(), ARCHIVE: r2(), PUBLIC_SITE_ORIGIN:'https://status.example.test' };
function themeZip(manifest, files){
  const entries={}; for(const[k,v] of Object.entries(files)) entries[k]=strToU8(v);
  entries['manifest.json']=strToU8(JSON.stringify(manifest));
  return zipSync(entries);
}
function uploadRequest(zip){
  const h=createHash('sha256').update(zip).digest('hex');
  return { headers:{ get(n){ const m={ 'content-type':'application/zip','content-length':String(zip.length),'x-theme-sha256':h }; return m[n.toLowerCase()]||null; } }, arrayBuffer: async()=> zip.buffer.slice(zip.byteOffset, zip.byteOffset+zip.byteLength) };
}
function jsonReq(body){ return new Request('https://api.example.test', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }); }

const manifest={
  schema:'nie-sla-theme-v1', id:'cfg-demo', name:'CFG Demo', version:'1.0.0', type:'theme', mode:'css', styles:['theme.css'],
  settings:[
    {key:'hero_title', type:'text', label:'大标题', default:'NIE-SLA'},
    {key:'accent', type:'color', label:'强调色', default:'#2ea36d'},
    {key:'show_banner', type:'boolean', label:'显示横幅', default:true},
    {key:'layout', type:'select', label:'布局', default:'classic', options:[{value:'classic',label:'经典'},{value:'compact',label:'紧凑'}]},
  ]
};
const zip=themeZip(manifest, {'theme.css':'body{color: var(--nie-sla-accent)}'});
const up=await uploadTheme(uploadRequest(zip), env);
assert.equal(up.theme.settings.length, 4);
const cfg0=await getThemeConfig('cfg-demo', env);
assert.equal(cfg0.values.hero_title, 'NIE-SLA');
assert.equal(cfg0.values.accent, '#2ea36d');
assert.equal(cfg0.values.show_banner, true);
assert.equal(cfg0.values.layout, 'classic');
const upd=await updateThemeConfig('cfg-demo', jsonReq({values:{hero_title:'Hello', accent:'#ff0000', show_banner:false, layout:'compact'}}), env);
assert.equal(upd.values.hero_title, 'Hello');
assert.equal(upd.values.accent, '#ff0000');
assert.equal(upd.values.show_banner, false);
await updateTheme('cfg-demo', jsonReq({enabled:true}), env);
const pub2=await getPublicTheme(env);
assert.equal(pub2.active_theme.config.hero_title, 'Hello');
assert.equal(pub2.active_theme.config.accent, '#ff0000');
console.log('PASS theme-config');
