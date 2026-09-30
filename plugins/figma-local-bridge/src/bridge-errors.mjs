// Keep the wire error string for older peers; carry actionable metadata alongside it.
const fields = ['operationStatus', 'rollbackErrors', 'code', 'nextStep', 'retryPolicy', 'fileKey', 'blockers', 'operationId', 'argsHash', 'stage', 'commandSent', 'originalErrorCode', 'catalogDiagnostics'];

export function errorDetails(error) {
  return Object.fromEntries(fields.filter(key => error?.[key] !== undefined).map(key => [key, error[key]]));
}

export function remoteError(message, details) {
  return Object.assign(new Error(message), errorDetails(details));
}
