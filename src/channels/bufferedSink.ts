export type BufferedSinkState = {
  text: string;
  messageId: string | null;
};

export type BufferedSink = {
  sendText: (delta: string) => Promise<void>;
  flush: () => Promise<void>;
  getState: () => BufferedSinkState;
};

export function createBufferedSink(params: {
  maxLen: number;
  flushIntervalMs: number;
  send: (text: string) => Promise<{ id: string }>;
  edit: (id: string, text: string) => Promise<void>;
  initialState?: BufferedSinkState;
}): BufferedSink {
  let currentText = params.initialState?.text ?? '';
  let currentMessageId: string | null = params.initialState?.messageId ?? null;
  let flushTimer: NodeJS.Timeout | null = null;
  let flushing = false;

  async function doFlush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      if (!currentText) return;

      if (!currentMessageId) {
        const res = await params.send(truncate(currentText, params.maxLen));
        currentMessageId = res.id;
        return;
      }

      try {
        await params.edit(currentMessageId, truncate(currentText, params.maxLen));
      } catch {
        const res = await params.send(truncate(currentText, params.maxLen));
        currentMessageId = res.id;
      }
    } finally {
      flushing = false;
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await doFlush();
    }, params.flushIntervalMs);
  }

  async function sendText(delta: string): Promise<void> {
    if (!delta) return;

    if (currentText.length + delta.length > params.maxLen * 1.5) {
      await doFlush();
      currentText = '';
      currentMessageId = null;
    }

    currentText += delta;
    scheduleFlush();
  }

  return {
    sendText,
    flush: async () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await doFlush();
    },
    getState: () => ({ text: currentText, messageId: currentMessageId }),
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
