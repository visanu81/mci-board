import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const renderSource=html.slice(html.indexOf('function renderFieldSummary()'),html.indexOf('function renderPatientWorkspace('));
const totalsSource=html.slice(html.indexOf('function getTotals()'),html.indexOf('// ==================== 렌더링'));
const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(readOnly=true) {
  const state={fieldTab:'incident',briefingMode:true,incident:{location:'<img src=x onerror=alert(1)>',summary:'overview'},damages:{medical:{dead:20,severe:30}},mobilizations:{medical:{agencies:{fire:{p:3,v:2}},vehicles:{pump:2}}},actions:[{timestamp:1,content:'<script>bad</script>',author:'crew',teamId:'medical'}],casualties:[{name:'PRIVATE',triage:'urgent',cardNo:1}],mciCasualties:[{triage:'urgent'},{triage:'urgent'}]};
  let formCalls=0;
  const form=()=>{formCalls++;return '<form>editable</form>';};
  const api=new Function('state','TEAMS','AGENCIES','VEHICLES','MCI_TRIAGE','escapeHtml','maskName','renderIncidentForm','renderMobilForm','renderActionForm','renderDamageForm','isObserver','document','bindIncidentEvents','bindMobilEvents','bindActionEvents','bindDamageEvents',totalsSource+renderSource+';return {renderFieldWorkspace,renderFieldSummary,renderFieldActivitySummary,bindFieldWorkspace};')(state,[{id:'medical',name:'Medical'}],[{id:'fire',name:'Fire'}],[{id:'pump',name:'Pump'}],[{id:'urgent',name:'Urgent'}],escapeHtml,()=> 'MASKED',form,form,form,form,()=>readOnly,{querySelectorAll:()=>[]},form,form,form,form);
  return {state,api,calls:()=>formCalls};
}
test('observer can read all field sections without rendering or binding writes',()=>{
  const {state,api,calls}=fixture();
  for(const tab of ['incident','mobilization','action','damage','legacy']){state.fieldTab=tab;api.renderFieldWorkspace(true);api.bindFieldWorkspace();}
  assert.equal(calls(),0);
});
test('field display escapes shared incident and timeline text',()=>{
  const {state,api}=fixture();
  assert(!api.renderFieldSummary().includes('<img'));
  state.fieldTab='action';const page=api.renderFieldWorkspace(true);
  assert(!page.includes('<script>'));assert(page.includes('&lt;script&gt;'));
});
test('legacy review masks names and does not mutate or merge patient collections',()=>{
  const {state,api}=fixture();state.fieldTab='legacy';const before=JSON.stringify(state);
  const page=api.renderFieldWorkspace(true);assert(page.includes('MASKED'));assert(!page.includes('PRIVATE'));
  assert(page.includes('1건'));assert(!page.includes('<form>'));assert.equal(JSON.stringify(state),before);
});
test('mobilization summary does not add vehicle breakdown or manual casualties',()=>{
  const {api}=fixture();const page=api.renderFieldActivitySummary();
  assert(page.includes('인력 3명 · 장비 2대'));assert(!page.includes('장비 4대'));assert(!page.includes('50명'));
});
test('writer binds only selected existing field form',()=>{
  const {state,api,calls}=fixture(false);state.fieldTab='mobilization';
  api.renderFieldWorkspace(false);api.bindFieldWorkspace();assert.equal(calls(),2);
  state.fieldTab='legacy';api.renderFieldWorkspace(false);api.bindFieldWorkspace();assert.equal(calls(),2);
});
