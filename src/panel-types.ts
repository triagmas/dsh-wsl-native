/** Props shared by the panel components. */
import type { ClientContext, ClientModel, PanelApi } from './client-types.js';
import type { ConversationModel } from './conversation-model.js';

/** The panel model with the conversations sub-model attached. */
export type PanelModel = ClientModel & { conversations: ConversationModel };

/** Props every panel section receives. */
export interface PanelProps {
  api: PanelApi;
  ctx: ClientContext;
  model: PanelModel;
}

/** A panel section that only needs the model. */
export interface ModelProps {
  model: PanelModel;
}

/** Transient banner shown by the panel. */
export interface Notice {
  text: string;
  error?: boolean;
}

/** Linux environment draft edited in the panel. */
export interface EnvironmentDraft {
  [key: string]: unknown;
  distro: string;
  user: string;
  directory: string;
}
