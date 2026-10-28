'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createApp}=require('./harness');
const SkillFile=require('../js/storage/skills');

test('skills use standard YAML frontmatter and preserve Markdown and optional metadata',async()=>{
  const app=createApp({developer:false});
  const markdown='---\nname: review-code\ndescription: >-\n  Review changes and find defects.\n  Use for pull requests.\nlicense: MIT\nmetadata:\n  author: "A: B"\n---\n\n# Review\n\n- Read the diff.\n- Explain defects.\n';
  const item=await app.api('POST','resources',{kind:'skill',name:'review-code',payload:{markdown,folder:'Engineering/Reviews'}});
  const parsed=SkillFile.read(item.payload.markdown);
  assert.equal(parsed.meta.description,'Review changes and find defects. Use for pull requests.');
  assert.deepEqual(parsed.meta.metadata,{author:'A: B'});
  assert.match(parsed.instruction,/# Review\n\n- Read/);
  assert.equal(item.payload.text,undefined);
  assert.deepEqual(await app.api('GET','library/skill-folders'),['Engineering','Engineering/Reviews']);
  const renamed=await app.api('PUT',`resources/${item.id}`,{name:'review-security',payload:item.payload});
  assert.equal(SkillFile.read(renamed.payload.markdown).meta.name,'review-security');
  await assert.rejects(app.api('POST','resources',{kind:'skill',name:'Bad Name',payload:{description:'Description',instruction:'text'}}),/Skill name/);
  await assert.rejects(app.api('POST','resources',{kind:'skill',name:'empty-description',payload:{description:'',instruction:'text'}}),/description/);
  await assert.rejects(app.api('POST','resources',{kind:'skill',name:'broken',payload:{markdown:'---\nname: broken\n---\nBody'}}),/description/);
  assert.equal((await app.api('GET','resources')).length,1);
});

test('skill groups support nested rename, icons, moving and recursive deletion independently of node groups',async()=>{
  const app=createApp({developer:false});
  const folders=body=>app.api('POST','library/skill-folders',body);
  await folders({action:'create',path:'',name:'Writing'});
  await folders({action:'create',path:'Writing',name:'Short'});
  await folders({action:'icon',path:'Writing/Short',icon:'spark'});
  const item=await app.api('POST','resources',{kind:'skill',name:'short-answer',payload:{description:'Answer concisely.',instruction:'Give the answer first.'}});
  await app.api('POST',`library/skills/${item.id}/move`,{folder:'Writing/Short'});
  await folders({action:'rename',path:'Writing',name:'Communication'});
  assert.deepEqual(await app.api('GET','library/skill-folders'),['Communication','Communication/Short']);
  assert.equal((await app.api('GET',`resources/${item.id}`)).payload.folder,'Communication/Short');
  assert.equal((await app.api('GET','settings')).skill_folder_icons['Communication/Short'],'spark');
  assert.deepEqual(await app.api('GET','library/node-folders'),[]);
  await assert.rejects(app.api('POST',`library/skills/${item.id}/move`,{folder:'Missing'}),/Group not found/);
  await folders({action:'delete',path:'Communication'});
  assert.deepEqual(await app.api('GET','resources'),[]);
  assert.deepEqual(await app.api('GET','library/skill-folders'),[]);
});
