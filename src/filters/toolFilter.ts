export const INTERCEPT_TOOLS = new Set([
  'write_to_file',
  'create_file',
  'delete_file',
  'apply_diff',
  'str_replace',
  'insert_content',
  'execute_command',
  'run_terminal_cmd',
  'computer_use',
]);

export const PASSTHROUGH_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'grep_search',
  'web_search',
  'get_file_info',
]);

export type ToolClassification = 'intercept' | 'passthrough';

export function classifyTool(toolName: string): ToolClassification {
  if (INTERCEPT_TOOLS.has(toolName)) {
    return 'intercept';
  }
  if (PASSTHROUGH_TOOLS.has(toolName)) {
    return 'passthrough';
  }
  return 'intercept';
}

export function shouldIntercept(toolName: string): boolean {
  return classifyTool(toolName) === 'intercept';
}

export function shouldPassthrough(toolName: string): boolean {
  return classifyTool(toolName) === 'passthrough';
}
