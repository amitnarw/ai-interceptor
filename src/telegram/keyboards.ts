export interface ApprovalKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  input_field_placeholder?: string;
}

export function buildApprovalKeyboard(requestId: string): ApprovalKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '✅ Accept', callback_data: `approve:${requestId}` },
        { text: '❌ Reject', callback_data: `reject:${requestId}` },
      ],
      [{ text: '✏️ Custom', callback_data: `custom:${requestId}` }],
    ],
  };
}

export function escapeMarkdown(text: string): string {
  const specialChars = /([_*[`~>#+\-=|{}.!\\()\[\]])/g;
  return text.replace(specialChars, '\\$&');
}

export function formatToolApprovalMessage(
  toolName: string,
  filePath: string | undefined,
  preview: string,
  requestId: string
): { text: string; reply_markup: ApprovalKeyboard } {
  const escapedTool = escapeMarkdown(toolName);
  const escapedPreview = escapeMarkdown(preview.substring(0, 500));

  let text = `*Tool Call Requested*\n\n`;
  text += `Tool: \`${escapedTool}\`\n`;

  if (filePath) {
    const escapedPath = escapeMarkdown(filePath);
    text += `File: \`${escapedPath}\`\n`;
  }

  text += `\nPreview:\n\`\`\`\n${escapedPreview}\n\`\`\`\n`;

  return {
    text,
    reply_markup: buildApprovalKeyboard(requestId),
  };
}

export function buildCommandKeyboard(): ApprovalKeyboard {
  return {
    inline_keyboard: [
      [
        { text: 'Status', callback_data: 'cmd:status' },
        { text: 'Away', callback_data: 'cmd:away' },
        { text: 'Desk', callback_data: 'cmd:desk' },
      ],
      [
        { text: 'Clear', callback_data: 'cmd:clear' },
      ],
    ],
    input_field_placeholder: 'Use buttons below to interact',
  };
}

export function buildApprovalPlusCommandKeyboard(requestId: string): ApprovalKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '✅ Accept', callback_data: `approve:${requestId}` },
        { text: '❌ Reject', callback_data: `reject:${requestId}` },
        { text: '✏️ Custom', callback_data: `custom:${requestId}` },
      ],
      [
        { text: 'Status', callback_data: 'cmd:status' },
        { text: 'Away', callback_data: 'cmd:away' },
        { text: 'Desk', callback_data: 'cmd:desk' },
      ],
      [
        { text: 'Clear', callback_data: 'cmd:clear' },
      ],
    ],
    input_field_placeholder: 'Use buttons below to interact',
  };
}

export function parseCallbackData(data: string): { action: string; requestId: string } | null {
  const parts = data.split(':');
  if (parts.length < 2) {
    return null;
  }
  const [action, ...requestIdParts] = parts;
  return {
    action,
    requestId: requestIdParts.join(':'),
  };
}
