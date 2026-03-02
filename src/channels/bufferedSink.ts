export type BufferedSink = {
  sendText: (delta: string) => Promise<void>;
  flush: () => Promise<void>;
};

export function createBufferedSink(params: {
  maxLen: number;
  flushIntervalMs: number;
  send: (text: string) => Promise<{ id: string }>;
  edit: (id: string, text: string) => Promise<void>;
}): BufferedSink {
  let currentText = '';
  let currentMessageId: string | null = null;
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

      await params.edit(currentMessageId, truncate(currentText, params.maxLen));
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

    // If the buffer grows too large, finalize current message and start a new one.
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
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
