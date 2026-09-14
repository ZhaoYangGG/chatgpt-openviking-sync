(function(root,factory){
  const core=root.OpenVikingSyncCore||(typeof require==='function'?require('../shared/core.js'):null);
  const api=factory(core);if(typeof module==='object'&&module.exports)module.exports=api;
  root.OpenVikingMessageStore=api;
})(globalThis,function(core){
  'use strict';
  const req=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const size=value=>new TextEncoder().encode(JSON.stringify(value)).length+256;
  const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(v);
  class MessageStore {
    constructor({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,crypto=globalThis.crypto,name='openviking-sync-v2',maxBytes=100*1024*1024}={}) {
      this.idb=indexedDB;this.keyRange=keyRange;this.crypto=crypto;this.name=name;this.maxBytes=maxBytes;
    }
    async open(){
      const r=this.idb.open(this.name,1);
      r.onupgradeneeded=()=>{
        const db=r.result;
        db.createObjectStore('conversations',{keyPath:'key'});
        for(const name of ['messages','outbox','revisions']){
          const s=db.createObjectStore(name,{keyPath:'key'});
          s.createIndex('conversation','conversationKey');
          if(name==='outbox')s.createIndex('dispatch','dispatchKey');
        }
        db.createObjectStore('meta',{keyPath:'key'});
      };
      return req(r);
    }
    async transaction(names,mode,fn){
      const db=await this.open();
      const tx=db.transaction(names,mode);
      const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('transaction_aborted'));tx.onerror=()=>{};});
      // Attach immediately to avoid an unhandled rejection on quota/abort.
      done.catch(()=>{});
      try {const value=await fn(tx);await done;return value;}
      catch(error){try{tx.abort();}catch{} await done.catch(()=>{});throw error;}
      finally {db.close();}
    }
    async hash(value){
      const bytes=await this.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
      return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
    }
    async ingest(scope,detail,observedAt=Date.now()){
      if(typeof scope!=='string'||!scope||scope.length>200||!validId(detail?.conversationId))throw Error('invalid_scope');
      if(detail.excluded)return {excluded:true,inserted:0};
      if(!Array.isArray(detail.messages)||detail.messages.length>5000)throw Error('invalid_messages');
      const conversationKey=[scope,detail.conversationId];
      // Hash outside IDB transactions: external async work would close a transaction.
      const prepared=[];
      for(const message of detail.messages){
        if(!validId(message.id)||!['user','assistant'].includes(message.role)||typeof message.content!=='string'
          ||message.sourceMessageId!==`chatgpt:${detail.conversationId}:${message.id}`)throw Error('invalid_message_identity');
        // Local identity tracks exact text, including Markdown/code whitespace.
        // V1-normalized comparison belongs only in the later migration adapter.
        const contentHash=await this.hash(JSON.stringify([message.role,message.content]));
        const {content,parts,...metadata}=message;
        const metadataHash=await this.hash(JSON.stringify(metadata));
        prepared.push({key:[...conversationKey,message.id],conversationKey,content,parts,metadata,contentHash,metadataHash});
      }
      return this.transaction(['conversations','messages','outbox','revisions','meta'],'readwrite',async tx=>{
        const conversations=tx.objectStore('conversations'),messages=tx.objectStore('messages'),outbox=tx.objectStore('outbox');
        const revisions=tx.objectStore('revisions'),meta=tx.objectStore('meta');
        const budget=await req(meta.get('budget'))||{key:'budget',bytes:0};
        const c=await req(conversations.get(conversationKey))||{key:conversationKey,conversationId:detail.conversationId,
          scope,sessionId:core.buildSessionId(detail.conversationId),messageCount:0,queuedCount:0,conflictCount:0,nextSequence:0};
        const oldConversationBytes=c.storedBytes||0;
        let inserted=0,updated=0,conflicts=0;
        for(const incoming of prepared){
          const old=await req(messages.get(incoming.key));
          if(!old){
            const row={...incoming,firstObservedAt:observedAt,sequence:c.nextSequence++,status:'queued'};
            row.storedBytes=size(row);const pending={key:row.key,conversationKey,sequence:row.sequence,
              dispatchKey:[...conversationKey,row.sequence],contentHash:row.contentHash,status:'queued',attempts:0,nextAttemptAt:0};
            pending.storedBytes=size(pending);budget.bytes+=row.storedBytes+pending.storedBytes;
            messages.add(row);outbox.add(pending);c.messageCount++;c.queuedCount++;inserted++;
          }else if(old.contentHash!==incoming.contentHash){
            const revisionKey=[...incoming.key,incoming.contentHash];
            if(!await req(revisions.get(revisionKey))){
              const revision={...incoming,key:revisionKey,observedAt};revision.storedBytes=size(revision);
              revisions.add(revision);budget.bytes+=revision.storedBytes;
            }
            if(old.status!=='conflict'){
              const previous=old.storedBytes;old.status='conflict';old.storedBytes=size({...old,storedBytes:undefined});
              messages.put(old);budget.bytes+=old.storedBytes-previous;c.conflictCount++;conflicts++;
              const pending=await req(outbox.get(old.key));
              if(pending){budget.bytes-=pending.storedBytes;outbox.delete(old.key);c.queuedCount--;}
            }
          }else if(old.metadataHash!==incoming.metadataHash){
            const previous=old.storedBytes;old.metadata=incoming.metadata;old.metadataHash=incoming.metadataHash;
            old.storedBytes=size({...old,storedBytes:undefined});budget.bytes+=old.storedBytes-previous;messages.put(old);updated++;
          }
        }
        Object.assign(c,{title:detail.title,lastObservedAt:observedAt,lastPage:detail.pageInfo,
          unsupportedCount:detail.omissions?.length||0,fullHistoryVerified:false,
          hasUnsupportedHistory:c.hasUnsupportedHistory===true||detail.returnedPageSupported!==true,
          collectionStatus:detail.returnedPageSupported?'observed_range':'unsupported_content'});
        c.storedBytes=size({...c,storedBytes:undefined});budget.bytes+=c.storedBytes-oldConversationBytes;
        if(budget.bytes>this.maxBytes)throw Error('storage_capacity_reached');
        meta.put(budget);conversations.put(c);
        return {inserted,updated,conflicts,messageCount:c.messageCount,queuedCount:c.queuedCount};
      });
    }
    async getConversation(scope,id){return this.transaction(['conversations'],'readonly',tx=>req(tx.objectStore('conversations').get([scope,id])));}
    async listOutbox(scope,id,limit=100){
      if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('invalid_limit');
      return this.transaction(['outbox'],'readonly',tx=>new Promise((resolve,reject)=>{
        const range=this.keyRange.bound([scope,id,0],[scope,id,Number.MAX_SAFE_INTEGER]);
        const rows=[],r=tx.objectStore('outbox').index('dispatch').openCursor(range);
        r.onerror=()=>reject(r.error);r.onsuccess=()=>{const cursor=r.result;if(!cursor||rows.length===limit){resolve(rows);return;}
          rows.push(cursor.value);cursor.continue();};
      }));
    }
  }
  return {MessageStore};
});
