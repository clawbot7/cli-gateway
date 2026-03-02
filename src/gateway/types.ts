export type OutboundSink = {
  sendText: (text: string) => Promise<void>;
};
