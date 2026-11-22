import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeskSeatCreateInput } from '../plugin/shared/delegation.ts';
import { createDeskOperations } from '../plugin/server/desk-operation.ts';
import { createFormationPlanner } from '../plugin/server/desk-formation.ts';
import { createFormationPlacement } from '../plugin/server/desk-placement.ts';
import { placementFixture,fixtureGit,committedRepository } from './helpers/formation-placement-fixture.mjs';
import { createTaskGitIo } from '../plugin/server/desk-task-execution-host.ts';

test('placement schema preserves absent/default and strict caller/existing/worktree-gap inputs',()=>{
 const base={requestId:'r',role:'peer',taskLabel:'x',assignment:'read',grantRef:'human'};
 assert.deepEqual(DeskSeatCreateInput.parse(base),base);
 for(const placement of [{kind:'caller'},{kind:'existing',workspaceId:'target',reason:'lane'},
  {kind:'existing',cwd:'/lane',reason:'lane'},{kind:'worktree',reason:'lane',baseRef:'HEAD'}]){
  assert.deepEqual(DeskSeatCreateInput.parse({...base,placement}),{...base,placement});
  assert.deepEqual(DeskSeatCreateInput.parse({...base,role:'lead',placement}),{...base,role:'lead',placement});
 }
 for(const placement of [{kind:'existing',reason:'lane'},{kind:'existing',cwd:'relative',reason:'lane'},
  {kind:'caller',workspaceId:'override'},{kind:'existing',workspaceId:'target'},{kind:'existing',workspaceId:'target',reason:'lane',catalogFile:'/foreign'}]){
  assert.equal(DeskSeatCreateInput.safeParse({...base,placement}).success,false);
 }
});

for(const kind of ['caller','existing-id','existing-cwd','worktree-gap']){
 for(const topology of ['same-repo','foreign','nested','uncertainty']){
  test('placement matrix '+kind+' × '+topology,async t=>{
   const f=placementFixture(t,{budgets:{readMs:30,effectMs:30}});
   const cwd=topology==='foreign'?f.foreign:topology==='nested'?f.nested:kind==='caller'?f.repository:f.target;
   const placement=kind==='caller'?{kind:'caller'}:kind==='existing-id'?{kind:'existing',workspaceId:'target',reason:'isolated lane'}:
    kind==='existing-cwd'?{kind:'existing',cwd,reason:'isolated lane'}:{kind:'worktree',reason:'isolated lane'};
   if(kind==='caller'||kind==='existing-id')f.workspaces.get(kind==='caller'?'caller':'target').workspaceDirectory=cwd;
   if(topology==='uncertainty'){
    if(kind==='existing-cwd')f.setOpenFault(()=>new Promise(()=>{}));
    else f.setRefreshFault(()=>new Promise(()=>{}));
   }
   const input=DeskSeatCreateInput.parse({...f.input,placement}),out=await f.run(input);
   if(kind==='worktree-gap'){
    assert.equal(out.result.code,'CAPABILITY_GAP');assert.equal(out.phases.length,0);
    assert.equal(f.hostCalls.length,0);assert.equal(f.calls.logical,0);
   }else if(topology==='same-repo'){
    assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out));
    assert.equal(out.result.workspaceId,kind==='caller'?'caller':kind==='existing-cwd'?'opened':'target');
    assert.equal(out.result.parent,'parent');assert.equal(f.snapshots.get('child').cwd,cwd);
    assert.equal(out.phases.length,kind==='existing-cwd'?11:9);
    assert.ok(out.result.delivery.prompt.includes('Repository: '+cwd));
    assert.ok(out.result.delivery.prompt.includes('Routing/protocol repository: '+f.repository));
    assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,1);
   }else if(topology==='uncertainty'){
    assert.equal(out.result.state,'placement-uncertain');assert.equal(out.result.sent,false);
    assert.equal(out.result.workspaceId,kind==='existing-cwd'?null:kind==='caller'?'caller':'target');
    assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,0);
   }else{
    assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out));
    assert.equal(f.hostCalls.filter(c=>c.kind==='create'||c.kind==='open').length,0);
    assert.equal(f.calls.logical,0);
   }
   const calls=f.hostCalls.length,decisions=f.calls.logical,replay=await f.run(input);
   assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);assert.equal(f.calls.logical,decisions);
   assert.equal(f.hostCalls.some(c=>c.kind==='forbidden-workspace-create'),false);
  });
 }
}

for(const delivery of ['caller','server'])test('armed cwd-open '+delivery+' uses worst-case twelve phases without re-deciding',async t=>{
 const f=placementFixture(t,{mode:'armed',count:2});f.setChoice('second');
 const input={...f.input,delivery,placement:{kind:'existing',cwd:f.target,reason:'isolated lane'}};
 const out=await f.run(input);assert.equal(out.phases.length,12);assert.equal(f.calls.logical,1);
 assert.deepEqual(out.phases.map(p=>p.name),['placement-planned','workspace-open-issued','workspace-open-returned','target-observed',
  'route-issued','route-selected','prepared','create-issued','create-returned','create-observed','membership-observed',
  delivery==='caller'?'delivery-handed-off':'send-issued']);
 assert.equal(out.result.state,delivery==='caller'?'awaiting-caller-delivery':'host-accepted');
 assert.equal(f.hostCalls.filter(c=>c.kind==='send').length,delivery==='server'?1:0);
 const calls=f.hostCalls.length;const replay=await f.run(input);assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);
});

test('existing ID and cwd must agree; missing/archiving descriptor never falls back to open',async t=>{
 for(const fault of ['cwd','missing','archiving','foreign']){
  const f=placementFixture(t);if(fault==='missing')f.workspaces.delete('target');
  if(fault==='archiving')f.workspaces.get('target').archivingAt='2026-01-01T00:00:00Z';
  if(fault==='foreign')f.workspaces.get('target').workspaceDirectory=f.foreign;
  const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',cwd:fault==='cwd'?f.repository:f.target,reason:'lane'}});
  assert.equal(out.result.ok,false);assert.equal(f.hostCalls.some(c=>c.kind==='open'||c.kind==='create'),false);
 }
});

test('source pool and protocol win over missing target config; CLI JSON cannot supply trusted context',async t=>{
 const f=placementFixture(t);delete f.options[0].modeId;f.savePool();
 writeFileSync(join(f.repository,'.paseo-slp/workspace-protocol.md'),'---\nagent_mode: full-access\n---\nFixture protocol.\n');
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.state,'awaiting-caller-delivery');assert.equal(out.result.runtime.modeId,'full-access');
 const selected=out.phases.find(p=>p.name==='route-selected').value;
 assert.equal(selected.source.repository,f.repository);assert.equal(selected.source.catalogFile,f.poolPath);
 assert.equal(f.hostCalls.filter(c=>c.kind==='providers').every(c=>c.cwd===f.target),true);
 const module=await import(pathToFileURL(join(f.candidate,'plugin/server/runtime/cli/launch.ts')).href);
 const request={repository:f.target,workspaceId:'target',role:'peer',assignment:'read',providers:f.providers,
  route:selected.route,paseoHome:f.home,trustedContext:{routingRepository:f.repository,protocolRepository:f.repository}};
 assert.throws(()=>module.launchPlan(f.candidate,request));
 assert.throws(()=>module.launchPlan(f.candidate,{...request,route:{...selected.route,catalogFile:f.poolPath}}));
});

for(const config of ['slp-routing.json','workspace-protocol.md'])test('conflicting target '+config+' blocks before native allocation',async t=>{
 const f=placementFixture(t);mkdirSync(join(f.target,'.paseo-slp'),{recursive:true});writeFileSync(join(f.target,'.paseo-slp',config),'conflicting target');
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.code,'ROUTE_DRIFT');assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
});

for(const registration of ['missing','unregistered','revoked'])test('registration '+registration+' retains known child without runnable delivery',async t=>{
 const f=placementFixture(t,{registration});const input={...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'},delivery:'server'};
 const out=await f.run(input);assert.equal(out.result.state,'seat-pending');assert.equal(out.result.agentId,'child');assert.equal(out.result.sent,false);
 assert.equal(Object.hasOwn(out.result,'delivery'),false);assert.ok(out.result.assignmentEvidence.prompt);assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
 assert.equal(out.phases.at(-1).name,'membership-observed');assert.equal(out.phases.at(-1).value.registered,false);
 f.setRegistration('ready');const calls=f.hostCalls.length,replay=await f.run(input);
 assert.equal(replay.result.state,'seat-pending');assert.equal(f.hostCalls.length,calls);
});

for(const field of ['role','provider','createCwd','workspaceId'])test('membership exact '+field+' is required before delivery',async t=>{
 const f=placementFixture(t);f.setAfterCreate(()=>{f.members[0][field]='wrong';});
 const out=await f.run({...f.input,placement:{kind:'caller'},delivery:'server'});
 assert.equal(out.result.state,'seat-pending');assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
});

test('legacy omitted full pin bypasses membership even when registration is delayed',async t=>{
 const f=placementFixture(t,{registration:'missing'}),input={...f.input,runtime:{optionId:'first',catalogSha256:f.sha()}};
 const out=await f.run(input);assert.equal(out.result.state,'awaiting-caller-delivery');assert.equal(out.result.agentId,'child');
 assert.deepEqual(out.phases.map(p=>p.name),['prepared','create-issued','create-returned','create-observed','delivery-handed-off']);
 assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
});

test('omitted legacy full pin keeps bytes/five phases; explicit caller is a distinct immutable body',async t=>{
 const f=placementFixture(t),input={...f.input,runtime:{optionId:'first',catalogSha256:f.sha()}};
 const out=await f.run(input);assert.equal(out.phases.length,5);
 const dir=join(f.home,'slp-runtime/state/operations',readdirSync(join(f.home,'slp-runtime/state/operations'))[0]);
 const before=Object.fromEntries(readdirSync(dir).map(n=>[n,readFileSync(join(dir,n),'utf8')]));
 const calls=f.hostCalls.length,replay=await f.run(input);assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);
 assert.deepEqual(Object.fromEntries(readdirSync(dir).map(n=>[n,readFileSync(join(dir,n),'utf8')])),before);
 assert.equal((await f.run({...input,placement:{kind:'caller'}})).code,'IDEMPOTENCY_CONFLICT');
});

for(const last of ['workspace-open-issued','target-observed'])test('partial '+last+' never resumes or opens/creates again',async t=>{
 const f=placementFixture(t),input={...f.input,placement:{kind:'existing',cwd:f.target,reason:'lane'}};
 const identity={repoKey:'repo',membershipId:f.row.membershipId,agentId:'parent',kind:'seat-create',requestId:input.requestId};
 await createDeskOperations(f.deps.stableRoot).run(identity,input,async phase=>{phase(last,{retained:true});throw new Error('crash');});
 const out=await f.run(input);assert.equal(out.state,'partial');assert.equal(out.phases.length,1);assert.equal(f.hostCalls.length,0);assert.equal(f.calls.logical,0);
});

test('target HEAD drift after child creation retains ID and withholds delivery',async t=>{
 const f=placementFixture(t);f.setAfterCreate(()=>fixtureGit(f.target,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
  'commit','--allow-empty','-qm','target drift'));
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.code,'ROUTE_DRIFT');assert.equal(out.result.agentId,'child');assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,1);
 assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);assert.equal(Object.hasOwn(out.result,'delivery'),false);
});

// Exercise the public formation interface: a successful first qualification
// is not a lease across the actor guard awaited before the native effect.
for(const delivery of ['caller','server'])for(const stage of ['create','delivery'])for(const fault of ['revoked','drift']){
 test('qualification '+delivery+' '+stage+' fences '+fault+' between final workspace observations',async t=>{
  const f=placementFixture(t),plan=f.deps.plan,verify=f.placement.verify;
  const boundaryPlan=stage==='create'?2:3;
  let plans=0,observations=0,revoked=false;
  f.deps.plan=async(...args)=>{const out=await plan(...args);plans++;return out;};
  f.placement.verify=async(...args)=>{
   await verify(...args);
   if(plans===boundaryPlan && ++observations===1){
    if(fault==='revoked')revoked=true;
    else fixtureGit(f.target,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
     'commit','--allow-empty','-qm','drift across awaited guard');
   }
  };
  const refusal={ok:false,code:'STALE_EPOCH',message:'fixture actor revoked',recovery:'stop'};
  f.deps.guard=async()=>revoked?refusal:null;
  const input={...f.input,delivery,placement:{kind:'existing',workspaceId:'target',reason:'lane'}};
  const out=await f.run(input);
  assert.equal(out.result.code,fault==='revoked'?'STALE_EPOCH':'ROUTE_DRIFT',JSON.stringify(out));
  assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,stage==='create'?0:1);
  assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
  assert.equal(Object.hasOwn(out.result,'delivery'),false);
  assert.equal(out.phases.some(p=>p.name==='delivery-handed-off'||p.name==='send-issued'),false);
  if(stage==='delivery')assert.equal(out.result.agentId,'child');
  else assert.equal(Object.hasOwn(out.result,'agentId'),false);
  if(fault==='revoked')assert.deepEqual(out.result,stage==='create'?refusal:{...refusal,agentId:'child'});
  const calls=f.hostCalls.length,replay=await f.run(input);
  assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);
 });
}

test('Lead existing workspace uses its saved profile and exact live role registration',async t=>{
 const f=placementFixture(t,{role:'lead'});const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.state,'awaiting-caller-delivery');assert.equal(out.result.runtime.provider,'slp-codex-lead/model/variant');
 assert.equal(out.result.workspaceId,'target');assert.equal(out.phases.length,8);assert.equal(f.calls.logical,0);
});

for(const topology of ['foreign','nested'])test('omitted caller placement still rejects '+topology+' repository before child create',async t=>{
 const f=placementFixture(t);f.workspaces.get('caller').workspaceDirectory=f[topology];
 const out=await f.run({...f.input,runtime:{optionId:'first',catalogSha256:f.sha()}});
 assert.equal(out.result.code,'CAPABILITY_GAP');assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
 assert.match(out.result.message,/different Git repository/);
});

test('worktree gap wins over corrupt Jev and multiple-option discovery before every host effect',async t=>{
 const f=placementFixture(t,{mode:'error',count:2});
 const out=await f.run({...f.input,placement:{kind:'worktree',reason:'lane'}});
 assert.equal(out.result.code,'CAPABILITY_GAP');assert.equal(out.phases.length,0);assert.equal(f.hostCalls.length,0);assert.equal(f.calls.logical,0);
});

test('open returned ID remains retained when descriptor refresh later becomes uncertain',async t=>{
 const f=placementFixture(t,{budgets:{readMs:10,effectMs:10}});f.setRefreshFault(()=>new Promise(()=>{}));
 const out=await f.run({...f.input,placement:{kind:'existing',cwd:f.target,reason:'lane'}});
 assert.equal(out.result.state,'placement-uncertain');assert.equal(out.result.workspaceId,'opened');assert.equal(out.result.sent,false);
 assert.equal(out.phases.at(-1).name,'workspace-open-returned');assert.equal(f.hostCalls.some(c=>c.kind==='create'),false);
});

test('bound candidate lacking placement ABI refuses before open while omitted full runtime remains compatible',async t=>{
 const f=placementFixture(t),planner=createFormationPlanner({runtimePath:f.candidate,daemonHome:f.home,host:()=>f.host,
  importModule:async spec=>{const module=await import(spec);return {...module,FORMATION_CAPABILITIES:undefined};}});
 f.deps.plan=planner;f.deps.placementCapability=planner.placementCapability;
 const input={...f.input,runtime:{optionId:'first',catalogSha256:f.sha()}};
 const gap=await f.run({...input,placement:{kind:'existing',cwd:f.target,reason:'lane'}});
 assert.equal(gap.code,'CAPABILITY_GAP');assert.equal(f.hostCalls.length,0);
 const legacy=await f.run(input);assert.equal(legacy.result.state,'awaiting-caller-delivery');assert.equal(legacy.phases.length,5);
});

for(const drift of ['directory','HEAD'])test('target '+drift+' drift during provider wait blocks child allocation',async t=>{
 const f=placementFixture(t);let reads=0;
 f.setProviderHook(()=>{if(++reads===3){
  if(drift==='directory')f.workspaces.get('target').workspaceDirectory=f.repository;
  else fixtureGit(f.target,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','pre-create drift');
 }});
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.code,'ROUTE_DRIFT');assert.equal(f.hostCalls.some(c=>c.kind==='create'),false);
});

test('pinned source configuration drift across provider wait blocks armed decision before network',async t=>{
 const f=placementFixture(t,{mode:'armed',count:2});f.setChoice('second');
 f.setProviderHook(()=>{f.options[0].notes='drift';f.savePool();});
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.code,'ROUTE_DRIFT');assert.equal(f.calls.logical,0);assert.equal(f.hostCalls.some(c=>c.kind==='create'),false);
});

test('Git identity drift during the awaited open guard refuses before SDK open',async t=>{
 const f=placementFixture(t);let guards=0;
 f.deps.guard=async()=>{if(++guards===3)writeFileSync(join(f.target,'.git'),'gitdir: '+join(f.foreign,'.git')+'\n');return null;};
 const out=await f.run({...f.input,placement:{kind:'existing',cwd:f.target,reason:'lane'}});
 assert.equal(out.result.code,'CAPABILITY_GAP');assert.equal(f.hostCalls.some(c=>c.kind==='open'||c.kind==='create'),false);
});

for(const role of ['lead','peer'])for(const delivery of ['caller','server'])test('pinned source protocol instruction is role-scoped for '+role+' '+delivery,async t=>{
 const f=placementFixture(t,{role});
 writeFileSync(join(f.repository,'.paseo-slp/workspace-protocol.md'),'---\nagent_mode: full-access\n---\nSource protocol.\n');
 const assignment='Inspect the assigned module; preserve its public API.';
 const out=await f.run({...f.input,assignment,delivery,placement:{kind:'existing',workspaceId:'target',reason:'assigned lane'}});
 assert.equal(out.result.state,delivery==='caller'?'awaiting-caller-delivery':'host-accepted');
 const prompt=delivery==='caller'?out.result.delivery.prompt:f.hostCalls.find(call=>call.kind==='send').text;
 assert.equal(prompt.includes('Use '+f.repository+'/.paseo-slp/workspace-protocol.md'),role==='lead');
 assert.ok(prompt.includes(assignment));
});

for(const placement of [undefined,{kind:'caller'}])test('hop2 placed Lead inherits main-checkout source for '+(placement?.kind??'omitted'),async t=>{
 const f=placementFixture(t);
 writeFileSync(join(f.repository,'.paseo-slp/workspace-protocol.md'),'---\nagent_mode: full-access\n---\nSource protocol.\n');
 // A conflicting user pool proves hop2 did not silently bind to it.
 writeFileSync(join(f.home,'slp-runtime/state/peer-pool.json'),JSON.stringify({...f.catalog,options:[{...f.options[0],id:'user-only'}]}));
 const lead=await f.run({...f.input,role:'lead',requestId:'first-hop',placement:{kind:'existing',workspaceId:'target',reason:'Lead lane'}});
 assert.equal(lead.result.state,'awaiting-caller-delivery');
 assert.ok(lead.result.delivery.prompt.includes('Use '+f.repository+'/.paseo-slp/workspace-protocol.md'));
 f.row.agentId=lead.result.agentId;f.row.createCwd=f.target;f.row.workspaceId='target';
 const input={...f.input,requestId:'second-hop',...(placement?{placement}:{})};
 const out=await f.run(input);assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out));
 const chosen=out.phases.find(p=>p.name==='route-selected').value;
 assert.equal(chosen.source.repository,f.repository);assert.equal(chosen.source.scope,'repository');
 assert.equal(chosen.route.optionId,'first');assert.equal(out.result.parent,'child');assert.equal(out.result.agentId,'grandchild');
 assert.equal(out.result.delivery.prompt.includes('Use '+f.repository+'/.paseo-slp/workspace-protocol.md'),false);
 const calls=f.hostCalls.length;await f.run(input);assert.equal(f.hostCalls.length,calls);
});

test('hop2 full pin uses main source without new phase or membership gate',async t=>{
 const f=placementFixture(t,{registration:'missing'});f.row.createCwd=f.target;f.row.workspaceId='target';
 const out=await f.run({...f.input,runtime:{optionId:'first',catalogSha256:f.sha()}});
 assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out));assert.equal(out.phases.length,5);
});

for(const placement of [undefined,{kind:'caller'}])test('linked checkout without a trustworthy configuration source fails closed '+(placement?.kind??'omitted'),async t=>{
 const f=placementFixture(t);f.row.createCwd=f.target;f.row.workspaceId='target';
 writeFileSync(join(f.home,'slp-runtime/state/peer-pool.json'),JSON.stringify(f.catalog));
 rmSync(join(f.repository,'.paseo-slp'),{recursive:true,force:true});
 const out=await f.run({...f.input,...(placement?{placement}:{})});
 assert.equal(out.code??out.result?.code,'CAPABILITY_GAP',JSON.stringify(out));
 assert.match(out.message??out.result.message,/configuration source/i);assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
});

test('hop2 source pins revalidate before armed network and before delivery',async t=>{
 for(const at of ['decision','delivery']){
  const f=placementFixture(t,{mode:'armed',count:2});f.row.createCwd=f.target;f.row.workspaceId='target';f.setChoice('second');
  const drift=()=>{f.options[0].notes='main drift';f.savePool();};
  if(at==='decision')f.setProviderHook(drift);else f.setAfterCreate(drift);
  const out=await f.run(f.input);assert.equal(out.result.code,'ROUTE_DRIFT',JSON.stringify(out));
  assert.equal(f.calls.logical,at==='decision'?0:1);assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
  assert.equal(Object.hasOwn(out.result,'delivery'),false);
 }
});

test('membership waits read-only for delayed registration then delivers once in phase budget',async t=>{
 const f=placementFixture(t,{registration:'missing'});f.deps.membershipWaitMs=200;
 const saved=f.deps.readMemberships;let reads=0;
 f.deps.readMemberships=()=>{if(++reads===2)f.members.push({...f.row,membershipId:'delayed',agentId:'child',role:'peer',provider:'slp-codex-peer',createCwd:f.target,workspaceId:'target'});return saved();};
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'},delivery:'server'});
 assert.equal(out.result.state,'host-accepted',JSON.stringify(out));assert.ok(reads>=2);assert.equal(out.phases.length,9);
 assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,1);assert.equal(f.hostCalls.filter(c=>c.kind==='send').length,1);
});

test('automatic omitted request waits for registration; pending gives same-request receipt action',async t=>{
 const f=placementFixture(t,{registration:'missing'});let reads=0;f.deps.readMemberships=()=>{reads++;return [];};
 const input={...f.input,delivery:'server'};const out=await f.run(input);
 assert.equal(out.result.state,'seat-pending');assert.ok(reads>=2);assert.equal(out.phases.length,5);
 assert.deepEqual(out.result.nextAction,{tool:'slp_operation_get',arguments:{kind:'seat-create',requestId:input.requestId}});
 assert.match(out.result.readiness,/do not recreate/);const before=reads,calls=f.hostCalls.length;
 const receipt=createDeskOperations(f.deps.stableRoot).get({repoKey:'repo',membershipId:f.row.membershipId,agentId:f.row.agentId,kind:'seat-create',requestId:input.requestId});
 assert.equal(receipt.result.state,'seat-pending');await f.run(input);assert.equal(reads,before);assert.equal(f.hostCalls.length,calls);
});

test('legacy Lead omitted placement never waits or reads membership',async t=>{
 const f=placementFixture(t,{role:'lead',registration:'missing'});
 f.deps.readMemberships=()=>{throw new Error('legacy must not read memberships');};
 const out=await f.run(f.input);assert.equal(out.result.state,'awaiting-caller-delivery');assert.equal(out.phases.length,5);
});

test('no protocol pin means no instruction to read a nonexistent source protocol',async t=>{
 const f=placementFixture(t);const out=await f.run({...f.input,placement:{kind:'caller'}});
 assert.equal(out.result.state,'awaiting-caller-delivery');assert.ok(out.result.delivery.prompt.includes('Routing/protocol repository: '+f.repository));
 assert.equal(out.result.delivery.prompt.includes('Use '+f.repository+'/.paseo-slp/workspace-protocol.md'),false);
});


test('hop2 keeps a configured linked top rather than inheriting main configuration',async t=>{
 const f=placementFixture(t);mkdirSync(join(f.target,'.paseo-slp'),{recursive:true});
 writeFileSync(join(f.target,'.paseo-slp/slp-routing.json'),JSON.stringify({...f.catalog,options:[{...f.options[0],id:'local-only'}]}));
 f.row.createCwd=f.target;f.row.workspaceId='target';const out=await f.run(f.input);
 assert.equal(out.result.state,'awaiting-caller-delivery');const selected=out.phases.find(p=>p.name==='route-selected').value;
 assert.equal(selected.source.repository,f.target);assert.equal(selected.route.optionId,'local-only');
});

test('membership event arriving during a real wait delivers within the fixed twelve-phase budget',async t=>{
 const f=placementFixture(t,{mode:'armed',count:2,registration:'missing'});f.setChoice('second');f.deps.membershipWaitMs=300;
 let timer;f.setAfterCreate(()=>{timer=setTimeout(()=>f.members.push({...f.row,membershipId:'event-member',agentId:'child',role:'peer',provider:'slp-codex-peer',createCwd:f.target,workspaceId:'opened'}),40);});
 t.after(()=>clearTimeout(timer));const out=await f.run({...f.input,placement:{kind:'existing',cwd:f.target,reason:'lane'},delivery:'server'});
 assert.equal(out.result.state,'host-accepted',JSON.stringify(out));assert.equal(out.phases.length,12);
 assert.equal(f.hostCalls.filter(c=>c.kind==='send').length,1);
});

test('membership wait rechecks actor and target after delayed registration',async t=>{
 for(const drift of ['actor','HEAD']){
  const f=placementFixture(t,{registration:'missing'});f.deps.membershipWaitMs=200;let reads=0,changed=false;
  f.deps.readMemberships=()=>{if(++reads===2){f.members.push({...f.row,membershipId:'late',agentId:'child',role:'peer',provider:'slp-codex-peer',createCwd:f.target,workspaceId:'target'});
   changed=true;if(drift==='HEAD')fixtureGit(f.target,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','registration drift');}return f.members;};
  f.deps.guard=async()=>changed&&drift==='actor'?{ok:false,code:'AUTHORITY_REQUIRED',message:'parent revoked'}:null;
  const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'},delivery:'server'});
  assert.equal(out.result.code,drift==='actor'?'AUTHORITY_REQUIRED':'ROUTE_DRIFT',JSON.stringify(out));assert.equal(out.result.agentId,'child');
  assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
 }
});

const crossPlacement=(f,by)=>by==='id'?{kind:'existing',workspaceId:'foreign',reason:'other repository'}
 :by==='cwd'?{kind:'existing',cwd:f.foreign,reason:'other repository'}:{kind:'existing',workspaceId:'foreign',cwd:f.foreign,reason:'other repository'};
for(const by of ['id','cwd','id+cwd'])test('Supervisor forms a Lead in another repository by '+by+' with target desk membership and target pins',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 mkdirSync(join(f.foreign,'.paseo-slp'),{recursive:true});
 writeFileSync(join(f.foreign,'.paseo-slp/workspace-protocol.md'),'---\nagent_mode: full-access\n---\nForeign protocol.\n');
 const out=await f.run({...f.input,placement:crossPlacement(f,by)});
 assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out.result));
 assert.equal(out.result.workspaceId,by==='cwd'?'opened':'foreign');assert.equal(out.result.parent,'parent');
 assert.equal(f.snapshots.get('child').cwd,f.foreign);
 const observed=out.phases.find(p=>p.name==='target-observed').value;
 assert.equal(observed.cwd,f.foreign);assert.equal(observed.gitCommonDir,f.foreignCommonDir);
 assert.deepEqual({repository:observed.source.repository,gitCommonDir:observed.source.gitCommonDir,head:observed.source.head},
  {repository:f.foreign,gitCommonDir:f.foreignCommonDir,head:fixtureGit(f.foreign,'rev-parse','HEAD')});
 assert.notEqual(observed.source.configuration['workspace-protocol.md'],null);
 // Registration lives in the target repository's desk, never the caller's.
 assert.equal(out.phases.find(p=>p.name==='membership-observed').value.registered,true);
 assert.equal(f.members.length,0);assert.equal(f.foreignMembers.length,1);
 const prompt=out.result.delivery.prompt;
 assert.ok(prompt.includes('Repository: '+f.foreign));assert.ok(prompt.includes('Routing/protocol repository: '+f.foreign));
 assert.ok(prompt.includes('Use '+f.foreign+'/.paseo-slp/workspace-protocol.md'));
 assert.equal(prompt.includes(f.repository+'/.paseo-slp'),false);
 const calls=f.hostCalls.length,replay=await f.run({...f.input,placement:crossPlacement(f,by)});
 assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);
});

test('Supervisor cross-repository Lead stays pending while only the caller desk registers it',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 f.deps.readMemberships=gitCommonDir=>gitCommonDir===f.foreignCommonDir?[]:f.members.concat(f.foreignMembers);
 const out=await f.run({...f.input,placement:crossPlacement(f,'id')});
 assert.equal(out.result.state,'seat-pending',JSON.stringify(out.result));assert.equal(out.result.sent,false);
 assert.equal(Object.hasOwn(out.result,'delivery'),false);
});

for(const [callerRole,role] of [['lead','lead'],['supervisor','peer'],['lead','peer']])for(const by of ['id','id+cwd'])
 test('cross-repository '+callerRole+' → '+role+' by '+by+' stays rejected before native allocation',async t=>{
  const f=placementFixture(t,{role,callerRole});
  const out=await f.run({...f.input,placement:crossPlacement(f,by)});
  assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out.result));assert.match(out.result.message,/different Git repository/);
  assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
  assert.equal(f.members.length+f.foreignMembers.length,0);
 });

for(const placement of [undefined,{kind:'caller'}])test('Supervisor Lead with '+(placement?.kind??'omitted')+' placement still rejects a foreign caller workspace',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});f.workspaces.get('caller').workspaceDirectory=f.foreign;
 const out=await f.run({...f.input,...(placement?{placement}:{})});
 assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out.result));assert.match(out.result.message,/different Git repository/);
 assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
});

for(const by of ['id','cwd'])test('Supervisor Lead into a nested Git repository by '+by+' stays rejected',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 f.workspaces.set('nested',{id:'nested',workspaceDirectory:f.nested,status:'done',archivingAt:null});
 const placement=by==='id'?{kind:'existing',workspaceId:'nested',reason:'nested'}:{kind:'existing',cwd:f.nested,reason:'nested'};
 const out=await f.run({...f.input,placement});
 assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out.result));
 assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
});

for(const by of ['id','cwd'])test('Supervisor Lead in the same repository keeps the caller-repository pin and phases by '+by,async t=>{
 const outs=[];
 for(const callerRole of ['lead','supervisor']){
  const f=placementFixture(t,{role:'lead',callerRole});
  const placement=by==='id'?{kind:'existing',workspaceId:'target',reason:'lane'}:{kind:'existing',cwd:f.target,reason:'lane'};
  const out=await f.run({...f.input,placement});
  assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out.result));
  const observed=out.phases.find(p=>p.name==='target-observed').value;
  assert.equal(observed.gitCommonDir,f.commonDir);assert.equal(observed.source.repository,f.repository);
  assert.equal(f.members.length,1);assert.equal(f.foreignMembers.length,0);
  outs.push(out.phases.map(p=>p.name));
 }
 assert.deepEqual(outs[1],outs[0]);
});

// Nesting compares every registered checkout of both repositories, not only
// the caller's own checkout and main directory.
const nestedLayouts={
 'target inside another linked worktree of the caller':f=>{const inner=join(f.target,'inner');committedRepository(inner);return realpathSync(inner);},
 'another worktree of the target inside the caller checkout':f=>{fixtureGit(f.foreign,'worktree','add','--detach',join(f.repository,'foreign-wt'),'HEAD');return f.foreign;},
 'target main inside the caller while placement uses its outside worktree':f=>{const main=join(f.repository,'inner-main');committedRepository(main);
  const wt=join(f.dir,'inner-wt');fixtureGit(main,'worktree','add','--detach',wt,'HEAD');return realpathSync(wt);},
 'caller checkout inside the target checkout':f=>{committedRepository(f.dir);return realpathSync(f.dir);},
};
for(const [layout,make] of Object.entries(nestedLayouts))for(const by of ['id','cwd'])test('Supervisor Lead nesting rejects '+layout+' by '+by,async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});const dir=make(f);
 f.workspaces.set('nested-lane',{id:'nested-lane',workspaceDirectory:dir,status:'done',archivingAt:null});
 const out=await f.run({...f.input,placement:by==='id'?{kind:'existing',workspaceId:'nested-lane',reason:'nested'}:{kind:'existing',cwd:dir,reason:'nested'}});
 assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out.result));assert.match(out.result.message,/nested/);
 assert.equal(out.phases.length,0);assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
});

test('Supervisor Lead cross-repository placement fails closed when worktree registration is unobservable',async t=>{
 const real=createTaskGitIo();
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor',git:{...real,worktreeList:async()=>{throw new Error('fixture worktree list failure');}}});
 const out=await f.run({...f.input,placement:crossPlacement(f,'id')});
 assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out.result));assert.match(out.result.message,/worktree/);
 assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
});

// Repository classification must not alter same-repository failure paths.
const sameRepoFailures={
 'uncertain id-only refresh':{budgets:{readMs:10,effectMs:10}},
 'missing cwd':{},
};
for(const [name,options] of Object.entries(sameRepoFailures))test('same-repository '+name+' keeps Lead-caller phases and result for a Supervisor',async t=>{
 const outs=[];
 for(const callerRole of ['lead','supervisor']){
  const f=placementFixture(t,{role:'lead',callerRole,...options});
  if(name==='uncertain id-only refresh')f.setRefreshFault(()=>new Promise(()=>{}));
  const placement=name==='missing cwd'?{kind:'existing',cwd:join(f.dir,'missing'),reason:'lane'}:{kind:'existing',workspaceId:'target',reason:'lane'};
  const out=await f.run({...f.input,placement});
  assert.equal(f.hostCalls.some(c=>c.kind==='create'),false);
  outs.push({phases:out.phases.map(p=>p.name),state:out.result.state??null,code:out.result.code??null,message:out.result.message??null});
 }
 assert.ok(outs[0].phases.includes('placement-planned'),JSON.stringify(outs[0]));
 assert.deepEqual(outs[1],outs[0]);
});

for(const second of ['caller repository','third repository'])test('cross-repository descriptor drift to the '+second+' after classification is refused',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 const third=join(f.dir,'third');committedRepository(third);let reads=0;
 f.setRefreshFault(id=>{const base=f.workspaces.get(id);reads++;
  return id==='foreign'&&reads>1?{...base,workspaceDirectory:second==='caller repository'?f.target:realpathSync(third)}:base;});
 const out=await f.run({...f.input,placement:crossPlacement(f,'id')});
 assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out.result));assert.match(out.result.message,/different Git repository/);
 assert.equal(f.hostCalls.some(c=>c.kind==='create'),false);
});

test('cross-repository linked worktree inherits the target main checkout configuration and registers in the target desk',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 mkdirSync(join(f.foreign,'.paseo-slp'),{recursive:true});
 writeFileSync(join(f.foreign,'.paseo-slp/workspace-protocol.md'),'---\nagent_mode: full-access\n---\nForeign protocol.\n');
 const wt=join(f.dir,'foreign-wt');fixtureGit(f.foreign,'worktree','add','--detach',wt,'HEAD');const dir=realpathSync(wt);
 f.workspaces.set('foreign-wt',{id:'foreign-wt',workspaceDirectory:dir,status:'done',archivingAt:null});
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'foreign-wt',reason:'other repository'}});
 assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out.result));
 const observed=out.phases.find(p=>p.name==='target-observed').value;
 assert.equal(observed.cwd,dir);assert.equal(observed.gitCommonDir,f.foreignCommonDir);
 assert.equal(observed.source.repository,f.foreign);assert.notEqual(observed.source.configuration['workspace-protocol.md'],null);
 assert.ok(out.result.delivery.prompt.includes('Use '+f.foreign+'/.paseo-slp/workspace-protocol.md'));
 assert.equal(f.members.length,0);assert.equal(f.foreignMembers.length,1);
});

test('cross-repository uncertain descriptor read is retained and replays without effects',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor',budgets:{readMs:10,effectMs:10}});
 f.setRefreshFault(()=>new Promise(()=>{}));
 const out=await f.run({...f.input,placement:crossPlacement(f,'id')});
 assert.equal(out.result.state,'placement-uncertain',JSON.stringify(out.result));assert.equal(out.result.sent,false);
 const calls=f.hostCalls.length,replay=await f.run({...f.input,placement:crossPlacement(f,'id')});
 assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);
 assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
});

test('cross-repository target configuration drift before create blocks native allocation',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 f.setProviderHook(()=>{mkdirSync(join(f.foreign,'.paseo-slp'),{recursive:true});writeFileSync(join(f.foreign,'.paseo-slp/workspace-protocol.md'),'drifted\n');});
 const out=await f.run({...f.input,placement:crossPlacement(f,'id')});
 assert.equal(out.result.code,'ROUTE_DRIFT',JSON.stringify(out.result));
 assert.equal(f.hostCalls.some(c=>c.kind==='create'),false);
});

// Registrations can change while formation awaits provider/SDK reads; nesting
// is rechecked with every pinned verification before effects and delivery.
for(const stage of ['before create','after create'])test('cross-repository nesting registered '+stage+' blocks dependent effects',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});let nested=false;
 const nest=()=>{if(nested)return;nested=true;fixtureGit(f.foreign,'worktree','add','--detach',join(f.repository,'late-foreign-wt'),'HEAD');};
 if(stage==='before create')f.setProviderHook(nest);else f.setAfterCreate(nest);
 const out=await f.run({...f.input,placement:crossPlacement(f,'id')});
 assert.ok(out.phases.some(p=>p.name==='target-observed'));assert.equal(nested,true);
 assert.equal(out.result.code,'ROUTE_DRIFT',JSON.stringify(out.result));assert.match(out.result.message,/nested/);
 assert.equal(Object.hasOwn(out.result,'delivery'),false);assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
 assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,stage==='before create'?0:1);
 if(stage==='after create'){assert.equal(out.result.agentId,'child');assert.equal(out.result.sent,false);}
 const calls=f.hostCalls.length,replay=await f.run({...f.input,placement:crossPlacement(f,'id')});
 assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);
});

function addRegisteredSubmodule(f,name='sub',opts={}){
 const upstream=join(f.dir,'upstream-'+name.replace(/\//g,'-'));
 committedRepository(upstream);
 if(opts.protocol!==false){
  mkdirSync(join(upstream,'.paseo-slp'),{recursive:true});
  writeFileSync(join(upstream,'.paseo-slp/workspace-protocol.md'),'---\nagent_mode: full-access\n---\nSubmodule protocol.\n');
  fixtureGit(upstream,'add','.paseo-slp/workspace-protocol.md');
  fixtureGit(upstream,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','submodule protocol');
 }
 fixtureGit(f.repository,'-c','protocol.file.allow=always','submodule','add','--quiet',upstream,name);
 fixtureGit(f.repository,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','register submodule '+name);
 const subDir=realpathSync(join(f.repository,name));
 const subCommonDir=realpathSync(join(f.commonDir,'modules',name));
 const subMembers=[];
 const origRead=f.deps.readMemberships;
 f.deps.readMemberships=gitCommonDir=>gitCommonDir===subCommonDir?subMembers:origRead(gitCommonDir);
 const origCreate=f.workspaceApi.workspaces.ref;
 const wrapRef=id=>{
  const h=origCreate(id);
  return {...h,agents:{create:async options=>{
   const res=await h.agents.create(options);
   const snap=f.snapshots.get(res.id);
   if(snap&&realpathSync(resolve(snap.cwd,fixtureGit(snap.cwd,'rev-parse','--git-common-dir')))===subCommonDir){
    // Move fixture registration from caller ledger to submodule ledger.
    const idx=f.members.findIndex(m=>m.agentId===res.id);
    if(idx>=0)subMembers.push(...f.members.splice(idx,1));
   }
   return res;
  }}};
 };
 f.workspaceApi.workspaces.ref=wrapRef;
 f.workspaceApi.workspaces.open=async input=>{
  f.hostCalls.push({kind:'open',input});
  f.workspaces.set('opened',{id:'opened',workspaceDirectory:input.cwd,status:'done',archivingAt:null});
  return wrapRef('opened');
 };
 f.workspaces.set('sub',{id:'sub',workspaceDirectory:subDir,status:'done',archivingAt:null});
 return {upstream,subDir,subCommonDir,subMembers};
}

for(const by of ['id','cwd','id+cwd'])test('Supervisor forms a Lead in a registered submodule by '+by+' with submodule desk membership and pins',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 const {subDir,subCommonDir,subMembers}=addRegisteredSubmodule(f);
 const placement=by==='id'?{kind:'existing',workspaceId:'sub',reason:'submodule lead'}
  :by==='cwd'?{kind:'existing',cwd:subDir,reason:'submodule lead'}
  :{kind:'existing',workspaceId:'sub',cwd:subDir,reason:'submodule lead'};
 const out=await f.run({...f.input,placement});
 assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out));
 assert.equal(out.result.workspaceId,by==='cwd'?'opened':'sub');
 assert.equal(f.snapshots.get('child').cwd,subDir);
 const observed=out.phases.find(p=>p.name==='target-observed').value;
 assert.equal(observed.cwd,subDir);assert.equal(observed.gitCommonDir,subCommonDir);
 assert.equal(observed.source.repository,subDir);assert.equal(observed.source.gitCommonDir,subCommonDir);
 assert.notEqual(observed.source.configuration['workspace-protocol.md'],null);
 assert.equal(f.members.length,0);assert.equal(subMembers.length,1);
 const prompt=out.result.delivery.prompt;
 assert.ok(prompt.includes('Repository: '+subDir));
 assert.ok(prompt.includes('Use '+subDir+'/.paseo-slp/workspace-protocol.md'));
 assert.equal(prompt.includes(f.repository+'/.paseo-slp'),false);
 const calls=f.hostCalls.length,replay=await f.run({...f.input,placement});
 assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);
});

test('Supervisor forms a Lead in a registered submodule without .paseo-slp configuration',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 const {subDir,subCommonDir,subMembers}=addRegisteredSubmodule(f,'plain-sub',{protocol:false});
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'sub',reason:'plain submodule'}});
 assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out));
 const observed=out.phases.find(p=>p.name==='target-observed').value;
 assert.equal(observed.cwd,subDir);assert.equal(observed.gitCommonDir,subCommonDir);
 assert.equal(observed.source.repository,subDir);
 assert.equal(observed.source.configuration['workspace-protocol.md'],null);
 assert.equal(f.members.length,0);assert.equal(subMembers.length,1);
});

for(const by of ['id','cwd'])test('Supervisor forms a Lead in a linked worktree of a registered submodule by '+by,async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 const {subDir,subCommonDir,subMembers}=addRegisteredSubmodule(f);
 const wt=join(f.dir,'sub-wt');
 fixtureGit(subDir,'worktree','add','--detach',wt,'HEAD');
 const wtDir=realpathSync(wt);
 // Remove .paseo-slp from linked worktree to verify inheritance from submodule main checkout.
 rmSync(join(wtDir,'.paseo-slp'),{recursive:true,force:true});
 f.workspaces.set('sub-wt',{id:'sub-wt',workspaceDirectory:wtDir,status:'done',archivingAt:null});
 const placement=by==='id'?{kind:'existing',workspaceId:'sub-wt',reason:'submodule worktree'}
  :{kind:'existing',cwd:wtDir,reason:'submodule worktree'};
 const out=await f.run({...f.input,placement});
 assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out));
 const observed=out.phases.find(p=>p.name==='target-observed').value;
 assert.equal(observed.cwd,wtDir);assert.equal(observed.gitCommonDir,subCommonDir);
 assert.equal(observed.source.repository,subDir);
 assert.notEqual(observed.source.configuration['workspace-protocol.md'],null);
 assert.ok(out.result.delivery.prompt.includes('Use '+subDir+'/.paseo-slp/workspace-protocol.md'));
 assert.equal(f.members.length,0);assert.equal(subMembers.length,1);
});

for(const [callerRole,role] of [['lead','lead'],['supervisor','peer'],['lead','peer']])
 test('registered submodule rejects '+callerRole+' → '+role+' before native allocation',async t=>{
  const f=placementFixture(t,{role,callerRole});
  addRegisteredSubmodule(f);
  const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'sub',reason:'disallowed role'}});
  assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out));
  assert.match(out.result.message,/different Git repository/);
  assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
 });

for(const by of ['id','cwd'])test('Supervisor inside a submodule cannot place a Lead into the parent superproject by '+by,async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 const {subDir,subCommonDir}=addRegisteredSubmodule(f);
 const parentDir=realpathSync(f.repository);
 f.workspaces.set('parent-super',{id:'parent-super',workspaceDirectory:parentDir,status:'done',archivingAt:null});
 const subPlacement=createFormationPlacement({repo:{gitCommonDir:subCommonDir},host:()=>f.workspaceApi});
 f.deps.placement=subPlacement;
 f.row.createCwd=subDir;f.row.workspaceId='sub';
 const placement=by==='id'?{kind:'existing',workspaceId:'parent-super',reason:'upward to parent'}
  :{kind:'existing',cwd:parentDir,reason:'upward to parent'};
 const out=await f.run({...f.input,placement});
 assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out));
 assert.match(out.result.message,/nested/);
 assert.equal(out.phases.length,0);
 assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
});

const spoofedSubmodules={
 'fake .git directory at registered submodule path':(f,{subDir})=>{
  rmSync(subDir,{recursive:true,force:true});
  committedRepository(subDir);
  return subDir;
 },
 'hijacked .git file pointing to foreign repository':(f,{subDir})=>{
  rmSync(join(subDir,'.git'),{force:true});
  writeFileSync(join(subDir,'.git'),'gitdir: '+f.foreignCommonDir+'\n');
  return subDir;
 },
 'submodule removed from working tree .gitmodules':(f,{subDir})=>{
  writeFileSync(join(f.repository,'.gitmodules'),'');
  return subDir;
 },
 'submodule removed from index (git rm --cached)':(f,{subDir})=>{
  fixtureGit(f.repository,'rm','--cached','sub');
  return subDir;
 },
 'symlink .gitmodules in superproject':(f,{subDir})=>{
  const realMod=join(f.dir,'ext-gitmodules');
  writeFileSync(realMod,readFileSync(join(f.repository,'.gitmodules'),'utf8'));
  rmSync(join(f.repository,'.gitmodules'),{force:true});
  symlinkSync(realMod,join(f.repository,'.gitmodules'));
  return subDir;
 },
 'symlink replacing submodule directory':(f,{subDir})=>{
  const alt=join(f.repository,'alt-inner');
  committedRepository(alt);
  rmSync(subDir,{recursive:true,force:true});
  symlinkSync(alt,subDir);
  return realpathSync(alt);
 },
 'uncommitted gitlink only in index and working tree .gitmodules':f=>{
  const fake=join(f.repository,'uncommitted-sub');
  committedRepository(fake);
  const oid=fixtureGit(fake,'rev-parse','HEAD');
  fixtureGit(f.repository,'update-index','--add','--cacheinfo','160000,'+oid+',uncommitted-sub');
  writeFileSync(join(f.repository,'.gitmodules'),'[submodule "uncommitted-sub"]\n\tpath = uncommitted-sub\n\turl = '+fake+'\n');
  return realpathSync(fake);
 },
};
for(const [attack,setup] of Object.entries(spoofedSubmodules)){
 test('Supervisor Lead rejects spoofed submodule: '+attack,async t=>{
  const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
  const sub=addRegisteredSubmodule(f);
  const targetDir=setup(f,sub);
  assert.ok(lstatSync(targetDir));
  f.workspaces.set('spoof',{id:'spoof',workspaceDirectory:targetDir,status:'done',archivingAt:null});
  const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'spoof',reason:'spoof'}});
  assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out));
  assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
 });
}

for(const stage of ['before create','after create'])test('submodule deregistration drift '+stage+' blocks dependent effects',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 addRegisteredSubmodule(f);
 let drifted=false;
 const deregister=()=>{if(drifted)return;drifted=true;writeFileSync(join(f.repository,'.gitmodules'),'');};
 if(stage==='before create')f.setProviderHook(deregister);else f.setAfterCreate(deregister);
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'sub',reason:'submodule drift'}});
 assert.ok(out.phases.some(p=>p.name==='target-observed'));assert.equal(drifted,true);
 assert.equal(out.result.code,'ROUTE_DRIFT',JSON.stringify(out));assert.match(out.result.message,/nested/);
 assert.equal(Object.hasOwn(out.result,'delivery'),false);assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
 assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,stage==='before create'?0:1);
});

test('submodule registration probe errors fail closed with CAPABILITY_GAP',async t=>{
 const real=createTaskGitIo();
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor',git:{...real,lsTree:async()=>{throw new Error('git ls-tree failure');}}});
 addRegisteredSubmodule(f);
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'sub',reason:'probe error'}});
 assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out));
 assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
});

test('Lead placed in a registered submodule forms a Peer in the submodule workspace on the submodule desk',async t=>{
 const f=placementFixture(t,{role:'lead',callerRole:'supervisor'});
 const {subDir,subCommonDir,subMembers}=addRegisteredSubmodule(f);
 writeFileSync(join(subDir,'.paseo-slp/slp-routing.json'),JSON.stringify({...f.catalog,options:[{...f.options[0],id:'sub-peer'}]}));
 const leadOut=await f.run({...f.input,requestId:'hop1-sub-lead',placement:{kind:'existing',workspaceId:'sub',reason:'submodule lead'}});
 assert.equal(leadOut.result.state,'awaiting-caller-delivery',JSON.stringify(leadOut));
 assert.equal(subMembers.length,1);
 // Hop 2: the Lead operates on the submodule's own desk and forms a Peer in a linked worktree of the submodule.
 const subWt=join(f.dir,'sub-peer-wt');
 fixtureGit(subDir,'worktree','add','--detach',subWt,'HEAD');
 const subWtDir=realpathSync(subWt);
 rmSync(join(subWtDir,'.paseo-slp'),{recursive:true,force:true});
 f.workspaces.set('sub-peer-wt',{id:'sub-peer-wt',workspaceDirectory:subWtDir,status:'done',archivingAt:null});
 const subPlacement=createFormationPlacement({repo:{gitCommonDir:subCommonDir},host:()=>f.workspaceApi});
 f.deps.placement=subPlacement;
 f.deps.repoKey='sub-repo';
 f.row.agentId=leadOut.result.agentId;f.row.role='lead';f.row.createCwd=subDir;f.row.workspaceId='sub';
 const peerOut=await f.run({...f.input,requestId:'hop2-sub-peer',role:'peer',placement:{kind:'existing',workspaceId:'sub-peer-wt',reason:'submodule peer lane'}});
 assert.equal(peerOut.result.state,'awaiting-caller-delivery',JSON.stringify(peerOut));
 const observed=peerOut.phases.find(p=>p.name==='target-observed').value;
 assert.equal(observed.cwd,subWtDir);assert.equal(observed.gitCommonDir,subCommonDir);
 assert.equal(observed.source.repository,subDir);
 assert.equal(peerOut.phases.find(p=>p.name==='route-selected').value.route.optionId,'sub-peer');
 assert.equal(subMembers.length,2);
});
