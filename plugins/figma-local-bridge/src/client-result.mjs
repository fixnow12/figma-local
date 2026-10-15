// Decode saved MCP evidence without replaying a call. Only inspect protocol-level
// error locations, never arbitrary descendants (catalog nodes may contain errors).
export function decodeToolResult(response) {
  const texts = (response.content || []).filter(item => item.type === 'text').map(item => item.text);
  let payload = response.structuredContent;
  if (payload === undefined) {
    const objects = texts.flatMap(text => {
      try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? [value] : []; }
      catch { return []; }
    });
    // Do not pick an arbitrary object when several independent JSON blocks exist.
    payload = objects.length === 1 ? objects[0] : texts;
  }
  const internalError = payload && !Array.isArray(payload) && typeof payload === 'object'
    ? payload.error || (payload.result?.success === false && payload.result.error) : undefined;
  return { payload, isError: Boolean(response.isError || internalError),
    error: internalError || (response.isError ? texts.join('\n') : undefined) };
}
