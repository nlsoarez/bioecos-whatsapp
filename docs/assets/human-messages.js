let humanHistoryTimer = null;
let activeHumanConversation = null;
function closeHumanConversation() {
  clearInterval(humanHistoryTimer); humanHistoryTimer=null; activeHumanConversation=null;
}
function mountHumanConversation(lead,detail,history) {
  const state={id:lead.conversation_id,version:lead.ownership_version,owner:lead.current_owner,workflow:lead.workflow_state,messages:new Map(),cursor:null,busy:false,sending:false,key:null,keyText:null};
  activeHumanConversation=state;
  const older=document.createElement('button'); older.type='button';older.className='secondary-action';older.textContent='Carregar mensagens anteriores';
  const outgoing=document.createElement('div');outgoing.className='human-outgoing';
  const form=document.createElement('form');form.className='human-composer';
  const label=document.createElement('label');label.textContent='Responder ao cliente pelo WhatsApp da Débora';
  const draft=document.createElement('textarea');draft.maxLength=4096;draft.rows=3;draft.placeholder='Escreva sua mensagem';draft.required=true;
  const submit=document.createElement('button');submit.type='submit';submit.className='primary-action';submit.textContent='Enviar mensagem';
  const feedback=document.createElement('p');feedback.className='inline-feedback';
  const permission=document.createElement('p');permission.className='panel-description';
  label.append(draft);form.append(label,permission,submit,feedback);detail.append(older,outgoing,form);
  const statuses={queued:'Na fila',processing:'Enviando',accepted:'Aceita pela Evolution — entrega e leitura não confirmadas',failed:'Falha',unknown:'Envio não confirmado — não será repetido automaticamente',cancelled:'Cancelada'};
  const updatePermission=()=>{
    const allowed=state.owner==='coordinator' && state.workflow==='coordinator_attending';
    draft.disabled=!allowed;submit.disabled=!allowed || state.sending;
    permission.textContent=allowed ? 'Atendimento humano ativo. A Débora permanece bloqueada.' : 'Assuma o atendimento para enviar mensagens.';
  };
  const load=async(previous=false)=>{
    if(state.busy || activeHumanConversation!==state) return;
    state.busy=true;
    try {
      const page=await api(`/dashboard/conversations/${encodeURIComponent(state.id)}/messages${previous && state.cursor ? `?cursor=${encodeURIComponent(state.cursor)}` : ''}`);
      if(activeHumanConversation!==state) return;
      if(previous || state.messages.size===0 || !page.messages.some(item=>state.messages.has(item.id))) state.cursor=page.nextCursor;
      for(const item of page.messages) state.messages.set(item.id,item);
      state.version=page.conversation.version;state.owner=page.conversation.owner;state.workflow=page.conversation.state;
      const meta=detail.querySelector('.panel-description');
      if(meta) meta.textContent=`${lead.course || lead.interest || 'Interesse em identificação'} · ${workflowLabel(state.workflow)} · responsável: ${state.owner==='ai' ? 'IA' : 'Coordenador'}`;
      history.replaceChildren();
      [...state.messages.values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp) || a.id.localeCompare(b.id)).forEach(item=>{
        const row=document.createElement('div');row.className=`message-item ${item.direction}`;
        const content=document.createElement('p');content.textContent=item.content;
        const author=document.createElement('small');author.textContent=`${item.author} · ${formatDateTime(item.timestamp)}`;
        row.append(content,author);history.append(row);
      });
      older.hidden=!state.cursor;outgoing.replaceChildren();
      page.outgoing.slice(0,10).forEach(item=>{
        const row=document.createElement('p');row.textContent=`${item.actor}: ${item.text} — ${statuses[item.status] || item.status}${item.error ? ` (${item.error})` : ''}`;outgoing.append(row);
      });
      updatePermission();
    } catch(error) {if(activeHumanConversation===state) setFeedback(feedback,error.message,'error');}
    finally {state.busy=false;}
  };
  older.addEventListener('click',()=>void load(true));
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(state.sending) return;
    const text=draft.value.trim();if(!text) return;
    state.sending=true;updatePermission();
    try {
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(value=>value.toString(16).padStart(2,'0')).join('');
      const keySlot=`bioecos_human_pending_${state.id}`;
      let stored;try {stored=JSON.parse(sessionStorage.getItem(keySlot) || 'null');}catch {stored=null;}
      state.key=stored?.digest===digest ? stored.key : crypto.randomUUID();state.keyText=text;
      sessionStorage.setItem(keySlot,JSON.stringify({key:state.key,digest}));
      await api(`/dashboard/conversations/${encodeURIComponent(state.id)}/messages`,{method:'POST',body:{text,requestKey:state.key,version:state.version}});
      sessionStorage.removeItem(keySlot);
      draft.value='';state.key=null;state.keyText=null;
      setFeedback(feedback,'Mensagem registrada na fila de envio.','success');await load();
    } catch(error) {setFeedback(feedback,error.message,'error');}
    finally {state.sending=false;updatePermission();}
  });
  updatePermission();void load();
  humanHistoryTimer=setInterval(()=>{if(activeHumanConversation===state && !document.hidden && !detail.hidden) void load();},5000);
}
