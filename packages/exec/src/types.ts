export interface ExecRequest {
  shopId: string;
  toolName: string;
  inputs: Record<string, unknown>;
  authContext: {
    agentId?: string;
    token?: string;
    isAuthenticated: boolean;
  };
}

export interface ExecResult {
  status: 'success' | 'failure' | 'auth_required' | 'error';
  data?: unknown;
  error?: { code: string; message: string };
  latencyMs: number;
}
