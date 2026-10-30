'use strict';
const base = value => String(value ?? '').trim().replace(/\/+$/, '');
exports.createService = app => {
  async function provider({provider, item_id, url} = {}) {
    const {items} = await app.library.listItems('providers');
    const matches = items.filter(item => item_id ? item.id === item_id
      : provider ? item.id === provider || item.values.providerId === provider : base(item.values.baseURL) === base(url));
    if (matches.length > 1) throw Error('Several Providers share this URL. Connect the provider input.');
    const item = matches[0];
    if (!item && (provider || item_id)) throw Error('Provider is unavailable in the Library');
    if (item && url && base(item.values.baseURL) !== base(url)) throw Error('The URL does not match the selected Provider');
    if (!item && !url) throw Error('Connect a Provider or specify its URL');
    return item ?? {id:null,values:{baseURL:base(url),npm:'@ai-sdk/openai-compatible'}};
  }
  const path = item => item.values.npm === '@ai-sdk/anthropic' ? '/messages' : '/chat/completions';
  async function headers(item) {
    const key = item.id ? await app.library.getSecret('providers',item.id,'apiKey') : null;
    const out = {Accept:'application/json','Content-Type':'application/json'};
    if (item.values.npm === '@ai-sdk/anthropic') {
      out['anthropic-version']='2023-06-01';
      if(key)out['x-api-key']=key;
    } else if(key)out.Authorization='Bearer '+key;
    const hidden = key ? [key] : [];
    for(const [name,value] of Object.entries(item.values.headers??{})) {
      const old=Object.keys(out).find(k=>k.toLowerCase()===name.toLowerCase());if(old)delete out[old];out[name]=value;
      if(/auth|key|secret|token|cookie/i.test(name)&&typeof value==='string'&&value)hidden.push(value);
    }
    return {headers:out,clean:text=>hidden.reduce((out,key)=>out.split(key).join('[REDACTED]'),String(text))};
  }
  async function models(input) {
    const item=await provider(input), auth=await headers(item);
    const url=base(item.values.baseURL)+'/models', items=new Map(), cursors=new Set();let next=url;
    while(next) {
      const response=await app.request('POST','net',{url:next,headers:auth.headers,timeout:10000});
      if(response.status<200||response.status>=300)throw Error('Model list request failed: HTTP '+response.status);
      let data;try{data=JSON.parse(response.text);}catch{throw Error('The model endpoint did not return JSON');}
      const list=Array.isArray(data)?data:data?.data??data?.models;
      if(!Array.isArray(list))throw Error('The model endpoint must return an array or {data: [...]}');
      for(const model of list) {
        const id=typeof model==='string'?model:model?.id??model?.name;
        if(typeof id==='string'&&id)items.set(auth.clean(id),{id:auth.clean(id),label:auth.clean(model?.display_name??model?.name??id)});
      }
      next=null;
      if(data.has_more&&typeof data.last_id==='string') {
        if(cursors.has(data.last_id))throw Error('The model endpoint repeated a pagination cursor');
        cursors.add(data.last_id);next=url+'?after_id='+encodeURIComponent(data.last_id);
      }
    }
    return {items:[...items.values()].sort((a,b)=>a.id.localeCompare(b.id))};
  }
  async function prepare(input) {
    const item=await provider(input);
    if(typeof input.model!=='string'||!input.model.trim())throw Error('Choose a model');
    if(typeof input.prompt!=='string'||!input.prompt.trim())throw Error('Enter a prompt');
    const messages=[{role:'user',content:input.prompt}];
    const body={...(item.values.options??{}),model:input.model,messages,stream:false};
    if(item.values.npm==='@ai-sdk/anthropic')body.max_tokens??=1024;
    return {provider:item.id,baseURL:base(item.values.baseURL),url:base(item.values.baseURL)+path(item),method:'POST',body:JSON.stringify(body),timeout:60000};
  }
  async function request(input) {
    const item=await provider({provider:input.provider,url:input.baseURL});
    if(input.method!=='POST'||input.url!==base(item.values.baseURL)+path(item))throw Error('Request URL does not match the Provider inference endpoint');
    const auth=await headers(item);
    const response=await app.request('POST','net',{url:input.url,method:'POST',headers:auth.headers,body:input.body,timeout:input.timeout??60000});
    return {status:response.status,text:auth.clean(response.text)};
  }
  return {models,prepare,request};
};
