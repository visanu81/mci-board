import { mayReplay } from '../secure-session.js';
// Production-source regression tests. No Firebase/network access or patient data.
export async function runSafetyTests(html) {
  html = html.replace(/\r\n/g, '\n');
  const results = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const equal = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), message);
  const test = async (name, fn) => {
    try { await fn(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  };
  const between = (start, end) => {
    const a = html.indexOf(start), b = html.indexOf(end, a);
    if (a < 0 || b < 0) throw new Error('Source boundary missing: ' + start);
    return html.slice(a, b);
  };
  const lockQueues = new Map();
  const locks = {request(name, options, callback) {
    const pending = (lockQueues.get(name) || Promise.resolve()).catch(()=>{}).then(callback);
    lockQueues.set(name,pending);
    return pending;
  }};
  function harness(options = {}) {
    const shared = options.shared || {raw:options.raw ?? null};
    const writes = [], statuses = {}, notices = [], storageKeys = [];
    const storage = {
      getItem() { if (options.readError) throw new Error('SecurityError'); return shared.raw; },
      setItem(key, value) {
        storageKeys.push(key);
        if (options.quota || (options.evictSent && value.includes('"status":"sent"'))) throw new Error('QuotaExceededError');
        shared.raw = value;
      }
    };
    const remoteWrite = (method) => (r, value) => {
      writes.push({ method, path: r, value });
      return options.online === false ? new Promise(() => {}) : Promise.resolve();
    };
    const core = between('const OUTBOX_KEY =', '// 미전송 배지(');
    const saves = between('async function saveFieldRecord(', '// ==================== 데이터 내보내기');
    const patch = html.includes('function changedCardFields(')
      ? between('function changedCardFields(', 'function currentCasualtyDraft(') : '';
    const source = 'const DB_ROOT = ' + JSON.stringify(options.dbRoot ?? 'mci2') + ';\n' + core + '\n' + saves + '\n' + patch + `
      return {
        saveIncident, saveDamage, saveMobil, addAction, deleteAction,
        saveCasualty, saveMciCasualty, deleteCasualty, deleteMciCasualty,
        outboxCleanup, replayOutbox, outboxEnqueue,
        changedCardFields: typeof changedCardFields === 'function' ? changedCardFields : null
      };`;
    const api = new Function('localStorage', 'navigator', 'window', 'ref', 'set', 'update', 'remove', 'push',
      'db', 'state', 'incPath', 'assertCanWrite', 'setSaveStatus', 'clearSaveStatus', 'setTimeout',
      'POPOUT_DISPLAY', 'authReady', 'updateOutboxBadge', 'secureIdentity', 'firebaseConfig', 'mayReplay', 'auth', 'sendBoundOperation', source)(
      storage, { onLine: options.online !== false, locks: options.noLocks ? undefined : locks },
      { __mciShowOutboxStatus: (m) => notices.push(m) },
      (db, path) => path, remoteWrite('set'), remoteWrite('update'), remoteWrite('remove'),
      () => ({ key: 'new-card' }), {}, { currentIncidentId: 'test', casualties: [], mciCasualties: [] },
      (suffix) => 'mci2/incidents/test/' + suffix, () => true,
      (key, value) => { statuses[key] = value; }, () => {}, () => 0, false, Promise.resolve(), () => {}, {uid:'fixture-uid',agencyId:'a',active:true,environment:'test',role:'normal',expiresAt:Date.now()+3600000}, {projectId:'mci2-fixture'}, mayReplay, {currentUser:{uid:'fixture-uid'}}, options.sender || (op => remoteWrite(op.method)(op.path,op.payload)));
    return { ...api, raw: () => shared.raw, writes, statuses, notices, storageKeys };
  }
  await test('two tabs retain all simultaneous enqueues with unique sequence numbers',async()=>{
    const shared={raw:null};const a=harness({shared,online:false}),b=harness({shared,online:false});
    await Promise.all(Array.from({length:80},(_,i)=>(i%2?a:b).outboxEnqueue({kind:'action',method:'set',path:'mci2/incidents/test/actions/'+i,payload:{text:String(i)}})));
    const ops=Object.values(JSON.parse(shared.raw).ops);
    assert(ops.length===80,'concurrent save lost');
    assert(new Set(ops.map(x=>x.seq)).size===80,'sequence collision');
  });
  await test('another tab can enqueue during network send without retrying the active operation',async()=>{
    const shared={raw:null};let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);const sent=[];
    const a=harness({shared,sender:async op=>{sent.push(op.opId);started();await gate;}});
    const b=harness({shared,sender:async op=>{sent.push(op.opId);}});
    const first=a.saveIncident({title:'first'});await ready;
    await b.outboxEnqueue({kind:'action',method:'set',path:'mci2/incidents/test/actions/second',payload:{text:'second'}});
    assert(Object.keys(JSON.parse(shared.raw).ops).length===2,'enqueue waited for network or lost record');
    const retry=b.replayOutbox({manual:true});
    await Promise.resolve();assert(sent.length===1,'active send duplicated');
    release();await Promise.all([first,retry]);
    assert(sent.length===2 && new Set(sent).size===2,'duplicate delivery or lost operation');
    assert(Object.values(JSON.parse(shared.raw).ops).every(x=>x.status==='sent'),'completion overwrote new input');
  });
  await test('closed tab sending state recovers once the send lock is available',async()=>{
    const shared={raw:null};const a=harness({shared,online:false});
    const id=await a.outboxEnqueue({kind:'action',method:'set',path:'mci2/incidents/test/actions/recovered',payload:{text:'retained'}});
    const queue=JSON.parse(shared.raw);queue.ops[id].status='sending';shared.raw=JSON.stringify(queue);
    const b=harness({shared});await b.replayOutbox();
    assert(b.writes.length===1 && JSON.parse(shared.raw).ops[id].status==='sent','interrupted send not recovered');
  });
  await test('unsupported browser preserves input without network writes',async()=>{
    const x=harness({noLocks:true});assert(await x.saveIncident({title:'keep'})===false,'unsafe save accepted');
    assert(x.raw()===null && x.writes.length===0,'storage or server changed');
    assert(x.notices.length>0,'unsupported browser not explained');
  });
  for (const [label, save, status] of [
    ['incident', x=>x.saveIncident({title:'fixture'}), 'incident'],
    ['damage', x=>x.saveDamage('medical',{dead:0},'tester'), 'damage'],
    ['mobilization', x=>x.saveMobil('medical',{}, {},'tester'), 'mobil'],
    ['action', x=>x.addAction('fixture','medical','tester'), 'action'],
    ['action deletion', x=>x.deleteAction('fixture'), 'action']
  ]) {
    await test(label+' survives disconnect with a bound durable record', async()=>{
      const x=harness({online:false});
      assert(await save(x), 'not accepted into durable storage');
      const entries=Object.values(JSON.parse(x.raw()).ops);
      assert(entries.length===1 && entries[0].securityContext.uid==='fixture-uid','missing bound operation');
      assert(x.statuses[status].queued===true, 'queued state not shown');
      assert(x.writes.length===0, 'sent while offline');
    });
    await test(label+' preserves input when storage fails', async()=>{
      const x=harness({quota:true});
      assert(await save(x)===false,'incorrect success');
      assert(x.writes.length===0,'sent before durable storage');
    });
  }
  await test('an earlier failed save blocks newer writes to the same record',async()=>{
    const x=harness();
    const operation={kind:'incident',method:'set',path:'mci2/incidents/test/incident',payload:{title:'older'}};
    const id=await x.outboxEnqueue(operation);
    const queue=JSON.parse(x.raw());queue.ops[id].status='failed';
    const y=harness({raw:JSON.stringify(queue)});
    assert(await y.saveIncident({title:'newer'}), 'newer edit was not retained');
    assert(y.writes.length===0,'newer edit overtook failed edit');
    await y.replayOutbox({manual:true});
    equal(y.writes.map(w=>w.value.title),['older','newer'],'retry order reversed');
  });
  await test('manual replay never bypasses a conflict decision',async()=>{
    const x=harness();const id=await x.outboxEnqueue({kind:'casualty',method:'update',path:'mci2/incidents/test/casualties/one',expected:{notes:'before'},payload:{notes:'mine'}});
    const queue=JSON.parse(x.raw());queue.ops[id].status='failed';queue.ops[id].errorCode='write_conflict';queue.ops[id].conflictCurrent={notes:'colleague'};
    const y=harness({raw:JSON.stringify(queue)});await y.replayOutbox({manual:true});assert(y.writes.length===0,'conflict was silently resent');
    equal(JSON.parse(y.raw()).ops[id].payload,{notes:'mine'},'input lost');
    equal(JSON.parse(y.raw()).ops[id].expected,{notes:'before'},'baseline lost');
  });
  await test('edited card persists original server values for changed fields',async()=>{
    const x=harness({online:false});
    const baseline={cardNo:1,name:'TEST',triage:'urgent',hospital:'',notes:'before'};
    await x.saveMciCasualty({...baseline,notes:'mine'},'medical','tester','existing',baseline,{...baseline,notes:'before'});
    const operation=Object.values(JSON.parse(x.raw()).ops)[0];
    equal(operation.expected,{notes:'before'},'raw baseline missing');
    equal(operation.payload.notes,'mine','input missing');
  });
  const card = () => ({ cardNo: 1, name: 'TEST', triage: 'urgent', hospital: '', notes: '' });
  await test('MCI save rejects quota failure before any network write', async () => {
    const x = harness({ quota: true });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester') === false, 'save incorrectly succeeded');
    assert(x.writes.length === 0, 'network write started without durable storage');
    assert(x.statuses.mciCasualty.error, 'no visible save error');
    assert(!x.statuses.mciCasualty.savedAt, 'displayed saved status');
  });
  await test('General casualty save rejects quota failure', async () => {
    const x = harness({ quota: true });
    assert(await x.saveCasualty(card(), 'medical', 'tester') === false, 'save incorrectly succeeded');
    assert(x.statuses.casualty.error, 'general save error missing');
  });
  await test('Offline quota failure does not claim queued data', async () => {
    const x = harness({ quota: true, online: false });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester') === false, 'lost input reported as queued');
    assert(x.writes.length === 0, 'unpersisted write sent');
  });
  await test('Corrupt outbox remains intact after attempted save', async () => {
    const raw = '{"v":1,"ops":BROKEN';
    const x = harness({ raw });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester') === false, 'corrupt queue accepted');
    equal(x.raw(), raw, 'corrupt queue overwritten');
    assert(x.writes.length === 0, 'write started after corrupt read');
  });
  await test('Malformed outbox structure cannot be replaced', async () => {
    const raw = JSON.stringify({ v: 1, seq: 1, ops: [] });
    const x = harness({ raw });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester') === false, 'malformed queue accepted');
    equal(x.raw(), raw, 'original malformed queue overwritten');
  });
  await test('Unavailable browser storage fails visibly', async () => {
    const x = harness({ readError: true });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester') === false, 'unreadable storage accepted');
    assert(x.statuses.mciCasualty.error, 'read failure not shown');
  });
  await test('Cleanup and replay preserve a corrupt queue', async () => {
    const raw = '{"broken"';
    const x = harness({ raw });
    await x.outboxCleanup();
    await x.replayOutbox({ manual: true });
    equal(x.raw(), raw, 'maintenance overwrote corrupt data');
    assert(x.writes.length === 0, 'maintenance sent corrupt data');
  });
  await test('Storage failure prevents both delete routes', async () => {
    for (const method of ['deleteCasualty', 'deleteMciCasualty']) {
      const x = harness({ quota: true });
      assert(await x[method]('existing') === false, method + ' reported success');
      assert(x.writes.length === 0, method + ' sent an unpersisted deletion');
    }
  });
  await test('Offline card is persisted before returning queued success', async () => {
    const x = harness({ online: false });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester'), 'offline save failed');
    const entries = Object.values(JSON.parse(x.raw()).ops);
    assert(entries.length === 1 && entries[0].payload.name === 'TEST', 'offline data missing');
    assert(x.statuses.mciCasualty.queued, 'queued status missing');
    const restarted = harness({ raw: x.raw() });
    // Simulate a subsequent boot after the interrupted send expires.
    const data = JSON.parse(restarted.raw());
    Object.values(data.ops).forEach(op => { op.updatedAt = Date.now() - 20000; });
    const boot = harness({ raw: JSON.stringify(data) });
    await boot.outboxCleanup();
    await boot.replayOutbox();
    assert(boot.writes.length === 1, 'persisted record not replayed');
    equal(boot.writes[0].path, entries[0].path, 'replay created a different card');
  });
  await test('Online card is acknowledged only after successful write', async () => {
    const x = harness();
    assert(await x.saveMciCasualty(card(), 'medical', 'tester'), 'online save failed');
    assert(!x.statuses.mciCasualty.queued, 'successful write marked queued');
    assert(Object.values(JSON.parse(x.raw()).ops)[0].status === 'sent', 'acknowledgment missing');
  });
  await test('Space recovery removes sent entries and retains pending entries', async () => {
    const pending = { opId: 'keep', seq: 1, status: 'pending', payload: { name: 'PENDING' } };
    const raw = JSON.stringify({ v: 1, seq: 3, ops: {
      keep: pending, done: { opId: 'done', seq: 2, status: 'sent' }
    } });
    const x = harness({ raw, evictSent: true, online: false });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester'), 'recovery save failed');
    const ops = JSON.parse(x.raw()).ops;
    equal(ops.keep, pending, 'pending record modified/removed');
    assert(!ops.done && Object.keys(ops).length === 2, 'wrong records evicted');
  });
  await test('Editing sends changed fields without clearing another operators hospital', async () => {
    const x = harness();
    const base = card();
    await x.saveMciCasualty({ ...base, notes: 'updated' }, 'resource', 'editor', 'existing', base);
    const patch = x.writes[0].value;
    assert(patch.notes === 'updated', 'changed field absent');
    assert(!('hospital' in patch) && !('triage' in patch), 'untouched fields sent');
    const server = { ...base, hospital: 'OTHER-HOSPITAL', author: 'creator', ...patch };
    assert(server.hospital === 'OTHER-HOSPITAL' && server.author === 'creator', 'concurrent value or author lost');
    assert(patch._updatedBy === 'editor', 'editor metadata missing');
  });
  await test('Explicitly clearing a field is retained in the patch', async () => {
    const x = harness();
    const base = { ...card(), notes: 'old' };
    await x.saveMciCasualty({ ...base, notes: '' }, 'medical', 'tester', 'existing', base);
    assert(x.writes[0].value.notes === '', 'explicit clear discarded');
  });
  await test('Editing an auto-named card does not rename its original author', async () => {
    const x = harness();
    const base = { ...card(), name: '#001 -creator' };
    await x.saveMciCasualty({ ...base, notes: 'updated' }, 'resource', 'editor', 'existing', base);
    assert(!('name' in x.writes[0].value), 'auto-name replaced while editing notes');
  });
  await test('Both edit entry points retain photos, zero vitals, and independent baselines', () => {
    const list = between("  // 수정 진입\n  document.querySelectorAll('.mci-edit-btn')", '  // 삭제\n');
    const modal = between('function bindMciCardDetailModalEvents()', '// ==================== 외부(야외)');
    for (const section of [list, modal]) {
      const start = section.indexOf('const editDraft = {');
      assert(start >= 0, 'edit draft not found');
      const end = section.indexOf('\n      };', start);
      const draftSource = section.slice(start, end + '\n      };'.length);
      const create = new Function('c', 'btn', 'mechList', draftSource + '; return editDraft;');
      const draft = create({ _key: 'existing', cardNo: 1, cardPhoto: 'CARD', patientPhoto: 'PATIENT',
        rr: 0, pulse: 0, bpSys: 0, bpDia: 0, spo2: 0, temp: 0 },
        { dataset: { mciEdit: 'existing' } }, () => []);
      assert(draft.cardPhoto === 'CARD' && draft.patientPhoto === 'PATIENT', 'photos lost');
      assert(draft.rr === 0 && draft.spo2 === 0, 'zero vital values lost');
      assert(section.includes('JSON.parse(JSON.stringify(cardDraftPayload(editDraft)))'), 'baseline is mutable');
    }
    assert(list.includes("if (state.mode === 'general') csDraft = editDraft; else mciDraft = editDraft;"), 'general mode edits MCI draft');
  });
  await test('Secured build always uses test namespace', () => {
    const config = between('const PRODUCTION_HOSTS =', '// ==================== 표출 팝아웃');
    const root = new Function('location', config + '; return DB_ROOT;');
    equal(root({ hostname: 'mci.visanu81.workers.dev' }), 'mci2', 'secure build reached production namespace');
    for (const hostname of ['mci2.visanu81.workers.dev', 'localhost', 'preview.example', 'mci.visanu81.workers.dev.evil.example']) {
      equal(root({ hostname }), 'mci2', 'non-production host reached production data');
    }
  });
  await test('Secure build isolates its queue from both legacy deployments', async () => {
    for (const [dbRoot, key] of [['', 'mci2_secure_outbox_v1'], ['mci2', 'mci2_secure_outbox_v1']]) {
      const x = harness({ dbRoot });
      assert(await x.saveMciCasualty(card(), 'medical', 'tester'), 'save failed');
      assert(x.storageKeys.length > 0 && x.storageKeys.every(value => value === key), 'legacy outbox key changed');
    }
  });
  await test('Form restoration displays numeric zero without clearing it', () => {
    const assignment = html.match(/el\.value = _draft\[k\][^;]+;/)?.[0];
    assert(assignment, 'form restoration missing');
    const restore = new Function('el', '_draft', 'k', assignment);
    const el = {};
    restore(el, { rr: 0 }, 'rr'); equal(el.value, 0, 'zero cleared in form');
    restore(el, {}, 'rr'); equal(el.value, '', 'missing value not blank');
  });
  await test('Every inline application script parses', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert(scripts.length > 0, 'no scripts found');
    for (const [, attrs, body] of scripts) {
      if (attrs.includes('src=') || attrs.includes('application/ld+json')) continue;
      const source = body.replace(/import\s+[\s\S]*?\s+from\s+["'][^"']+["'];/g, '');
      new Function(source);
    }
  });
  return results;
}
