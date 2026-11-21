/** Lo que responde `landinem-companion remote on|off|status` (`RemoteStatus` del acompañante). */
export type LandinemStatus = {
  mode: "local" | "remote";
  connected: boolean;
  title: string | null;
  reason?: "sign_in" | "no_mcp" | "no_session" | "unavailable" | "revoked";
  /** En remoto: espejos que esperan porque Landinem no contestaba. */
  pending?: number;
  /** En remoto: la declaración del monitor, que el mod pone en el prompt de sistema y en la respuesta al pasar a remoto. */
  declaration?: string;
};

declare module "claude-code" {
  interface PluginState {
    landinem: { status: LandinemStatus | null };
  }
}
