import { invoke } from '@tauri-apps/api/core';
import { desktop } from './native';

export type SetupProvider =
  | 'openai'
  | 'anthropic'
  | 'openai-compatible'
  | 'ollama'
  | 'codex'
  | 'claude';
export interface SetupStatus {
  phase: 'idle' | 'signing_in' | 'starting' | 'ready' | 'error';
  message?: string;
  error?: string;
  endpoint?: string;
  provider?: SetupProvider;
  model?: string;
  models?: ProviderModel[];
  connectionId?: string;
  baseUrl?: string;
  configured?: boolean;
  connections?: SavedConnection[];
  mcpConnections?: SavedMcpConnection[];
  restartRequired?: boolean;
  sourcesState?: 'current' | 'pending' | 'applying' | 'error';
  sourceApplyError?: string;
  engineGeneration?: number;
  sourcePhase?: 'idle' | 'signing_in' | 'error';
  sourceError?: string;
  sourceMessage?: string;
  sourceProvider?: SetupProvider;
  signInUrl?: string;
  code?: string;
  dockerReady: boolean;
  runtimeAvailable: boolean;
  codexAvailable: boolean;
  claudeAvailable: boolean;
}
export interface ProviderCredentials {
  provider: SetupProvider;
  apiKey?: string;
  baseUrl?: string;
}
export interface ProviderModel {
  id: string;
  name: string;
}
export interface SavedConnection {
  id: string;
  revision?: number;
  title: string;
  provider: SetupProvider;
  baseUrl?: string;
  models: ProviderModel[];
  defaultModel?: string;
  hasCredential: boolean;
}
export interface SaveConnection extends ProviderCredentials {
  id?: string;
  expectedRevision?: number;
  title?: string;
  model?: string;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
export interface SavedMcpConnection {
  id: string;
  title: string;
  transport: 'streamable_http';
  url: string;
  tools: McpTool[];
  allowedTools: string[];
  hasCredential: boolean;
  revision: number;
}
export interface McpCredentials {
  id?: string;
  url: string;
  token?: string;
  clearToken?: boolean;
}
export interface SaveMcpConnection extends McpCredentials {
  expectedRevision?: number;
  title: string;
  allowedTools: string[];
}

function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop) return Promise.reject(new Error('Open the desktop app to manage connections.'));
  return invoke<T>(command, args);
}
export const setupStatus = () => native<SetupStatus>('desktop_setup_status');
export const cancelSetup = () => native<SetupStatus>('desktop_setup_cancel');
export const openDependency = (dependency: 'docker' | 'ollama') =>
  native<void>('desktop_open_dependency', { dependency });
export const signInProvider = (provider: 'codex' | 'claude') =>
  native<SetupStatus>('desktop_provider_sign_in', { provider });
export const cancelProviderSignIn = () => native<SetupStatus>('desktop_provider_sign_in_cancel');
export const providerModels = (credentials: ProviderCredentials) =>
  native<ProviderModel[]>('desktop_provider_models', { ...credentials });
export const savedConnections = () => native<SavedConnection[]>('desktop_connections_list');
export const saveConnection = (connection: SaveConnection) =>
  native<SavedConnection>('desktop_connection_save', { ...connection });
export const refreshConnection = (id: string, expectedRevision?: number) =>
  native<SavedConnection>('desktop_connection_refresh', { id, expectedRevision });
export const removeConnection = (id: string, expectedRevision?: number) =>
  native<SavedConnection[]>('desktop_connection_remove', { id, expectedRevision });
export const startDesktopEngine = () => native<SetupStatus>('desktop_engine_start');
export const savedMcpConnections = () =>
  native<SavedMcpConnection[]>('desktop_mcp_connections_list');
export const mcpTools = (credentials: McpCredentials) =>
  native<McpTool[]>('desktop_mcp_tools', { ...credentials });
export const saveMcpConnection = (connection: SaveMcpConnection) =>
  native<SavedMcpConnection>('desktop_mcp_connection_save', { ...connection });
export const refreshMcpConnection = (id: string, expectedRevision?: number) =>
  native<SavedMcpConnection>('desktop_mcp_connection_refresh', { id, expectedRevision });
export const removeMcpConnection = (id: string, expectedRevision?: number) =>
  native<SavedMcpConnection[]>('desktop_mcp_connection_remove', { id, expectedRevision });
