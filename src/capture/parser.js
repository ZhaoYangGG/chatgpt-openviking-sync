(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OpenVikingDetailParser = api;
})(globalThis, function () {
  'use strict';
  const idPattern = /^[a-zA-Z0-9_-]{1,160}$/;
  const isId = v => typeof v === 'string' && idPattern.test(v);
  const time = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const small = v => typeof v === 'string' ? v.slice(0,200) : null;
  function parseDetail(data, expectedId) {
    if (!data || typeof data !== 'object' || !isId(data.conversation_id)
        || data.conversation_id !== expectedId) throw new Error('conversation_id_mismatch');
    // No body is persisted unless both explicit privacy flags permit capture.
    if (data.is_temporary_chat !== false || data.is_do_not_remember !== false) {
      return {conversationId: expectedId, excluded: true,
        reason: data.is_temporary_chat === true || data.is_do_not_remember === true
          ? 'privacy_excluded' : 'privacy_unknown', messages: []};
    }
    if (!Array.isArray(data.messages) || data.messages.length > 5000) throw new Error('unsupported_schema');
    const messages = [], omissions = [], ids = new Set();
    const counts = {system:0, hidden:0, internal:0, incomplete:0, unsupported:0};
    for (const [index,m] of data.messages.entries()) {
      if (!m || typeof m !== 'object') throw new Error('invalid_message');
      const role = m.author?.role, type = m.content?.content_type;
      if (role === 'system') { counts.system++; continue; }
      if (m.metadata?.is_visually_hidden_from_conversation === true) { counts.hidden++; continue; }
      if (['model_editable_context','reasoning_recap'].includes(type)) { counts.internal++; continue; }
      const omit = reason => { counts[reason]++; omissions.push({index,id:small(m.id),role:small(role),type:small(type),reason}); };
      if (!['user','assistant'].includes(role) || type !== 'text') { omit('unsupported'); continue; }
      if (role === 'assistant' && (m.channel !== 'final' || m.end_turn !== true
          || m.status !== 'finished_successfully' || m.metadata?.is_complete !== true
          || ![null,undefined,'all'].includes(m.recipient))) { omit('incomplete'); continue; }
      if (role === 'user' && m.status !== 'finished_successfully') { omit('incomplete'); continue; }
      if (!isId(m.id) || ids.has(m.id)) throw new Error('invalid_or_duplicate_id');
      if (!Array.isArray(m.content.parts) || m.content.parts.some(p => typeof p !== 'string')) { omit('unsupported'); continue; }
      // Preserve original parts, whitespace and source order. Never sort by time.
      const text = m.content.parts.join('');
      if (!text.trim()) { omit('unsupported'); continue; }
      ids.add(m.id);
      messages.push({id:m.id, sourceMessageId:`chatgpt:${expectedId}:${m.id}`, role,
        parts:[...m.content.parts], content:text, sourceIndex:index,
        createTime:time(m.create_time), createTimeDecimal:time(m.create_time) === null ? null : String(m.create_time),
        updateTime:time(m.update_time), updateTimeDecimal:time(m.update_time) === null ? null : String(m.update_time),
        actualModel:small(m.metadata?.resolved_model_slug),
        turnId:small(m.metadata?.turn_exchange_id), workingTurnId:small(m.metadata?.working_turn_id),
        parentId:small(m.metadata?.parent_id), channel:small(m.channel), status:m.status,
        endTurn:m.end_turn ?? null});
    }
    const p=data.page_info;
    const pageInfo=p && typeof p.has_previous_page === 'boolean' && typeof p.has_next_page === 'boolean'
      ? {startCursor:small(p.start_cursor),endCursor:small(p.end_cursor),hasPreviousPage:p.has_previous_page,hasNextPage:p.has_next_page} : null;
    return {conversationId:expectedId,title:typeof data.title === 'string' ? data.title.slice(0,1000):'',
      excluded:false,createTime:time(data.create_time),updateTime:time(data.update_time),
      defaultModel:small(data.default_model_slug),currentNode:small(data.current_node),
      nodeCount:data.messages.length,messages,omissions,counts,pageInfo,
      returnedPageSupported:omissions.length === 0,
      scope:'observed_response_only',fullHistoryVerified:false};
  }
  function compareDom(apiIds, domIds) {
    const api=new Set(apiIds), dom=new Set(domIds);
    return {matched:[...dom].filter(id=>api.has(id)),domOnly:[...dom].filter(id=>!api.has(id)),
      apiNotInDom:[...api].filter(id=>!dom.has(id)),
      conclusion:dom.size === 0 ? 'no_dom_ids' : [...dom].every(id=>api.has(id))
        ? 'all_current_dom_ids_match_api_subset' : 'differences_need_review'};
  }
  return {parseDetail,compareDom,isId};
});
