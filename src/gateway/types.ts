export type DeliveryState = {
  text: string;
  messageId: string | null;
};

export type OutboundSink = {
  sendText: (text: string) => Promise<void>;
  flush?: () => Promise<void>;
  getDeliveryState?: () => DeliveryState;
};
