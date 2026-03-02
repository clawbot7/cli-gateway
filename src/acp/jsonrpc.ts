export type JsonRpcVersion = '2.0';

export type JsonRpcId = number | string;

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcRequest = {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: JsonRpcVersion;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | { jsonrpc: JsonRpcVersion; id: JsonRpcId; result: unknown }
  | { jsonrpc: JsonRpcVersion; id: JsonRpcId; error: JsonRpcError };

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export function isRequest(message: any): message is JsonRpcRequest {
  return (
    message &&
    message.jsonrpc === '2.0' &&
    typeof message.method === 'string' &&
    'id' in message
  );
}

export function isNotification(message: any): message is JsonRpcNotification {
  return (
    message &&
    message.jsonrpc === '2.0' &&
    typeof message.method === 'string' &&
    !('id' in message)
  );
}

export function isResponse(message: any): message is JsonRpcResponse {
  return (
    message &&
    message.jsonrpc === '2.0' &&
    'id' in message &&
    ('result' in message || 'error' in message)
  );
}
