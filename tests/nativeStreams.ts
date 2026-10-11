/** Small protocol responses for exercising the real Toonflow SDK, without calling a model. */
export function nativeToolResponse(path: string): Response | undefined {
  const event = (type: string, rest: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`
  let body: string
  if (path === '/v1/messages') {
    body = event('message_start', { message: { id: 'msg-film', type: 'message', role: 'assistant', model: 'claude-film', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
      + event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tool-film', name: 'splitClip', input: {} } })
      + event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"second":2}' } })
      + event('content_block_stop', { index: 0 })
      + event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } })
      + event('message_stop')
  } else if (path === '/v1/responses') {
    const item = { id: 'fc-film', type: 'function_call', call_id: 'call-film', name: 'splitClip', arguments: '' }
    body = event('response.created', { response: { id: 'resp-film', status: 'in_progress', output: [] } })
      + event('response.output_item.added', { output_index: 0, item })
      + event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: '{"second":2}' })
      + event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: '{"second":2}' })
      + event('response.output_item.done', { output_index: 0, item: { ...item, arguments: '{"second":2}', status: 'completed' } })
      + event('response.completed', { response: { id: 'resp-film', status: 'completed', output: [{ ...item, arguments: '{"second":2}' }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } })
  } else return undefined
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
